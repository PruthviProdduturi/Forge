#!/usr/bin/env bash
# =============================================================================
# Forge — Bootstrap Terraform State Backend
#
# Run ONCE per environment before any `terraform init`.
# Creates the Azure storage account used as the Terraform remote state backend.
#
# Usage:
#   ./setup-tf-backend.sh --env dev --subscription-id <uuid>
#
# Requirements:
#   - Azure CLI authenticated with Owner role on the target subscription
# =============================================================================
set -euo pipefail

LOCATION="northcentralus"

usage() {
  echo "Usage: $0 --env <dev|staging|prod> --subscription-id <uuid>"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="$2"; shift 2 ;;
    --subscription-id) SUBSCRIPTION_ID="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -z "${ENV:-}" || -z "${SUBSCRIPTION_ID:-}" ]] && usage

RESOURCE_GROUP="rg-forge-tfstate"
STORAGE_ACCOUNT="forgetfstate${ENV}"
CONTAINER="tfstate"

echo "==> Setting subscription: ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

echo "==> Creating resource group: ${RESOURCE_GROUP}"
az group create \
  --name "${RESOURCE_GROUP}" \
  --location "${LOCATION}" \
  --tags platform=forge environment="${ENV}" managed_by=bootstrap \
  --output none

echo "==> Creating storage account: ${STORAGE_ACCOUNT}"
az storage account create \
  --name "${STORAGE_ACCOUNT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --location "${LOCATION}" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --access-tier Hot \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --https-only true \
  --tags platform=forge environment="${ENV}" managed_by=bootstrap \
  --output none

echo "==> Enabling versioning on storage account"
az storage account blob-service-properties update \
  --account-name "${STORAGE_ACCOUNT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --enable-versioning true \
  --output none

echo "==> Creating blob container: ${CONTAINER}"
az storage container create \
  --name "${CONTAINER}" \
  --account-name "${STORAGE_ACCOUNT}" \
  --auth-mode login \
  --output none

echo ""
echo "====================================================="
echo " Terraform backend is ready."
echo " Add the following to your backend.tf:"
echo "====================================================="
echo ""
echo '  terraform {'
echo '    backend "azurerm" {'
echo "      resource_group_name  = \"${RESOURCE_GROUP}\""
echo "      storage_account_name = \"${STORAGE_ACCOUNT}\""
echo "      container_name       = \"${CONTAINER}\""
echo "      key                  = \"forge/${ENV}/terraform.tfstate\""
echo '      use_oidc             = true'
echo '    }'
echo '  }'
echo ""
