#!/usr/bin/env bash
# =============================================================================
# sync-jobs.sh — Scaffold from TypeScript manifests and deploy to Airflow/ADLS
#
# Full pipeline:
#   1. Determine scope — git diff since last deploy (incremental) or all (--full)
#   2. forge generate  — re-scaffold Python job, DAG, DQ YAML from .forge.ts
#                        Business logic blocks are ALWAYS preserved
#      Copy DAGs: examples/src/airflow/dags/ → orchestration/airflow/dags/
#   3. Upload Spark .py     → ADLS code/spark/jobs/
#      Upload DQ .yaml      → ADLS code/dq/rules/
#      Upload DAG .py       → ADLS code/dags/          (durable — survives pod restarts)
#      NOTE: forge-sdk and forge-dq are baked into the Spark image — no zip upload.
#            SDK changes require a Spark image rebuild via forge-up.sh Phase 5.
#   4. Pull DAG into running dag-processor pod via kubectl exec + Python ADLS download
#      On pod restart, the dag-restore init container (values.yaml) restores all DAGs
#      from ADLS automatically.
#   5. Write deployment record → ADLS state container
#      - state/last_deploy_{env}.json  — last commit SHA (pointer for next run)
#      - state/deployments_{env}.jsonl — append-only deployment history
#
# Source of truth hierarchy:
#   .forge.ts manifest  →  everything (schema, schedule, DQ, resources)
#   .py business logic  →  the ONLY thing NOT re-generated from the manifest
#
# Always deploys a single named job. Bulk sync is intentionally not supported —
# every deploy must be explicit and traceable to a single manifest.
#
# Usage:
#   ./scripts/sync-jobs.sh --job nyc_taxi_bronze  # deploy one job
#   ./scripts/sync-jobs.sh --job nyc_taxi_silver --dry-run  # preview, no changes
#
# --job is REQUIRED. There is no full/bulk sync mode by design.
#
# Requirements:
#   - Node.js ≥ 20  (for forge generate via tsx)
#   - az CLI logged in (az login or workload identity)
#   - git configured with push access to origin
#   - FORGE_ENV and OWNER_ALIAS set (or FORGE_STORAGE_ACCOUNT explicit)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_ENTRY="${REPO_ROOT}/sdk/cli/src/index.ts"

FORGE_ENV="${FORGE_ENV:-dev}"
OWNER_ALIAS="${OWNER_ALIAS:-}"
STORAGE_ACCOUNT="${FORGE_STORAGE_ACCOUNT:-}"
DATA_REPO=""

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
JOB_FILTER=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --job)           JOB_FILTER="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --data-repo)     DATA_REPO="$2"; shift 2 ;;
    --full)
      echo "ERROR: --full is not supported. sync-jobs.sh always deploys a single job." >&2
      echo "       Use: sync-jobs.sh --job <dag_name>" >&2
      exit 1
      ;;
    -h|--help)
      sed -n '/^# Usage:/,/^# Req/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# --job is mandatory — no bulk sync by design
if [[ -z "${JOB_FILTER}" ]]; then
  echo "ERROR: --job <dag_name> is required. Bulk sync is not supported." >&2
  echo "       Example: sync-jobs.sh --job nyc_taxi_bronze" >&2
  exit 1
fi

# Resolve data repo — flag > env var > sibling DSEngCoreData folder (Windows-aware)
if [[ -z "$DATA_REPO" ]]; then
  _SIBLING_CANDIDATES=(
    "${REPO_ROOT}/../DSEngCoreData"
    "$(dirname "$(pwd)")/../DSEngCoreData"
    "/d/Repos/DSEngCoreData"
    "/c/Repos/DSEngCoreData"
  )
  for _candidate in "${_SIBLING_CANDIDATES[@]}"; do
    if [[ -d "${_candidate}" ]]; then
      DATA_REPO="$(cd "${_candidate}" && pwd)"
      break
    fi
  done
  DATA_REPO="${FORGE_DATA_REPO:-${DATA_REPO}}"
fi
if [[ -z "$DATA_REPO" || ! -d "$DATA_REPO" ]]; then
  echo "ERROR: data repo not found — pass --data-repo <path> or set FORGE_DATA_REPO" >&2
  exit 1
fi

# Manifests live under sources/dev/CoreData/src/ (recurse to find all manifests/ subfolders)
DATA_SRC="${DATA_REPO}/sources/dev/CoreData/src"

if [[ -z "${STORAGE_ACCOUNT}" && -n "${OWNER_ALIAS}" ]]; then
  STORAGE_ACCOUNT="forgeadls$(echo "${OWNER_ALIAS}${FORGE_ENV}" | tr '[:upper:]' '[:lower:]')"
fi

CODE_CONTAINER="code"
STATE_CONTAINER="state"
JOBS_BLOB_PREFIX="spark/jobs"
DQ_BLOB_PREFIX="dq/rules"
STATE_LAST_DEPLOY="last_deploy_${FORGE_ENV}.json"
STATE_DEPLOY_LOG="deployments_${FORGE_ENV}.jsonl"

# Portal URL for DAG ownership registration + DAG limit checks.
# Derives the same DNS label pattern as forge-up.sh: forge-portal-{alias}-{env}
_ALIAS_LC="$(echo "${OWNER_ALIAS}" | tr '[:upper:]' '[:lower:]')"
_ALIAS_PREFIX="${_ALIAS_LC:+${_ALIAS_LC}-}"
_PORTAL_URL="${FORGE_PORTAL_URL:-https://forge-portal-${_ALIAS_PREFIX}${FORGE_ENV}.northcentralus.cloudapp.azure.com}"

# MS Graph Bearer token (acquired once, reused across calls)
_BEARER_TOKEN=""
_acquire_bearer_token() {
  if [[ -z "${_BEARER_TOKEN}" ]]; then
    _BEARER_TOKEN="$(az account get-access-token \
      --resource https://graph.microsoft.com \
      --query accessToken -o tsv 2>/dev/null || true)"
  fi
}

# Derive the signed-in user's alias (UPN prefix, e.g. prproddu@tenant.com → prproddu)
_get_user_alias() {
  local upn
  upn="$(az account show --query 'user.name' -o tsv 2>/dev/null || true)"
  if [[ -n "${upn}" ]]; then
    echo "${upn%%@*}"
  else
    echo ""
  fi
}

# Register a deployed DAG with the portal (non-fatal — warns and continues if unreachable)
_register_dag() {
  local dag_id="$1"
  _acquire_bearer_token
  if [[ -z "${_BEARER_TOKEN}" ]]; then
    warn "  Could not acquire Bearer token — skipping portal registration for ${dag_id}"
    return 0
  fi
  # Use the actual signed-in user's alias, not the env alias
  local user_alias
  user_alias="$(_get_user_alias)"
  local _resp
  _resp="$(curl -sf -X POST "${_PORTAL_URL}/api/pipelines/register" \
    -H "Authorization: Bearer ${_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"dag_id\":\"${dag_id}\",\"owner_alias\":\"${user_alias}\"}" \
    --max-time 10 2>/dev/null || true)"
  if [[ -n "${_resp}" ]]; then
    log "  ✓ Registered ${dag_id} in portal"
  else
    warn "  Portal registration failed for ${dag_id} (non-fatal — portal may not be reachable)"
  fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()     { echo "[sync-jobs] $*"; }
warn()    { echo "[sync-jobs] WARN: $*" >&2; }
section() { echo ""; echo "[sync-jobs] ══ $* ══"; }
dry()     { [[ "${DRY_RUN}" == "true" ]]; }

run() {
  if dry; then
    log "  [dry-run] would run: $*"
  else
    "$@"
  fi
}

upload_blob() {
  local src="$1"
  local blob_name="$2"
  local container="${3:-${CODE_CONTAINER}}"
  if dry; then
    log "  [dry-run] upload → ${container}/${blob_name}"
    return 0
  fi
  az storage blob upload \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${container}" \
    --name "${blob_name}" \
    --file "${src}" \
    --overwrite \
    --auth-mode login \
    --output none
  log "  ✓ $(basename "${src}") → ${container}/${blob_name}"
}

download_blob_text() {
  # Download blob content to stdout; returns empty string if blob doesn't exist
  local blob_name="$1"
  local container="${2:-${STATE_CONTAINER}}"
  az storage blob download \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${container}" \
    --name "${blob_name}" \
    --file /dev/stdout \
    --auth-mode login \
    --output none \
    2>/dev/null || true
}

upload_blob_text() {
  # Upload inline text as a blob
  local content="$1"
  local blob_name="$2"
  local container="${3:-${STATE_CONTAINER}}"
  if dry; then
    log "  [dry-run] write state → ${container}/${blob_name}"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  printf '%s' "${content}" > "${tmp}"
  az storage blob upload \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${container}" \
    --name "${blob_name}" \
    --file "${tmp}" \
    --overwrite \
    --auth-mode login \
    --output none
  rm -f "${tmp}"
}

append_blob_text() {
  # Append a line to an existing blob (download + prepend-append workaround — ADLS doesn't support append on block blobs)
  local line="$1"
  local blob_name="$2"
  local container="${3:-${STATE_CONTAINER}}"
  if dry; then
    log "  [dry-run] append to ${container}/${blob_name}"
    return 0
  fi
  local existing
  existing="$(download_blob_text "${blob_name}" "${container}")"
  local updated
  if [[ -n "${existing}" ]]; then
    updated="${existing}"$'\n'"${line}"
  else
    updated="${line}"
  fi
  upload_blob_text "${updated}" "${blob_name}" "${container}"
}

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [[ -z "${STORAGE_ACCOUNT}" ]]; then
  echo "ERROR: set FORGE_STORAGE_ACCOUNT or OWNER_ALIAS" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Temporarily open ADLS firewall for uploads, close on exit
# ---------------------------------------------------------------------------
_ADLS_OPENED=false
_close_adls() {
  if [[ "${_ADLS_OPENED}" == "true" && -n "${MY_IP:-}" ]]; then
    log "Removing ADLS firewall rule for ${MY_IP}..."
    az storage account network-rule remove \
      --account-name "${STORAGE_ACCOUNT}" \
      --ip-address "${MY_IP}" \
      --output none 2>/dev/null || true
    log "ADLS firewall restored."
  fi
}
trap _close_adls EXIT

if ! dry; then
  MY_IP="$(curl -sf https://api.ipify.org || curl -sf https://ifconfig.me || echo "")"
  if [[ -n "${MY_IP}" ]]; then
    log "Opening ADLS firewall for ${MY_IP}..."
    az storage account network-rule add \
      --account-name "${STORAGE_ACCOUNT}" \
      --ip-address "${MY_IP}" \
      --output none 2>/dev/null || true
    _ADLS_OPENED=true
    sleep 5  # allow rule to propagate
  else
    log "WARN: could not detect public IP — uploads may fail if storage firewall is active"
  fi
fi

# Ensure required containers exist (idempotent)
if ! dry; then
  for _c in "${CODE_CONTAINER}" "${STATE_CONTAINER}"; do
    az storage container create \
      --account-name "${STORAGE_ACCOUNT}" \
      --name "${_c}" \
      --auth-mode login \
      --output none 2>/dev/null || true
  done
fi

if ! command -v npx &>/dev/null; then
  echo "ERROR: npx not found — install Node.js ≥ 20" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1 — Determine last deployed commit + discover changed manifests
# ---------------------------------------------------------------------------
section "Determine scope"

CURRENT_COMMIT="$(git -C "${DATA_REPO}" rev-parse HEAD)"
DEPLOY_ID="deploy-$(date -u +%Y%m%dT%H%M%SZ)-${CURRENT_COMMIT:0:8}"
log "Current commit : ${CURRENT_COMMIT}"
log "Deployment ID  : ${DEPLOY_ID}"
log "Environment    : ${FORGE_ENV}"
log "Data repo      : ${DATA_REPO}"

# Discover all manifests recursively under sources/dev/CoreData/src/
# Structure: {project}/manifests/*.forge.ts
mapfile -t ALL_MANIFEST_FILES < <(find "${DATA_SRC}" -path "*/manifests/*.forge.ts" | sort)

if [[ ${#ALL_MANIFEST_FILES[@]} -eq 0 ]]; then
  warn "No .forge.ts manifests found under ${DATA_SRC}"
  exit 0
fi

MANIFEST_FILES=()

if [[ -n "${JOB_FILTER}" ]]; then
  for mf in "${ALL_MANIFEST_FILES[@]}"; do
    if [[ "$(basename "${mf}" .forge.ts)" == "${JOB_FILTER}" ]]; then
      MANIFEST_FILES+=("${mf}")
    fi
  done
  if [[ ${#MANIFEST_FILES[@]} -eq 0 ]]; then
    echo "ERROR: no manifest found for job '${JOB_FILTER}'" >&2
    exit 1
  fi
  log "Deploying single job: ${JOB_FILTER}"
fi

log "Manifests to process: ${#MANIFEST_FILES[@]}"
for mf in "${MANIFEST_FILES[@]}"; do
  log "  - $(basename "${mf}")"
done

# ---------------------------------------------------------------------------
# Step 2 — forge generate (regenerate Python, DAG, DQ YAML)
# ---------------------------------------------------------------------------
section "forge generate — scaffold from TypeScript manifests"
log "Source of truth: .forge.ts manifest"
log "Preserved:       business logic block in .py (only user-editable region)"
log ""

# Ensure @forge/cli resolves from the infra repo without requiring a publish step.
# Manifests import { defineJob } from "@forge/cli/schema" — symlink makes Node find it.
_FORGE_MODULES="${DATA_REPO}/sources/dev/CoreData/node_modules/@forge"
mkdir -p "${_FORGE_MODULES}"
ln -sf "${REPO_ROOT}/sdk/cli" "${_FORGE_MODULES}/cli" 2>/dev/null || true

GENERATED_PY=()
GENERATED_DQ=()

for manifest in "${MANIFEST_FILES[@]}"; do
  job_name="$(basename "${manifest}" .forge.ts)"
  # Project dir is two levels up from the manifest: {project}/manifests/{name}.forge.ts
  project_dir="$(dirname "$(dirname "${manifest}")")"
  log "→ ${job_name} ($(basename "${project_dir}"))"

  if dry; then
    log "  [dry-run] would run: forge generate --job ${job_name} --manifest-dir ${project_dir}/manifests --dir ${project_dir}"
    GENERATED_PY+=("${project_dir}/jobs/${job_name}.py")
    GENERATED_DQ+=("${project_dir}/dq/${job_name}.yaml")
  else
    npx tsx "${CLI_ENTRY}" generate \
      --job "${job_name}" \
      --manifest-dir "${project_dir}/manifests" \
      --dir "${project_dir}" \
      2>&1 | sed "s/^/    /"

    py_file="${project_dir}/jobs/${job_name}.py"
    dq_file="${project_dir}/dq/${job_name}.yaml"
    [[ -f "${py_file}" ]] && GENERATED_PY+=("${py_file}")
    [[ -f "${dq_file}" ]] && GENERATED_DQ+=("${dq_file}")
  fi
done

# DAGs live in {project}/dags/ — Airflow git-sync reads from DSEngCoreData directly.

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Step 3 — Upload Spark jobs to ADLS
# NOTE: forge-sdk and forge-dq are baked into the Spark Docker image at build
# time (see infra/docker/spark/Dockerfile). There is no forge_lib.zip.
# SDK changes require a Spark image rebuild (forge-up.sh Phase 5), not a
# sync-jobs.sh run. For prod: publish versioned wheels to Azure Artifacts
# via sdk/python/publish.sh and pin the version in the Dockerfile.
# ---------------------------------------------------------------------------
section "Upload Spark jobs → ADLS ${CODE_CONTAINER}/${JOBS_BLOB_PREFIX}/"

if [[ ${#GENERATED_PY[@]} -eq 0 ]]; then
  log "  Nothing to upload"
else
  for pyfile in "${GENERATED_PY[@]}"; do
    [[ -f "${pyfile}" ]] || { warn "  missing: ${pyfile}"; continue; }
    upload_blob "${pyfile}" "${JOBS_BLOB_PREFIX}/$(basename "${pyfile}")"
  done
fi

# ---------------------------------------------------------------------------
# Step 5 — Upload DQ rules to ADLS
# ---------------------------------------------------------------------------
section "Upload DQ rules → ADLS ${CODE_CONTAINER}/${DQ_BLOB_PREFIX}/"

if [[ ${#GENERATED_DQ[@]} -eq 0 ]]; then
  log "  Nothing to upload"
else
  for yamlfile in "${GENERATED_DQ[@]}"; do
    [[ -f "${yamlfile}" ]] || { warn "  missing: ${yamlfile}"; continue; }
    upload_blob "${yamlfile}" "${DQ_BLOB_PREFIX}/$(basename "${yamlfile}")"
  done
fi

# ---------------------------------------------------------------------------
# Step 6 — Upload DAGs to ADLS and pull into the running dag-processor pod
#
# DAG delivery model (dev):
#   1. Upload DAG .py → ADLS code/dags/  (durable — survives pod restarts)
#   2. kubectl exec Python one-liner → pulls the DAG from ADLS into
#      /opt/airflow/dags/ inside the running dag-processor pod (immediate)
#
# On pod restart, the dag-restore init container (values.yaml extraInitContainers)
# downloads all code/dags/*.py from ADLS automatically — no manual sync needed.
#
# Prod: git-sync delivers DAGs from DSEngCoreData main branch.
# ---------------------------------------------------------------------------
section "Upload DAGs → ADLS + pull into dag-processor"
DAG_PUSH_DONE=false
DAG_BLOB_PREFIX="dags"

if ! dry; then
  _AIRFLOW_NS="airflow"
  _KUBE_CTX="${ORCH_CLUSTER:-$(kubectl config current-context 2>/dev/null || true)}"
  _DAG_PROCESSOR_POD=$(kubectl get pods -n "${_AIRFLOW_NS}" \
    --context "${_KUBE_CTX}" \
    -l component=dag-processor \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

  if [[ -z "${_DAG_PROCESSOR_POD}" ]]; then
    warn "Airflow dag-processor pod not found — DAG uploaded to ADLS but not pulled into pod."
    warn "The dag-restore init container will pick it up on next pod restart."
  else
    log "DAG processor pod: ${_DAG_PROCESSOR_POD} (context: ${_KUBE_CTX})"
  fi

  # -----------------------------------------------------------------------
  # Dev DAG limit: max 5 DAGs per user.
  # Primary: query the portal API for this user's registered DAG count.
  # Fallback: count .py blobs in ADLS code/dags/ (shared count, conservative).
  # -----------------------------------------------------------------------
  _MAX_DAGS=5
  _acquire_bearer_token
  _MY_DAG_IDS=()
  _MINE_COUNT=0
  _PORTAL_REACHABLE=false
  if [[ -n "${_BEARER_TOKEN}" ]]; then
    _MINE_RESP="$(curl -sf "${_PORTAL_URL}/api/pipelines/mine" \
      -H "Authorization: Bearer ${_BEARER_TOKEN}" \
      --max-time 10 2>/dev/null || true)"
    if [[ -n "${_MINE_RESP}" ]]; then
      _PORTAL_REACHABLE=true
      mapfile -t _MY_DAG_IDS < <(
        echo "${_MINE_RESP}" | python3 -c "import sys,json; [print(x) for x in json.load(sys.stdin)]" 2>/dev/null || true
      )
      _MINE_COUNT=${#_MY_DAG_IDS[@]}
      log "  Portal DAG count: ${_MINE_COUNT} DAGs owned by you"
    fi
  fi

  if [[ "${_PORTAL_REACHABLE}" == "false" ]]; then
    warn "  Portal unreachable — falling back to ADLS DAG blob count"
    mapfile -t _MY_DAG_IDS < <(
      az storage blob list \
        --account-name "${STORAGE_ACCOUNT}" \
        --container-name "${CODE_CONTAINER}" \
        --prefix "${DAG_BLOB_PREFIX}/" \
        --auth-mode login \
        --query "[].name" -o tsv 2>/dev/null \
        | xargs -I{} basename {} .py 2>/dev/null || true
    )
    _MINE_COUNT=${#_MY_DAG_IDS[@]}
    log "  ADLS DAG blob count (fallback): ${_MINE_COUNT}"
  fi

  _NEW_DAG_NAMES=()
  for _m in "${MANIFEST_FILES[@]}"; do
    _jn="$(basename "${_m}" .forge.ts)"
    _found=false
    for _ex in "${_MY_DAG_IDS[@]}"; do
      [[ "${_ex}" == "${_jn}_dag" || "${_ex}" == "${_jn}" ]] && _found=true && break
    done
    [[ "${_found}" == "false" ]] && _NEW_DAG_NAMES+=("${_jn}_dag.py")
  done

  _PROJECTED=$(( _MINE_COUNT + ${#_NEW_DAG_NAMES[@]} ))
  if [[ ${_PROJECTED} -gt ${_MAX_DAGS} ]]; then
    echo "" >&2
    echo "ERROR: dev DAG limit would be exceeded." >&2
    echo "  Your DAGs : ${_MINE_COUNT} / ${_MAX_DAGS}" >&2
    echo "  New DAGs  : ${#_NEW_DAG_NAMES[@]}" >&2
    echo "  Projected : ${_PROJECTED} (limit: ${_MAX_DAGS})" >&2
    if [[ ${_MINE_COUNT} -gt 0 ]]; then
      echo "" >&2
      echo "  Your registered DAGs:" >&2
      for _d in "${_MY_DAG_IDS[@]}"; do echo "    - ${_d}" >&2; done
      echo "" >&2
      echo "  Remove a DAG before adding more:" >&2
      echo "    az storage blob delete --account-name ${STORAGE_ACCOUNT} --container-name code" >&2
      echo "      --name dags/<name>_dag.py --auth-mode login" >&2
    fi
    echo "" >&2
    exit 1
  fi
  log "  DAG slot check: ${_MINE_COUNT} existing + ${#_NEW_DAG_NAMES[@]} new = ${_PROJECTED} / ${_MAX_DAGS}"

  for manifest in "${MANIFEST_FILES[@]}"; do
    job_name="$(basename "${manifest}" .forge.ts)"
    project_dir="$(dirname "$(dirname "${manifest}")")"
    dag_file="${project_dir}/dags/${job_name}_dag.py"
    if [[ ! -f "${dag_file}" ]]; then
      warn "  DAG file not found (run forge generate first): ${dag_file}"
      continue
    fi
    _dag_name="${job_name}_dag.py"
    _dag_blob="${DAG_BLOB_PREFIX}/${_dag_name}"

    # 1. Upload to ADLS — durable, survives pod restarts
    upload_blob "${dag_file}" "${_dag_blob}"

    # 2. Pull into running dag-processor pod — immediate (no restart needed)
    if [[ -n "${_DAG_PROCESSOR_POD}" ]]; then
      _pull_script="$(cat <<PYEOF
import os
from azure.storage.blob import BlobServiceClient
from azure.identity import DefaultAzureCredential
cred = DefaultAzureCredential()
client = BlobServiceClient(account_url="https://${STORAGE_ACCOUNT}.blob.core.windows.net", credential=cred)
data = client.get_blob_client("${CODE_CONTAINER}", "${_dag_blob}").download_blob().readall()
os.makedirs("/opt/airflow/dags", exist_ok=True)
open("/opt/airflow/dags/${_dag_name}", "wb").write(data)
print("pulled: ${_dag_name}", flush=True)
PYEOF
)"
      if kubectl exec "${_DAG_PROCESSOR_POD}" \
          -n "${_AIRFLOW_NS}" --context "${_KUBE_CTX}" \
          -c dag-processor \
          -- python3 -c "${_pull_script}" 2>&1; then
        log "  ✓ ${_dag_name} → dag-processor /opt/airflow/dags/ (pulled from ADLS)"
      else
        warn "  ADLS pull failed for ${_dag_name} — DAG is in ADLS; restart pod to apply"
      fi
    fi

    _register_dag "${job_name}"
  done
  DAG_PUSH_DONE=true
  log "  DAGs uploaded to ADLS — dag-processor rescans every 30s; init container restores on restart"
else
  log "  [dry-run] would upload ${#MANIFEST_FILES[@]} DAG(s) to ADLS ${CODE_CONTAINER}/${DAG_BLOB_PREFIX}/"
  for manifest in "${MANIFEST_FILES[@]}"; do
    job_name="$(basename "${manifest}" .forge.ts)"
    log "  [dry-run] would pull ${job_name}_dag.py into dag-processor + register in portal"
  done
fi

# ---------------------------------------------------------------------------
# Step 7 — Write deployment state to ADLS
# ---------------------------------------------------------------------------
section "Record deployment state → ADLS ${STATE_CONTAINER}/"

DEPLOYED_JOBS="$(printf '%s\n' "${MANIFEST_FILES[@]}" | xargs -I{} basename {} .forge.ts | sort | tr '\n' ',' | sed 's/,$//')"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# last_deploy_{env}.json — overwritten each time (pointer to latest)
LAST_DEPLOY_JSON="$(cat <<EOF
{
  "deploy_id": "${DEPLOY_ID}",
  "commit": "${CURRENT_COMMIT}",
  "deployed_at": "${NOW_ISO}",
  "env": "${FORGE_ENV}",
  "jobs_deployed": [$(printf '%s\n' "${MANIFEST_FILES[@]}" | xargs -I{} basename {} .forge.ts | sort | awk '{printf "\"%s\",", $0}' | sed 's/,$//')],
  "storage_account": "${STORAGE_ACCOUNT}",
  "mode": "single-job"
}
EOF
)"
upload_blob_text "${LAST_DEPLOY_JSON}" "${STATE_LAST_DEPLOY}"
log "  ✓ Updated last_deploy_${FORGE_ENV}.json (commit: ${CURRENT_COMMIT:0:8})"

# deployments_{env}.jsonl — append-only history
DEPLOY_LOG_LINE="{\"deploy_id\":\"${DEPLOY_ID}\",\"commit\":\"${CURRENT_COMMIT}\",\"deployed_at\":\"${NOW_ISO}\",\"env\":\"${FORGE_ENV}\",\"jobs\":\"${DEPLOYED_JOBS}\",\"dag_push\":${DAG_PUSH_DONE},\"dry_run\":${DRY_RUN}}"
append_blob_text "${DEPLOY_LOG_LINE}" "${STATE_DEPLOY_LOG}"
log "  ✓ Appended to deployments_${FORGE_ENV}.jsonl"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
log "══════════════════════════════════════════════"
log "  Deployment ID    : ${DEPLOY_ID}"
log "  Commit           : ${CURRENT_COMMIT:0:12}"
log "  Data repo        : ${DATA_REPO}"
log "  Jobs regenerated : ${#GENERATED_PY[@]}"
log "  ADLS uploads     : $((${#GENERATED_PY[@]} + ${#GENERATED_DQ[@]} + ${#MANIFEST_FILES[@]}))"
log "    Spark jobs     : code/spark/jobs/"
log "    DQ rules       : code/dq/rules/"
log "    DAGs           : code/dags/"
log "  SDK in image     : forge-sdk + forge-dq (rebuilt via forge-up.sh when changed)"
log "  Storage account  : ${STORAGE_ACCOUNT}"
log "  Environment      : ${FORGE_ENV}"
if [[ "${DRY_RUN}" == "true" ]]; then
  log "  *** DRY RUN — no changes made ***"
fi
log "══════════════════════════════════════════════"
