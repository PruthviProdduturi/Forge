#!/usr/bin/env bash
# =============================================================================
# sync-jobs.sh — Push generated Spark jobs and DQ rules to ADLS
#
# Run this after `forge generate` to make the latest changes live.
#
# What it does:
#   1. Uploads changed Spark job .py files → abfss://code@{storage}/spark/jobs/
#   2. Uploads changed DQ rule .yaml files → abfss://code@{storage}/dq/rules/
#   3. DAG files are picked up automatically by Airflow git-sync (push to git)
#
# Usage:
#   ./scripts/sync-jobs.sh                        # sync all changed files
#   ./scripts/sync-jobs.sh --job nyc_taxi_silver  # sync one job only
#   ./scripts/sync-jobs.sh --all                  # force-sync everything
#   ./scripts/sync-jobs.sh --dry-run              # show what would be uploaded
#
# Requirements:
#   - az CLI logged in (az login or workload identity in CI)
#   - FORGE_ENV set (dev | staging | prod), or .env loaded
#   - OWNER_ALIAS set (used to derive storage account name)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

JOBS_DIR="${REPO_ROOT}/examples/src/spark/jobs"
DQ_DIR="${REPO_ROOT}/examples/orchestration/dq/rules"
DAGS_DIR="${REPO_ROOT}/orchestration/airflow/dags"

FORGE_ENV="${FORGE_ENV:-dev}"
OWNER_ALIAS="${OWNER_ALIAS:-}"
STORAGE_ACCOUNT="${FORGE_STORAGE_ACCOUNT:-}"

# Derive storage account from owner alias if not set explicitly
if [[ -z "${STORAGE_ACCOUNT}" && -n "${OWNER_ALIAS}" ]]; then
  STORAGE_ACCOUNT="forgeadls${OWNER_ALIAS}${FORGE_ENV}"
fi

if [[ -z "${STORAGE_ACCOUNT}" ]]; then
  echo "ERROR: set FORGE_STORAGE_ACCOUNT or OWNER_ALIAS env var" >&2
  exit 1
fi

CODE_CONTAINER="code"
JOBS_DEST="spark/jobs"
DQ_DEST="dq/rules"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
JOB_FILTER=""
FORCE_ALL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --job)      JOB_FILTER="$2"; shift 2 ;;
    --all)      FORCE_ALL=true; shift ;;
    --dry-run)  DRY_RUN=true; shift ;;
    *)          echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[sync-jobs] $*"; }
warn() { echo "[sync-jobs] WARN: $*" >&2; }

upload() {
  local src="$1"
  local dest_blob="$2"
  local filename
  filename="$(basename "${src}")"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "  [dry-run] would upload ${src} → ${CODE_CONTAINER}/${dest_blob}"
    return 0
  fi

  az storage blob upload \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${CODE_CONTAINER}" \
    --name "${dest_blob}" \
    --file "${src}" \
    --overwrite \
    --auth-mode login \
    --output none \
    && log "  ✓ ${filename} → ${CODE_CONTAINER}/${dest_blob}" \
    || warn "  ✗ failed to upload ${filename}"
}

# Check whether a file is changed vs the last sync
# Uses git diff vs HEAD to find modified/added files; --all bypasses this
is_changed() {
  local file="$1"
  if [[ "${FORCE_ALL}" == "true" ]]; then
    return 0
  fi
  # Changed if: staged, unstaged, or untracked
  git -C "${REPO_ROOT}" diff --name-only HEAD -- "${file}" | grep -q . 2>/dev/null && return 0
  git -C "${REPO_ROOT}" diff --name-only -- "${file}" | grep -q . 2>/dev/null && return 0
  git -C "${REPO_ROOT}" ls-files --others --exclude-standard -- "${file}" | grep -q . 2>/dev/null && return 0
  return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log "Storage account : ${STORAGE_ACCOUNT}"
log "Container       : ${CODE_CONTAINER}"
log "Environment     : ${FORGE_ENV}"
log "Force all       : ${FORCE_ALL}"
log "Dry run         : ${DRY_RUN}"
[[ -n "${JOB_FILTER}" ]] && log "Job filter      : ${JOB_FILTER}"
echo ""

UPLOADED=0
SKIPPED=0

# ── Spark jobs ────────────────────────────────────────────────────────────
log "=== Spark jobs ==="
while IFS= read -r -d '' pyfile; do
  job_name="$(basename "${pyfile}" .py)"

  # Skip manifest files (.forge.ts are .ts not .py — but be safe)
  [[ "${job_name}" == *.forge ]] && continue

  # Apply --job filter
  if [[ -n "${JOB_FILTER}" && "${job_name}" != "${JOB_FILTER}" ]]; then
    continue
  fi

  if is_changed "${pyfile}" || [[ "${FORCE_ALL}" == "true" ]]; then
    upload "${pyfile}" "${JOBS_DEST}/${job_name}.py"
    (( UPLOADED++ )) || true
  else
    log "  – ${job_name}.py  (unchanged, skipping)"
    (( SKIPPED++ )) || true
  fi
done < <(find "${JOBS_DIR}" -maxdepth 1 -name "*.py" -not -name "*.forge.py" -print0 | sort -z)

echo ""

# ── DQ rules ─────────────────────────────────────────────────────────────
log "=== DQ rules ==="
while IFS= read -r -d '' yamlfile; do
  rule_name="$(basename "${yamlfile}")"

  if [[ -n "${JOB_FILTER}" ]]; then
    # Only sync the DQ file matching the job filter
    [[ "${rule_name}" != "${JOB_FILTER}.yaml" ]] && continue
  fi

  if is_changed "${yamlfile}" || [[ "${FORCE_ALL}" == "true" ]]; then
    upload "${yamlfile}" "${DQ_DEST}/${rule_name}"
    (( UPLOADED++ )) || true
  else
    log "  – ${rule_name}  (unchanged, skipping)"
    (( SKIPPED++ )) || true
  fi
done < <(find "${DQ_DIR}" -maxdepth 1 -name "*.yaml" -print0 | sort -z)

echo ""

# ── Summary ───────────────────────────────────────────────────────────────
log "=== Done ==="
log "Uploaded : ${UPLOADED}"
log "Skipped  : ${SKIPPED}"
echo ""
log "DAG files are synced automatically by Airflow git-sync."
log "Push your branch and Airflow will pick up DAG changes within 30s."
