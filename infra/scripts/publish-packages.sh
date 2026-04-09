#!/usr/bin/env bash
# =============================================================================
# publish-packages.sh — Build and publish Forge Python packages to ADO Artifacts
#
# Usage:
#   bash infra/scripts/publish-packages.sh --pat <ado-pat> [options]
#
# Options:
#   --pat <token>       Azure DevOps PAT with Packaging (read+write) scope
#   --feed <name>       ADO Artifacts feed name (default: forge-python)
#   --repo-root <path>  Repo root (default: two levels up from this script)
#   --skip-build        Skip build step — re-publish previously built dist/
#
# Publishes:
#   forge-sdk  — Spark session factory, ADLS path helpers, job base class
#   forge-dq   — Data quality framework (profiling, rules, anomaly detection)
#
# Feed URL:
#   https://pkgs.dev.azure.com/L1R/Data%20Science%20Engineering/_packaging/<feed>/pypi/
#
# Install published packages in notebooks / prod scripts:
#   pip install forge-sdk forge-dq \
#     --index-url "https://pkgs.dev.azure.com/L1R/Data%20Science%20Engineering/_packaging/forge-python/pypi/simple/" \
#     --extra-index-url https://pypi.org/simple/
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADO_PAT=""
FEED_NAME="forge-python"
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pat)        ADO_PAT="$2";    shift 2 ;;
    --feed)       FEED_NAME="$2";  shift 2 ;;
    --repo-root)  REPO_ROOT="$2";  shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -z "$ADO_PAT" ]] && { echo "ERROR: --pat <ado-pat> is required"; exit 1; }

ADO_ORG="L1R"
ADO_PROJECT="Data%20Science%20Engineering"
ADO_FEED_URL="https://pkgs.dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_packaging/${FEED_NAME}/pypi/upload/"
ADO_INDEX_URL="https://pkgs.dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_packaging/${FEED_NAME}/pypi/simple/"

echo "━━━ Forge Python Package Publisher ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Feed : ${ADO_FEED_URL}"
echo ""

# ---------------------------------------------------------------------------
# Ensure build tools
# ---------------------------------------------------------------------------
echo "  Checking build tools..."
pip install --quiet --upgrade build twine

# ---------------------------------------------------------------------------
# Read version from pyproject.toml
# ---------------------------------------------------------------------------
_read_version() {
  local pkg_dir="$1"
  python3 -c "
import tomllib, pathlib, sys
data = tomllib.loads(pathlib.Path('${pkg_dir}/pyproject.toml').read_text())
print(data['project']['version'])
" 2>/dev/null || grep '^version' "${pkg_dir}/pyproject.toml" | head -1 | tr -d ' ' | cut -d= -f2 | tr -d '"'
}

# ---------------------------------------------------------------------------
# Show version table before publishing
# ---------------------------------------------------------------------------
echo "  Packages to publish:"
printf "    %-20s %s\n" "forge-catalog" "$(_read_version "${REPO_ROOT}/sdk/python/forge_catalog")"
printf "    %-20s %s\n" "forge-sdk"     "$(_read_version "${REPO_ROOT}/sdk/python/forge_sdk")"
printf "    %-20s %s\n" "forge-dq"      "$(_read_version "${REPO_ROOT}/sdk/python/forge_dq")"
echo ""

# ---------------------------------------------------------------------------
# Build + publish each package
# Publish order matters: forge-catalog first (forge-sdk depends on it)
# ---------------------------------------------------------------------------

_publish_package() {
  local pkg_dir="$1"
  local pkg_name="$2"
  local dist_dir="${pkg_dir}/dist"
  local version
  version=$(_read_version "$pkg_dir")

  if [[ "$SKIP_BUILD" == "false" ]]; then
    echo "  [${pkg_name}@${version}] Building..."
    rm -rf "$dist_dir"
    python -m build "$pkg_dir" --outdir "$dist_dir"
    echo "  [${pkg_name}@${version}] Build complete"
  else
    echo "  [${pkg_name}@${version}] Skipping build (--skip-build)"
    [[ -d "$dist_dir" ]] || { echo "  ERROR: dist/ not found at ${dist_dir}"; exit 1; }
  fi

  echo "  [${pkg_name}@${version}] Publishing to ${FEED_NAME}..."
  twine upload \
    --repository-url "$ADO_FEED_URL" \
    --username "forge" \
    --password "$ADO_PAT" \
    --skip-existing \
    --non-interactive \
    "${dist_dir}"/*.whl "${dist_dir}"/*.tar.gz
  echo "  [${pkg_name}@${version}] Done"
  echo ""
}

# forge-catalog first — forge-sdk depends on it
_publish_package "${REPO_ROOT}/sdk/python/forge_catalog" "forge-catalog"
_publish_package "${REPO_ROOT}/sdk/python/forge_sdk"     "forge-sdk"
_publish_package "${REPO_ROOT}/sdk/python/forge_dq"      "forge-dq"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
_CAT_VER=$(_read_version "${REPO_ROOT}/sdk/python/forge_catalog")
_SDK_VER=$(_read_version "${REPO_ROOT}/sdk/python/forge_sdk")
_DQ_VER=$(_read_version  "${REPO_ROOT}/sdk/python/forge_dq")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Published to feed: ${FEED_NAME}"
echo ""
echo "  Tag these commits in git to track the release:"
echo "    git tag forge-catalog-v${_CAT_VER}"
echo "    git tag forge-sdk-v${_SDK_VER}"
echo "    git tag forge-dq-v${_DQ_VER}"
echo "    git push origin --tags"
echo ""
echo "  Install in notebooks or prod scripts:"
echo ""
echo "    pip install forge-catalog forge-sdk forge-dq \\"
echo "      --index-url \"${ADO_INDEX_URL}\" \\"
echo "      --extra-index-url https://pypi.org/simple/"
echo ""
echo "  requirements.txt:"
echo "    --index-url ${ADO_INDEX_URL}"
echo "    --extra-index-url https://pypi.org/simple/"
echo "    forge-catalog>=${_CAT_VER}"
echo "    forge-sdk>=${_SDK_VER}"
echo "    forge-dq>=${_DQ_VER}"
