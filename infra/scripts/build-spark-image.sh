#!/bin/bash
# =============================================================================
# Build and push the Forge Spark Docker image to ACR.
#
# Usage:
#   ./infra/scripts/build-spark-image.sh <acr-name> [spark-version]
#
# Examples:
#   ./infra/scripts/build-spark-image.sh forgeacrprproddu          # tag: 4.1.1
#   ./infra/scripts/build-spark-image.sh forgeacrprproddu 4.1.1    # explicit tag
#
# The build context must be the repo root (sdk/python is copied in).
# =============================================================================
set -euo pipefail

ACR_NAME="${1:?Usage: $0 <acr-name> [spark-version]}"
SPARK_VERSION="${2:-4.1.1}"
IMAGE_TAG="${ACR_NAME}.azurecr.io/spark:${SPARK_VERSION}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

echo "Building Spark image: ${IMAGE_TAG}"
echo "Build context: ${REPO_ROOT}"

az acr build \
  --registry "${ACR_NAME}" \
  --image "spark:${SPARK_VERSION}" \
  --file "${REPO_ROOT}/infra/docker/spark/Dockerfile" \
  "${REPO_ROOT}"

echo "Done. Image pushed: ${IMAGE_TAG}"
