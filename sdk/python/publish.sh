#!/usr/bin/env bash
# =============================================================================
# publish.sh — Build and publish forge-sdk and forge-dq wheels to Azure Artifacts
#
# Prerequisites:
#   pip install build twine keyring artifacts-keyring
#   az login (or set AZURE_DEVOPS_EXT_PAT env var)
#
# Usage:
#   bash sdk/python/publish.sh                    # publish both packages
#   bash sdk/python/publish.sh --package forge-sdk  # publish one package
#   bash sdk/python/publish.sh --dry-run          # build only, no publish
#
# Azure Artifacts feed URL (set FORGE_FEED_URL to override):
#   https://pkgs.dev.azure.com/L1R/Data%20Science%20Engineering/_packaging/forge/pypi/upload/
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FEED_URL="${FORGE_FEED_URL:-https://pkgs.dev.azure.com/L1R/Data%20Science%20Engineering/_packaging/forge/pypi/upload/}"
PACKAGE_FILTER=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)   PACKAGE_FILTER="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

PACKAGES=("forge_sdk" "forge_dq")
if [[ -n "$PACKAGE_FILTER" ]]; then
  PACKAGES=("${PACKAGE_FILTER//-/_}")
fi

for pkg in "${PACKAGES[@]}"; do
  pkg_dir="${SCRIPT_DIR}/${pkg}"
  [[ -d "$pkg_dir" ]] || { echo "ERROR: package directory not found: $pkg_dir"; exit 1; }

  echo ""
  echo "=== Building ${pkg} ==="
  cd "$pkg_dir"

  rm -rf dist/ build/ *.egg-info
  python -m build --wheel --sdist

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would upload to ${FEED_URL}"
    ls dist/
  else
    echo "  Publishing to Azure Artifacts..."
    twine upload \
      --repository-url "$FEED_URL" \
      --non-interactive \
      dist/*
    echo "  Published: $(ls dist/)"
  fi

  cd "$SCRIPT_DIR"
done

echo ""
echo "=== Done. Install with: ==="
echo "  pip install forge-sdk forge-dq \\"
echo "    --index-url https://pkgs.dev.azure.com/L1R/Data%20Science%20Engineering/_packaging/forge/pypi/simple/"
