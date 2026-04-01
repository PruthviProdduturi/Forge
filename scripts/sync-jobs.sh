#!/usr/bin/env bash
# =============================================================================
# sync-jobs.sh — Scaffold from TypeScript manifests and deploy to Airflow/ADLS
#
# Full pipeline:
#   1. Discover .forge.ts manifests
#   2. Run `forge generate` — regenerates Python job, DAG, DQ YAML
#      Business logic blocks are ALWAYS preserved (forge CLI handles this)
#   3. Upload Spark .py jobs    → ADLS code container (spark/jobs/)
#   4. Upload DQ .yaml rules    → ADLS code container (dq/rules/)
#   5. Commit + push DAG files  → git, Airflow git-sync picks up within 30s
#
# Source of truth is ALWAYS the .forge.ts manifest.
# Never edit the generated .py files outside the BUSINESS LOGIC block.
#
# Usage:
#   ./scripts/sync-jobs.sh                        # all manifests
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
MANIFESTS_DIR="${REPO_ROOT}/examples/src/spark/jobs"
DAGS_DIR="${REPO_ROOT}/orchestration/airflow/dags"
DQ_RULES_DIR="${REPO_ROOT}/examples/orchestration/dq/rules"

FORGE_ENV="${FORGE_ENV:-dev}"
OWNER_ALIAS="${OWNER_ALIAS:-}"
STORAGE_ACCOUNT="${FORGE_STORAGE_ACCOUNT:-}"

if [[ -z "${STORAGE_ACCOUNT}" && -n "${OWNER_ALIAS}" ]]; then
  STORAGE_ACCOUNT="forgeadls${OWNER_ALIAS}${FORGE_ENV}"
fi

CODE_CONTAINER="code"
JOBS_BLOB_PREFIX="spark/jobs"
DQ_BLOB_PREFIX="dq/rules"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
JOB_FILTER=""
DRY_RUN=false
NO_GIT_PUSH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --job)           JOB_FILTER="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --no-git-push)   NO_GIT_PUSH=true; shift ;;
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
  if dry; then
    log "  [dry-run] upload → ${CODE_CONTAINER}/${blob_name}"
    return 0
  fi
  az storage blob upload \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${CODE_CONTAINER}" \
    --name "${blob_name}" \
    --file "${src}" \
    --overwrite \
    --auth-mode login \
    --output none
  log "  ✓ $(basename "${src}") → ${CODE_CONTAINER}/${blob_name}"
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
# Step 1 — Discover manifests
# ---------------------------------------------------------------------------
section "Discover manifests"

mapfile -t MANIFEST_FILES < <(find "${MANIFESTS_DIR}" -name "*.forge.ts" | sort)

if [[ ${#MANIFEST_FILES[@]} -eq 0 ]]; then
  warn "No .forge.ts manifests found in ${MANIFESTS_DIR}"
  exit 0
fi

# Apply --job filter
if [[ -n "${JOB_FILTER}" ]]; then
  FILTERED=()
  for mf in "${MANIFEST_FILES[@]}"; do
    if [[ "$(basename "${mf}" .forge.ts)" == "${JOB_FILTER}" ]]; then
      FILTERED+=("${mf}")
    fi
  done
  if [[ ${#FILTERED[@]} -eq 0 ]]; then
    echo "ERROR: no manifest found for job '${JOB_FILTER}'" >&2
    exit 1
  fi
  MANIFEST_FILES=("${FILTERED[@]}")
fi

log "Manifests to process: ${#MANIFEST_FILES[@]}"
for mf in "${MANIFEST_FILES[@]}"; do
  log "  - $(basename "${mf}")"
done

# ---------------------------------------------------------------------------
# Step 2 — forge generate (regenerate Python, DAG, DQ YAML)
# ---------------------------------------------------------------------------
section "forge generate — scaffold from TypeScript manifests"
log "Business logic blocks are preserved automatically"
log ""

GENERATED_PY=()
GENERATED_DAGS=()
GENERATED_DQ=()

for manifest in "${MANIFEST_FILES[@]}"; do
  job_name="$(basename "${manifest}" .forge.ts)"
  log "→ ${job_name}"

  if dry; then
    log "  [dry-run] would run: npx tsx ${CLI_ENTRY} generate --job ${job_name} --dir ${MANIFESTS_DIR}"
    GENERATED_PY+=("${MANIFESTS_DIR}/${job_name}.py")
    GENERATED_DQ+=("${DQ_RULES_DIR}/${job_name}.yaml")
  else
    # Run forge generate — writes .py and _dag.py into MANIFESTS_DIR,
    # and DAG into orchestration/airflow/dags/{folder}/
    npx tsx "${CLI_ENTRY}" generate \
      --job "${job_name}" \
      --dir "${MANIFESTS_DIR}" \
      2>&1 | sed "s/^/    /"

    # Collect generated outputs
    py_file="${MANIFESTS_DIR}/${job_name}.py"
    dq_file="${DQ_RULES_DIR}/${job_name}.yaml"
    [[ -f "${py_file}" ]] && GENERATED_PY+=("${py_file}")
    [[ -f "${dq_file}" ]] && GENERATED_DQ+=("${dq_file}")
  fi
done

# Collect generated DAG files (forge generate writes these to DAGS_DIR)
if ! dry; then
  mapfile -t GENERATED_DAGS < <(
    git -C "${REPO_ROOT}" diff --name-only HEAD -- "${DAGS_DIR}" 2>/dev/null
    git -C "${REPO_ROOT}" ls-files --others --exclude-standard -- "${DAGS_DIR}" 2>/dev/null
  )
fi

# ---------------------------------------------------------------------------
# Step 3 — Upload Spark jobs to ADLS
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
# Step 4 — Upload DQ rules to ADLS
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
# Step 5 — Commit + push DAG files so Airflow git-sync picks them up
# ---------------------------------------------------------------------------
section "Push DAG files → git (Airflow git-sync polls every 30s)"

if [[ "${NO_GIT_PUSH}" == "true" ]]; then
  log "  --no-git-push set — skipping (CI pipeline handles git push)"
elif dry; then
  log "  [dry-run] would git add + commit + push DAG changes"
else
  # Stage any changed/new DAG files
  CHANGED_DAGS=()
  while IFS= read -r -d '' dagfile; do
    if git -C "${REPO_ROOT}" diff --quiet HEAD -- "${dagfile}" 2>/dev/null && \
       ! git -C "${REPO_ROOT}" ls-files --others --exclude-standard -- "${dagfile}" | grep -q .; then
      : # unchanged
    else
      CHANGED_DAGS+=("${dagfile}")
    fi
  done < <(find "${DAGS_DIR}" -name "*.py" -print0)

  if [[ ${#CHANGED_DAGS[@]} -eq 0 ]]; then
    log "  DAG files unchanged — nothing to push"
  else
    log "  Staging ${#CHANGED_DAGS[@]} changed DAG file(s):"
    for f in "${CHANGED_DAGS[@]}"; do
      log "    + $(basename "${f}")"
      git -C "${REPO_ROOT}" add "${f}"
    done

    BRANCH="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)"
    COMMIT_MSG="chore(dags): regenerate from .forge.ts manifests [sync-jobs]"

    if [[ -n "${JOB_FILTER}" ]]; then
      COMMIT_MSG="chore(dags): regenerate ${JOB_FILTER} from manifest [sync-jobs]"
    fi

    git -C "${REPO_ROOT}" commit -m "${COMMIT_MSG}"
    git -C "${REPO_ROOT}" push origin "${BRANCH}"
    log "  ✓ Pushed to ${BRANCH} — Airflow will pick up changes within 30s"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
log "══════════════════════════════════════════════"
log "  Jobs regenerated : ${#GENERATED_PY[@]}"
log "  ADLS uploads     : $((${#GENERATED_PY[@]} + ${#GENERATED_DQ[@]}))"
log "  Storage account  : ${STORAGE_ACCOUNT}"
log "  Environment      : ${FORGE_ENV}"
if [[ "${DRY_RUN}" == "true" ]]; then
  log "  *** DRY RUN — no changes made ***"
fi
log "══════════════════════════════════════════════"
