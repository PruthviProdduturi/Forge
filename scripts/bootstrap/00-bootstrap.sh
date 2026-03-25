#!/usr/bin/env bash
# =============================================================================
# Forge — Full Environment Bootstrap
#
# Automates the complete dev environment setup from scratch:
#   Phase 1  Pre-flight checks
#   Phase 2  Create ACR (with temporary public access for image push)
#   Phase 3  Build and push all container images to ACR
#   Phase 4  Deploy Bicep stack (networking → AKS → storage → identity → KV)
#   Phase 5  Add ACR private endpoint (now that VNet exists)
#   Phase 6  Lock ACR to private-only (remove temp public access)
#   Phase 7  Validate
#
# Usage:
#   ./scripts/bootstrap/00-bootstrap.sh [flags]
#
# Flags:
#   --dry-run           Print commands without executing them
#   --skip-images       Skip Phase 3 (images already in ACR)
#   --start-phase N     Resume from phase N (1-7)
#   --help              Show this message
#
# Requirements:
#   - Azure CLI 2.58+  (az)
#   - Docker 24+       (docker)
#   - kubectl 1.29+    (kubectl)
#   - Bicep CLI        (az bicep install)
# =============================================================================

set -euo pipefail

# =============================================================================
# !! CONFIG — update these to match your bicepparam file !!
# =============================================================================
SUBSCRIPTION_ID="eaa4a83d-8511-497c-b0bc-40aa5f0deae1"
TENANT_ID="72f988bf-86f1-41af-91ab-2d7cd011db47"
OWNER_ALIAS="prproddu"
ENV="dev"
LOCATION="northcentralus"
# =============================================================================

# ---------------------------------------------------------------------------
# Derived names — must match the Bicep naming logic in main.bicep exactly
# ---------------------------------------------------------------------------
ALIAS_SUFFIX="${OWNER_ALIAS:+-${OWNER_ALIAS}}"   # '-prproddu' or '' if empty

# 3 resource groups: platform (networking+ACR+AKS), data (ADLS), security (KV+identities)
RG_PLATFORM="rg-forge-platform${ALIAS_SUFFIX}-${ENV}"
RG_DATA="rg-forge-data${ALIAS_SUFFIX}-${ENV}"
RG_SECURITY="rg-forge-security${ALIAS_SUFFIX}-${ENV}"

ACR_RG="${RG_PLATFORM}"
ACR_NAME="forgeacr${OWNER_ALIAS}${ENV}"           # no hyphens, globally unique
ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"
ACR_BUILD_MI="id-forge-acr-build${ALIAS_SUFFIX}-${ENV}"

VNET_NAME="vnet-forge${ALIAS_SUFFIX}-${ENV}"
PE_SUBNET_NAME="snet-forge-private-endpoints${ALIAS_SUFFIX}-${ENV}"
ACR_PE_NAME="pep-${ACR_NAME}"

BICEP_PARAM_FILE="infra/bicep/environments/${ENV}/main.bicepparam"
BICEP_TEMPLATE_FILE="infra/bicep/environments/${ENV}/main.bicep"

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_phase()   { echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; \
                echo -e "${BOLD} Phase $1: $2${RESET}"; \
                echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }

# ---------------------------------------------------------------------------
# Script location
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
DRY_RUN=false
SKIP_IMAGES=false
START_PHASE=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)       DRY_RUN=true; shift ;;
        --skip-images)   SKIP_IMAGES=true; shift ;;
        --start-phase)   START_PHASE="$2"; shift 2 ;;
        --help|-h)
            sed -n '/^# Usage:/,/^# Requirements:/p' "$0" | sed 's/^# \{0,2\}//'
            exit 0 ;;
        *)
            log_error "Unknown flag: $1  (try --help)"
            exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Dry-run wrapper
# ---------------------------------------------------------------------------
run() {
    if [[ "${DRY_RUN}" == true ]]; then
        echo -e "${YELLOW}[DRY-RUN]${RESET} $*"
    else
        "$@"
    fi
}

# ---------------------------------------------------------------------------
# Idempotency helpers
# ---------------------------------------------------------------------------
rg_exists()  { az group show --name "$1" --query name -o tsv 2>/dev/null | grep -q "$1"; }
acr_exists() { az acr show  --name "$1" --query name -o tsv 2>/dev/null | grep -q "$1"; }
pe_exists()  {
    az network private-endpoint show \
        --name "$1" \
        --resource-group "$2" \
        --query name -o tsv 2>/dev/null | grep -q "$1"
}

should_run() { [[ "${START_PHASE}" -le "$1" ]]; }

# =============================================================================
# Banner
# =============================================================================
echo -e "${BOLD}"
echo "  ___                   ___               _       _             "
echo " | __|___  _ _ __ _ ___| _ ) ___  ___ ___| |_ _ _(_)_ __       "
echo " | _|/ _ \| '_/ _\` / -_) _ \/ _ \/ _ \_ /  _| '_| | '_ \      "
echo " |_| \___/|_| \__, \___|___/\___/\___/__|\__|_| |_| .__/       "
echo "               |___/                               |_|          "
echo -e "${RESET}"
echo -e "${BOLD}Forge Full Bootstrap — ${ENV}${RESET}"
echo -e "  Subscription : ${CYAN}${SUBSCRIPTION_ID}${RESET}"
echo -e "  Owner alias  : ${CYAN}${OWNER_ALIAS}${RESET}"
echo -e "  Location     : ${CYAN}${LOCATION}${RESET}"
echo -e "  ACR          : ${CYAN}${ACR_NAME}${RESET}"
echo -e "  Dry run      : ${CYAN}${DRY_RUN}${RESET}"
echo -e "  Start phase  : ${CYAN}${START_PHASE}${RESET}"
echo ""

# =============================================================================
# Phase 1: Pre-flight checks
# =============================================================================
if should_run 1; then
    log_phase 1 "Pre-flight checks"

    # Check required tools
    for tool in az docker kubectl; do
        if ! command -v "${tool}" &>/dev/null; then
            log_error "Required tool not found: ${tool}"
            exit 1
        fi
        log_ok "${tool} found: $(${tool} version --short 2>/dev/null || ${tool} --version 2>&1 | head -1)"
    done

    # Ensure Bicep is installed
    run az bicep install
    log_ok "Bicep CLI ready"

    # Set subscription
    run az account set --subscription "${SUBSCRIPTION_ID}"
    CURRENT_SUB=$(az account show --query id -o tsv 2>/dev/null || echo "${SUBSCRIPTION_ID}")
    log_ok "Subscription set: ${CURRENT_SUB}"

    # Get current user OID — used for admin group IDs if not yet configured
    MY_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
    if [[ -z "${MY_OID}" ]]; then
        log_error "Could not resolve current user object ID. Run: az login"
        exit 1
    fi
    log_ok "Signed-in user OID: ${MY_OID}"

    # Verify bicepparam file exists
    if [[ ! -f "${REPO_ROOT}/${BICEP_PARAM_FILE}" ]]; then
        log_error "Param file not found: ${BICEP_PARAM_FILE}"
        exit 1
    fi
    log_ok "Param file found: ${BICEP_PARAM_FILE}"

    # Confirm admin group placeholder — auto-fill with current user OID for POC
    if grep -q '<your-aks-admin-group-object-id>' "${REPO_ROOT}/${BICEP_PARAM_FILE}"; then
        log_warn "adminGroupObjectIds placeholder detected — will use current user OID: ${MY_OID}"
        ADMIN_GROUP_OVERRIDE="${MY_OID}"
    else
        ADMIN_GROUP_OVERRIDE=""
    fi

    if grep -q '<your-platform-admin-group-object-id>' "${REPO_ROOT}/${BICEP_PARAM_FILE}"; then
        log_warn "platformAdminGroupObjectId placeholder detected — will use current user OID: ${MY_OID}"
        PLATFORM_ADMIN_OVERRIDE="${MY_OID}"
    else
        PLATFORM_ADMIN_OVERRIDE=""
    fi

    # Enable Defender for Containers at subscription level (S360)
    log_info "Enabling Microsoft Defender for Containers..."
    run az security pricing create --name Containers --tier Standard
    log_ok "Defender for Containers: Standard"

    log_ok "Pre-flight complete"
else
    # When skipping phase 1, we still need MY_OID and admin overrides
    MY_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
    ADMIN_GROUP_OVERRIDE=""
    PLATFORM_ADMIN_OVERRIDE=""
    if grep -q '<your-aks-admin-group-object-id>' "${REPO_ROOT}/${BICEP_PARAM_FILE}" 2>/dev/null; then
        ADMIN_GROUP_OVERRIDE="${MY_OID}"
    fi
    if grep -q '<your-platform-admin-group-object-id>' "${REPO_ROOT}/${BICEP_PARAM_FILE}" 2>/dev/null; then
        PLATFORM_ADMIN_OVERRIDE="${MY_OID}"
    fi
fi

# =============================================================================
# Phase 2: Provision ACR
# Temporarily allows public access from the current machine so images can be
# pushed. Phase 6 locks it back down after the private endpoint is wired up.
# =============================================================================
if should_run 2; then
    log_phase 2 "Provision ACR (${ACR_NAME})"

    # Resource group
    if rg_exists "${ACR_RG}"; then
        log_ok "Resource group already exists: ${ACR_RG}"
    else
        log_info "Creating resource group: ${ACR_RG}"
        run az group create \
            --name "${ACR_RG}" \
            --location "${LOCATION}" \
            --tags platform=forge environment="${ENV}" owner="${OWNER_ALIAS}" managedBy=bootstrap
    fi

    # ACR
    if acr_exists "${ACR_NAME}"; then
        log_ok "ACR already exists: ${ACR_NAME}"
    else
        log_info "Creating ACR: ${ACR_NAME} (Premium, public access temporarily enabled for image push)"
        # Public access is temporarily allowed so the build machine can push images.
        # It will be restricted to the current machine's IP, and fully disabled in Phase 6.
        MY_PUBLIC_IP=$(curl -sf https://api.ipify.org || echo "")
        run az acr create \
            --resource-group "${ACR_RG}" \
            --name "${ACR_NAME}" \
            --sku Premium \
            --location "${LOCATION}" \
            --admin-enabled false \
            --public-network-enabled true \
            --zone-redundancy Enabled \
            --retention-days 365 \
            --tags platform=forge environment="${ENV}" owner="${OWNER_ALIAS}" managedBy=bootstrap

        # Restrict public access to current machine only
        if [[ -n "${MY_PUBLIC_IP}" ]]; then
            log_info "Restricting ACR public access to current IP: ${MY_PUBLIC_IP}"
            run az acr network-rule add \
                --name "${ACR_NAME}" \
                --resource-group "${ACR_RG}" \
                --ip-address "${MY_PUBLIC_IP}"
            run az acr update \
                --name "${ACR_NAME}" \
                --resource-group "${ACR_RG}" \
                --default-action Deny
            log_ok "ACR network rule set to allow only ${MY_PUBLIC_IP}"
        else
            log_warn "Could not detect public IP — ACR temporarily open to all (will be locked in Phase 6)"
        fi
    fi

    # Build managed identity for CI/CD use
    if az identity show --name "${ACR_BUILD_MI}" --resource-group "${ACR_RG}" --query name -o tsv 2>/dev/null | grep -q "${ACR_BUILD_MI}"; then
        log_ok "Build managed identity already exists: ${ACR_BUILD_MI}"
    else
        log_info "Creating build managed identity: ${ACR_BUILD_MI}"
        run az identity create \
            --name "${ACR_BUILD_MI}" \
            --resource-group "${ACR_RG}" \
            --location "${LOCATION}" \
            --tags platform=forge environment="${ENV}" owner="${OWNER_ALIAS}"
    fi

    ACR_ID=$(az acr show --name "${ACR_NAME}" --resource-group "${ACR_RG}" --query id -o tsv)
    BUILD_MI_PRINCIPAL=$(az identity show --name "${ACR_BUILD_MI}" --resource-group "${ACR_RG}" --query principalId -o tsv 2>/dev/null || echo "")

    # Role assignments for build identity
    if [[ -n "${BUILD_MI_PRINCIPAL}" ]]; then
        for role in AcrPush AcrPull; do
            if az role assignment list --scope "${ACR_ID}" --role "${role}" \
                --query "[?principalId=='${BUILD_MI_PRINCIPAL}']" -o tsv 2>/dev/null | grep -q .; then
                log_ok "${role} already assigned to build identity"
            else
                log_info "Assigning ${role} to build identity"
                run az role assignment create \
                    --assignee "${BUILD_MI_PRINCIPAL}" \
                    --role "${role}" \
                    --scope "${ACR_ID}"
            fi
        done
    fi

    # Grant current user AcrPush so they can push images now
    if az role assignment list --scope "${ACR_ID}" --role "AcrPush" \
        --query "[?principalId=='${MY_OID}']" -o tsv 2>/dev/null | grep -q .; then
        log_ok "AcrPush already assigned to current user"
    else
        log_info "Assigning AcrPush to current user (${MY_OID}) for initial image push"
        run az role assignment create \
            --assignee "${MY_OID}" \
            --role "AcrPush" \
            --scope "${ACR_ID}"
    fi

    log_ok "ACR provisioned: ${ACR_LOGIN_SERVER}"
fi

# =============================================================================
# Phase 3: Build and push all container images
# =============================================================================
if should_run 3 && [[ "${SKIP_IMAGES}" == false ]]; then
    log_phase 3 "Build and push images to ${ACR_LOGIN_SERVER}"

    run az acr login --name "${ACR_NAME}"

    run bash "${SCRIPT_DIR}/build-and-push-images.sh" \
        --env "${ENV}" \
        --registry "${ACR_LOGIN_SERVER}" \
        --skip-login \
        $([ "${DRY_RUN}" == true ] && echo "--dry-run")

    log_ok "All images in ACR"
elif should_run 3; then
    log_phase 3 "Build and push images (SKIPPED — --skip-images)"
fi

# =============================================================================
# Phase 4: Deploy full Bicep stack
# =============================================================================
if should_run 4; then
    log_phase 4 "Deploy Bicep stack"

    ACR_ID=$(az acr show --name "${ACR_NAME}" --resource-group "${ACR_RG}" --query id -o tsv)

    # Build the --parameters overrides for placeholder values
    EXTRA_PARAMS=""
    if [[ -n "${ADMIN_GROUP_OVERRIDE}" ]]; then
        EXTRA_PARAMS="${EXTRA_PARAMS} --parameters adminGroupObjectIds=[\"${ADMIN_GROUP_OVERRIDE}\"]"
        log_info "Overriding adminGroupObjectIds with current user OID"
    fi
    if [[ -n "${PLATFORM_ADMIN_OVERRIDE}" ]]; then
        EXTRA_PARAMS="${EXTRA_PARAMS} --parameters platformAdminGroupObjectId=${PLATFORM_ADMIN_OVERRIDE}"
        log_info "Overriding platformAdminGroupObjectId with current user OID"
    fi

    log_info "Starting Bicep deployment (this takes ~20-30 min)..."
    run az deployment sub create \
        --name "forge-bootstrap-${ENV}-$(date +%Y%m%d%H%M%S)" \
        --location "${LOCATION}" \
        --template-file "${REPO_ROOT}/${BICEP_TEMPLATE_FILE}" \
        --parameters "${REPO_ROOT}/${BICEP_PARAM_FILE}" \
        --parameters containerRegistryId="${ACR_ID}" \
        ${EXTRA_PARAMS}

    log_ok "Bicep deployment complete"
fi

# =============================================================================
# Phase 5: Add ACR private endpoint
# Now that the VNet from the networking module exists, wire ACR into it.
# =============================================================================
if should_run 5; then
    log_phase 5 "Add ACR private endpoint"

    # Retrieve networking outputs
    PE_SUBNET_ID=$(az network vnet subnet show \
        --resource-group "${RG_PLATFORM}" \
        --vnet-name "${VNET_NAME}" \
        --name "${PE_SUBNET_NAME}" \
        --query id -o tsv 2>/dev/null || echo "")

    ACR_DNS_ZONE_ID=$(az network private-dns zone show \
        --resource-group "${RG_PLATFORM}" \
        --name "privatelink.azurecr.io" \
        --query id -o tsv 2>/dev/null || echo "")

    ACR_ID=$(az acr show --name "${ACR_NAME}" --resource-group "${ACR_RG}" --query id -o tsv)

    if [[ -z "${PE_SUBNET_ID}" ]]; then
        log_error "Could not find subnet ${PE_SUBNET_NAME} in ${RG_PLATFORM}. Is Phase 4 complete?"
        exit 1
    fi

    if pe_exists "${ACR_PE_NAME}" "${ACR_RG}"; then
        log_ok "ACR private endpoint already exists: ${ACR_PE_NAME}"
    else
        log_info "Creating ACR private endpoint: ${ACR_PE_NAME}"
        run az network private-endpoint create \
            --name "${ACR_PE_NAME}" \
            --resource-group "${ACR_RG}" \
            --location "${LOCATION}" \
            --subnet "${PE_SUBNET_ID}" \
            --private-connection-resource-id "${ACR_ID}" \
            --group-id registry \
            --connection-name "plsc-${ACR_NAME}" \
            --tags platform=forge environment="${ENV}" owner="${OWNER_ALIAS}"

        # DNS zone group (auto-registers A record in the private DNS zone)
        if [[ -n "${ACR_DNS_ZONE_ID}" ]]; then
            log_info "Linking ACR PE to private DNS zone"
            run az network private-endpoint dns-zone-group create \
                --name "acr-dns-zone-group" \
                --resource-group "${ACR_RG}" \
                --endpoint-name "${ACR_PE_NAME}" \
                --private-dns-zone "${ACR_DNS_ZONE_ID}" \
                --zone-name "privatelink.azurecr.io"
        else
            log_warn "ACR private DNS zone not found in ${RG_PLATFORM} — skipping zone group"
        fi

        log_ok "ACR private endpoint created"
    fi
fi

# =============================================================================
# Phase 6: Lock ACR to private-only
# Remove the temporary IP allowlist and disable all public access.
# =============================================================================
if should_run 6; then
    log_phase 6 "Lock ACR to private-only (S360)"

    log_info "Disabling public network access on ACR: ${ACR_NAME}"
    run az acr update \
        --name "${ACR_NAME}" \
        --resource-group "${ACR_RG}" \
        --public-network-enabled false

    log_ok "ACR public access: Disabled — accessible only via private endpoint"
fi

# =============================================================================
# Phase 7: Validate
# =============================================================================
if should_run 7; then
    log_phase 7 "Validate"

    PASS=0; FAIL=0

    check() {
        local label="$1"; shift
        if "$@" &>/dev/null; then
            log_ok "${label}"
            ((PASS++)) || true
        else
            log_warn "FAIL: ${label}"
            ((FAIL++)) || true
        fi
    }

    check "ACR exists and is Premium" \
        az acr show --name "${ACR_NAME}" --resource-group "${ACR_RG}" \
            --query "[?sku.name=='Premium']" -o tsv

    check "ACR public access disabled" \
        bash -c "az acr show --name '${ACR_NAME}' --resource-group '${ACR_RG}' \
            --query publicNetworkAccess -o tsv | grep -q Disabled"

    check "ACR private endpoint exists" \
        pe_exists "${ACR_PE_NAME}" "${ACR_RG}"

    check "Platform  resource group exists" rg_exists "${RG_PLATFORM}"
    check "Data      resource group exists" rg_exists "${RG_DATA}"
    check "Security resource group exists"   rg_exists "${RG_SECURITY}"

    check "Compute AKS cluster provisioned" \
        az aks show \
            --name "aks-forge-compute${ALIAS_SUFFIX}-${ENV}" \
            --resource-group "${RG_PLATFORM}" \
            --query provisioningState -o tsv

    check "Orch AKS cluster provisioned" \
        az aks show \
            --name "aks-forge-orchestration${ALIAS_SUFFIX}-${ENV}" \
            --resource-group "${RG_PLATFORM}" \
            --query provisioningState -o tsv

    check "Storage account exists" \
        az storage account show \
            --name "forgeadls${OWNER_ALIAS}${ENV}" \
            --resource-group "${RG_DATA}" \
            --query name -o tsv

    check "Key Vault exists" \
        az keyvault show \
            --name "kv-forge${ALIAS_SUFFIX}-${ENV}" \
            --resource-group "${RG_SECURITY}" \
            --query name -o tsv

    check "Defender for Containers is Standard" \
        bash -c "az security pricing show --name Containers \
            --query pricingTier -o tsv | grep -q Standard"

    echo ""
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD} Bootstrap Result: ${GREEN}${PASS} passed${RESET}${BOLD}  ${RED}${FAIL} failed${RESET}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

    if [[ "${FAIL}" -gt 0 ]]; then
        log_warn "Some checks failed — review the output above and rerun from the failed phase with --start-phase N"
        exit 1
    fi
fi

echo ""
log_ok "Forge ${ENV} environment is ready."
echo -e "${CYAN}Next steps:${RESET}"
echo "  1. Deploy compute workloads  : helm upgrade --install spark-operator ..."
echo "  2. Deploy orchestration      : helm upgrade --install airflow ..."
echo "  3. Open the portal           : kubectl port-forward svc/portal-web 3001:3001 -n portal"
echo ""
