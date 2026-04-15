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
#      NOTE: forge-sdk and forge-dq are baked into the Spark image — no zip upload.
#            SDK changes require a Spark image rebuild via forge-up.sh Phase 5.
#   4. Commit + push DAG files → git (Airflow git-sync picks up within 30s)
#   5. Write deployment record → ADLS state container
#      - state/last_deploy_{env}.json  — last commit SHA (pointer for next run)
#      - state/deployments_{env}.jsonl — append-only deployment history
#
# Source of truth hierarchy:
#   .forge.ts manifest  →  everything (schema, schedule, DQ, resources)
#   .py business logic  →  the ONLY thing NOT re-generated from the manifest
#
# Incremental by default — only jobs whose .forge.ts changed since last deploy
# are re-scaffolded and uploaded. Use --full to force all jobs.
#
# Usage:
#   ./scripts/sync-jobs.sh                        # changed manifests only
#   ./scripts/sync-jobs.sh --full                 # all manifests
#   ./scripts/sync-jobs.sh --job nyc_taxi_silver  # one job only
#   ./scripts/sync-jobs.sh --dry-run              # preview, no changes
#   ./scripts/sync-jobs.sh --no-git-push          # skip DAG git push (CI handles it)
#
# Requirements:
#   - Node.js ≥ 20  (for forge generate via tsx)
#   - az CLI logged in (az login or workload identity)
#   - git configured with push access to origin
#   - FORGE_ENV and OWNER_ALIAS set (or FORGE_STORAGE_ACCOUNT explicit)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_ENTRY="${REPO_ROOT}/sdk/cli/src/index.ts"
EXAMPLES_DIR="${REPO_ROOT}/examples"
MANIFESTS_DIR="${EXAMPLES_DIR}/src/spark/jobs"
# DAGs live in examples/src — Airflow git-sync reads from the pipelines repo directly
GENERATED_DAGS_DIR="${EXAMPLES_DIR}/src/airflow/dags"
DQ_RULES_DIR="${EXAMPLES_DIR}/src/dq/rules"

FORGE_ENV="${FORGE_ENV:-dev}"
OWNER_ALIAS="${OWNER_ALIAS:-}"
STORAGE_ACCOUNT="${FORGE_STORAGE_ACCOUNT:-}"

if [[ -z "${STORAGE_ACCOUNT}" && -n "${OWNER_ALIAS}" ]]; then
  STORAGE_ACCOUNT="forgeadls${OWNER_ALIAS}${FORGE_ENV}"
fi

CODE_CONTAINER="code"
STATE_CONTAINER="state"
JOBS_BLOB_PREFIX="spark/jobs"
DQ_BLOB_PREFIX="dq/rules"
STATE_LAST_DEPLOY="last_deploy_${FORGE_ENV}.json"
STATE_DEPLOY_LOG="deployments_${FORGE_ENV}.jsonl"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
JOB_FILTER=""
DRY_RUN=false
FULL_DEPLOY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --job)           JOB_FILTER="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --full)          FULL_DEPLOY=true; shift ;;
    -h|--help)
      sed -n '/^# Usage:/,/^# Req/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

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

if ! command -v npx &>/dev/null; then
  echo "ERROR: npx not found — install Node.js ≥ 20" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1 — Determine last deployed commit + discover changed manifests
# ---------------------------------------------------------------------------
section "Determine scope"

CURRENT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
DEPLOY_ID="deploy-$(date -u +%Y%m%dT%H%M%SZ)-${CURRENT_COMMIT:0:8}"
log "Current commit : ${CURRENT_COMMIT}"
log "Deployment ID  : ${DEPLOY_ID}"
log "Environment    : ${FORGE_ENV}"

# Discover all manifests first
mapfile -t ALL_MANIFEST_FILES < <(find "${MANIFESTS_DIR}" -name "*.forge.ts" | sort)

if [[ ${#ALL_MANIFEST_FILES[@]} -eq 0 ]]; then
  warn "No .forge.ts manifests found in ${MANIFESTS_DIR}"
  exit 0
fi

MANIFEST_FILES=()

if [[ -n "${JOB_FILTER}" ]]; then
  # --job flag overrides everything — explicit single-job run
  for mf in "${ALL_MANIFEST_FILES[@]}"; do
    if [[ "$(basename "${mf}" .forge.ts)" == "${JOB_FILTER}" ]]; then
      MANIFEST_FILES+=("${mf}")
    fi
  done
  if [[ ${#MANIFEST_FILES[@]} -eq 0 ]]; then
    echo "ERROR: no manifest found for job '${JOB_FILTER}'" >&2
    exit 1
  fi
  log "Mode: single-job (--job ${JOB_FILTER})"

elif [[ "${FULL_DEPLOY}" == "true" ]]; then
  # --full flag: deploy everything regardless of what changed
  MANIFEST_FILES=("${ALL_MANIFEST_FILES[@]}")
  log "Mode: full deploy (--full)"

else
  # Incremental: only deploy manifests changed since last successful deployment
  LAST_COMMIT=""
  if ! dry; then
    LAST_STATE="$(download_blob_text "${STATE_LAST_DEPLOY}")"
    if [[ -n "${LAST_STATE}" ]]; then
      LAST_COMMIT="$(printf '%s' "${LAST_STATE}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('commit',''))" 2>/dev/null || true)"
    fi
  fi

  if [[ -z "${LAST_COMMIT}" ]]; then
    log "Mode: first run (no prior deployment state found) — deploying all manifests"
    MANIFEST_FILES=("${ALL_MANIFEST_FILES[@]}")
  else
    log "Mode: incremental (last deployed commit: ${LAST_COMMIT:0:8})"
    # Find .forge.ts files that changed between last deployed commit and HEAD
    mapfile -t CHANGED_FORGE < <(
      git -C "${REPO_ROOT}" diff --name-only "${LAST_COMMIT}...${CURRENT_COMMIT}" \
        -- "Forge/examples/src/spark/jobs/*.forge.ts" 2>/dev/null \
      | xargs -I{} basename {} .forge.ts 2>/dev/null \
      | sort -u
    )

    if [[ ${#CHANGED_FORGE[@]} -eq 0 ]]; then
      log "No .forge.ts files changed since last deployment — nothing to do"
      log "Use --full to force all, or --job <name> to target one job"
      exit 0
    fi

    log "Changed manifests since ${LAST_COMMIT:0:8}:"
    for name in "${CHANGED_FORGE[@]}"; do
      log "  - ${name}"
    done

    for mf in "${ALL_MANIFEST_FILES[@]}"; do
      job_name="$(basename "${mf}" .forge.ts)"
      for changed in "${CHANGED_FORGE[@]}"; do
        if [[ "${job_name}" == "${changed}" ]]; then
          MANIFEST_FILES+=("${mf}")
          break
        fi
      done
    done
  fi
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

GENERATED_PY=()
GENERATED_DQ=()

for manifest in "${MANIFEST_FILES[@]}"; do
  job_name="$(basename "${manifest}" .forge.ts)"
  log "→ ${job_name}"

  if dry; then
    log "  [dry-run] would run: npx tsx ${CLI_ENTRY} generate --job ${job_name} --manifest-dir ${MANIFESTS_DIR} --dir ${EXAMPLES_DIR}"
    GENERATED_PY+=("${MANIFESTS_DIR}/${job_name}.py")
    GENERATED_DQ+=("${DQ_RULES_DIR}/${job_name}.yaml")
  else
    npx tsx "${CLI_ENTRY}" generate \
      --job "${job_name}" \
      --manifest-dir "${MANIFESTS_DIR}" \
      --dir "${EXAMPLES_DIR}" \
      2>&1 | sed "s/^/    /"

    py_file="${MANIFESTS_DIR}/${job_name}.py"
    dq_file="${DQ_RULES_DIR}/${job_name}.yaml"
    [[ -f "${py_file}" ]] && GENERATED_PY+=("${py_file}")
    [[ -f "${dq_file}" ]] && GENERATED_DQ+=("${dq_file}")
  fi
done

# DAGs live in examples/src/airflow/dags/ — Airflow git-sync reads from the
# pipelines repo directly. No copy step needed.

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

# Step 6 — DAG push handled by pipelines repo CI (Airflow git-sync reads that repo directly)
DAG_PUSH_DONE=false

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
  "mode": "$( [[ -n "${JOB_FILTER}" ]] && echo "single-job" || ([[ "${FULL_DEPLOY}" == "true" ]] && echo "full" || echo "incremental"))"
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
log "  Jobs regenerated : ${#GENERATED_PY[@]}"
log "  ADLS uploads     : $((${#GENERATED_PY[@]} + ${#GENERATED_DQ[@]}))"
log "  SDK in image     : forge-sdk + forge-dq (rebuilt via forge-up.sh when changed)"
log "  Storage account  : ${STORAGE_ACCOUNT}"
log "  Environment      : ${FORGE_ENV}"
if [[ "${DRY_RUN}" == "true" ]]; then
  log "  *** DRY RUN — no changes made ***"
fi
log "══════════════════════════════════════════════"
