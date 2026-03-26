#!/usr/bin/env bash
# =============================================================================
# Forge — Step 01: Azure Container Registry Setup
#
# Creates the ACR and all supporting resources required before any image build
# or AKS cluster provisioning can happen.
#
# What this script does:
#   1. Pre-flight  — check tools, subscription, Defender for Containers
#   2. ACR         — Premium SKU, zone-redundant, temporarily public for image push
#   3. Identity    — platform managed identity (id-forge-{env})
#   4. Roles       — AcrPush + AcrPull for build identity and current user
#   5. Validate    — verify everything is in the expected state
#
# Temporarily enables public access (restricted to current machine IP) so images
# can be pushed in the next step. The full bootstrap (00-bootstrap.sh Phase 6)
# locks it back down to private-only once the VNet private endpoint is in place.
#
# Usage:
#   ./scripts/bootstrap/01-setup-acr.sh [flags]
#
# Flags:
#   --env       dev|prod       Target environment  (default: dev)
#   --dry-run                  Print commands without executing
#   --help                     Show this message
#
# Requirements:
#   - Azure CLI 2.58+     (az)
#   - Logged in           (az login)
#   - Contributor + User Access Administrator on the subscription
# =============================================================================

set -euo pipefail

# =============================================================================
# CONFIG — edit these to match your environment
# =============================================================================
SUBSCRIPTION_ID="eaa4a83d-8511-497c-b0bc-40aa5f0deae1"
OWNER_ALIAS="prproddu"
LOCATION="northcentralus"
LOCATION_SECONDARY="westus2"      # prod only, for geo-replication
# =============================================================================

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
ENV="dev"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)       ENV="$2"; shift 2 ;;
        --dry-run)   DRY_RUN=true; shift ;;
        --help|-h)
            sed -n '/^# Usage:/,/^# Requirements:/p' "$0" | sed 's/^# \{0,2\}//'
            exit 0 ;;
        *)
            echo "Unknown flag: $1  (try --help)" >&2
            exit 1 ;;
    esac
done

if [[ "${ENV}" != "dev" && "${ENV}" != "prod" ]]; then
    echo "ERROR: --env must be 'dev' or 'prod'" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Derived names — must match 00-bootstrap.sh and Bicep modules exactly
# ---------------------------------------------------------------------------
ALIAS_SUFFIX="${OWNER_ALIAS:+-${OWNER_ALIAS}}"

RG_NAME="rg-forge-platform${ALIAS_SUFFIX}-${ENV}"
ACR_NAME="forgeacr${OWNER_ALIAS}${ENV}"           # globally unique, lowercase, no hyphens
ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"
MI_NAME="id-forge${ALIAS_SUFFIX}-${ENV}"

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()    { echo -e "${GREEN}[ OK ]${RESET}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error() { echo -e "${RED}[ERR ]${RESET}  $*" >&2; }
log_step()  {
    echo ""
    echo -e "${BOLD}──────────────────────────────────────────────────${RESET}"
    echo -e "${BOLD} $*${RESET}"
    echo -e "${BOLD}──────────────────────────────────────────────────${RESET}"
}

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
rg_exists()  { az group show  --name "$1" --query name -o tsv 2>/dev/null | grep -q "$1"; }
acr_exists() { az acr show   --name "$1" --query name -o tsv 2>/dev/null | grep -q "$1"; }
mi_exists()  { az identity show --name "$1" --resource-group "$2" --query name -o tsv 2>/dev/null | grep -q "$1"; }
role_assigned() {
    local principal="$1" role="$2" scope="$3"
    az role assignment list \
        --assignee "${principal}" \
        --role "${role}" \
        --scope "${scope}" \
        --query "[0].id" -o tsv 2>/dev/null | grep -q .
}

# =============================================================================
# Banner
# =============================================================================
echo -e "${BOLD}"
echo "  ___                   ___               _       _         "
echo " | __|___  _ _ __ _ ___| _ ) ___  ___ ___| |_ _ _(_)_ __   "
echo " | _|/ _ \| '_/ _\` / -_) _ \/ _ \/ _ \_ /  _| '_| | '_ \  "
echo " |_| \___/|_| \__, \___|___/\___/\___/__|\__|_| |_| .__/   "
echo "               |___/                               |_|      "
echo -e "${RESET}"
echo -e "  ${BOLD}Step 01 — Azure Container Registry Setup${RESET}"
echo ""
echo -e "  Environment  : ${CYAN}${ENV}${RESET}"
echo -e "  ACR name     : ${CYAN}${ACR_NAME}${RESET}"
echo -e "  Resource group: ${CYAN}${RG_NAME}${RESET}"
echo -e "  Location     : ${CYAN}${LOCATION}${RESET}"
echo -e "  Dry run      : ${CYAN}${DRY_RUN}${RESET}"
echo ""

# =============================================================================
# 1. Pre-flight checks
# =============================================================================
log_step "1. Pre-flight checks"

# Azure CLI
if ! command -v az &>/dev/null; then
    log_error "Azure CLI not found. Install: winget install Microsoft.AzureCLI"
    exit 1
fi
AZ_VERSION=$(az version --query '"azure-cli"' -o tsv 2>/dev/null)
log_ok "Azure CLI ${AZ_VERSION}"

# Logged in
CURRENT_ACCOUNT=$(az account show --query "[name, id]" -o tsv 2>/dev/null || true)
if [[ -z "${CURRENT_ACCOUNT}" ]]; then
    log_error "Not logged in. Run: az login"
    exit 1
fi
log_ok "Logged in: $(az account show --query name -o tsv)"

# Set subscription
run az account set --subscription "${SUBSCRIPTION_ID}"
log_ok "Subscription: $(az account show --query name -o tsv 2>/dev/null || echo ${SUBSCRIPTION_ID})"

# Get current user OID
MY_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
if [[ -z "${MY_OID}" ]]; then
    log_error "Could not get current user object ID. Check az login."
    exit 1
fi
log_ok "Signed-in user OID: ${MY_OID}"

# Enable Defender for Containers (S360 requirement)
log_info "Enabling Microsoft Defender for Containers (S360)..."
run az security pricing create --name Containers --tier Standard
DEFENDER_TIER=$(az security pricing show --name Containers --query pricingTier -o tsv 2>/dev/null || echo "unknown")
log_ok "Defender for Containers: ${DEFENDER_TIER}"

# =============================================================================
# 2. Resource group
# =============================================================================
log_step "2. Resource group: ${RG_NAME}"

if rg_exists "${RG_NAME}"; then
    log_ok "Already exists — skipping"
else
    log_info "Creating resource group..."
    run az group create \
        --name "${RG_NAME}" \
        --location "${LOCATION}" \
        --tags \
            platform=forge \
            environment="${ENV}" \
            component=acr \
            owner="${OWNER_ALIAS}" \
            managedBy=bootstrap
    log_ok "Created: ${RG_NAME}"
fi

# =============================================================================
# 3. Azure Container Registry (Premium, temporarily public for image push)
# =============================================================================
log_step "3. Azure Container Registry: ${ACR_NAME}"

if acr_exists "${ACR_NAME}"; then
    log_ok "Already exists — skipping creation"
else
    # Detect current public IP so we can restrict temporary public access
    # to only this machine rather than opening to all.
    MY_PUBLIC_IP=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || echo "")

    log_info "Creating ACR (Premium SKU, zone-redundant)..."
    log_warn "Public access is temporarily enabled (restricted to this machine IP) for the initial image push."
    log_warn "It will be fully disabled after the VNet private endpoint is in place (00-bootstrap.sh Phase 6)."

    run az acr create \
        --resource-group "${RG_NAME}" \
        --name "${ACR_NAME}" \
        --sku Premium \
        --location "${LOCATION}" \
        --admin-enabled false \
        --public-network-enabled true \
        --zone-redundancy Enabled \
        --retention-days 365 \
        --tags \
            platform=forge \
            environment="${ENV}" \
            component=acr \
            owner="${OWNER_ALIAS}" \
            managedBy=bootstrap

    # Restrict public access to current IP only
    if [[ -n "${MY_PUBLIC_IP}" ]]; then
        log_info "Restricting temporary public access to: ${MY_PUBLIC_IP}"
        run az acr network-rule add \
            --name "${ACR_NAME}" \
            --resource-group "${RG_NAME}" \
            --ip-address "${MY_PUBLIC_IP}"
        run az acr update \
            --name "${ACR_NAME}" \
            --resource-group "${RG_NAME}" \
            --default-action Deny
        log_ok "ACR public access restricted to ${MY_PUBLIC_IP} only"
    else
        log_warn "Could not detect public IP — ACR is temporarily open (lock down after image push using --public-network-enabled false)"
    fi

    log_ok "ACR created: ${ACR_LOGIN_SERVER}"
fi

# Geo-replication (production only)
if [[ "${ENV}" == "prod" ]]; then
    log_info "Checking geo-replication to ${LOCATION_SECONDARY}..."
    REPLICATION_STATE=$(az acr replication list \
        --registry "${ACR_NAME}" \
        --resource-group "${RG_NAME}" \
        --query "[?location=='${LOCATION_SECONDARY}'].provisioningState" -o tsv 2>/dev/null || echo "")

    if [[ "${REPLICATION_STATE}" == "Succeeded" ]]; then
        log_ok "Geo-replication already active: ${LOCATION_SECONDARY}"
    else
        log_info "Enabling geo-replication to ${LOCATION_SECONDARY}..."
        run az acr replication create \
            --registry "${ACR_NAME}" \
            --resource-group "${RG_NAME}" \
            --location "${LOCATION_SECONDARY}" \
            --zone-redundancy Enabled \
            --tags platform=forge environment="${ENV}"
        log_ok "Geo-replication created (may take a few minutes to reach Succeeded)"
    fi
fi

# Retrieve ACR resource ID for role assignments
ACR_ID=$(az acr show \
    --name "${ACR_NAME}" \
    --resource-group "${RG_NAME}" \
    --query id -o tsv)
log_info "ACR resource ID: ${ACR_ID}"

# =============================================================================
# 4. Build managed identity
# =============================================================================
log_step "4. Platform managed identity: ${MI_NAME}"

if mi_exists "${MI_NAME}" "${RG_NAME}"; then
    log_ok "Already exists — skipping"
else
    log_info "Creating managed identity..."
    run az identity create \
        --name "${MI_NAME}" \
        --resource-group "${RG_NAME}" \
        --location "${LOCATION}" \
        --tags \
            platform=forge \
            environment="${ENV}" \
            component=acr-build-identity \
            owner="${OWNER_ALIAS}"
    log_ok "Created: ${MI_NAME}"
fi

MI_PRINCIPAL=$(az identity show \
    --name "${MI_NAME}" \
    --resource-group "${RG_NAME}" \
    --query principalId -o tsv 2>/dev/null || echo "")

MI_CLIENT_ID=$(az identity show \
    --name "${MI_NAME}" \
    --resource-group "${RG_NAME}" \
    --query clientId -o tsv 2>/dev/null || echo "")

log_info "Platform MI principal ID : ${MI_PRINCIPAL}"
log_info "Platform MI client ID    : ${MI_CLIENT_ID}"

# =============================================================================
# 5. Role assignments
# =============================================================================
log_step "5. Role assignments"

# Allow up to 30s for the managed identity to propagate to Azure AD before assigning
if [[ "${DRY_RUN}" == false && -n "${MI_PRINCIPAL}" ]]; then
    log_info "Waiting for managed identity to propagate..."
    for i in {1..6}; do
        if az ad sp show --id "${MI_PRINCIPAL}" &>/dev/null; then
            log_ok "Managed identity propagated"
            break
        fi
        [[ $i -lt 6 ]] && sleep 5
    done
fi

assign_role() {
    local principal="$1" role="$2" scope="$3" label="$4"
    if [[ -n "${principal}" ]] && role_assigned "${principal}" "${role}" "${scope}"; then
        log_ok "${role} already assigned to ${label}"
    else
        log_info "Assigning ${role} to ${label}..."
        run az role assignment create \
            --assignee "${principal}" \
            --role "${role}" \
            --scope "${scope}"
        log_ok "${role} → ${label}"
    fi
}

# Platform identity: AcrPush + AcrPull (for CI/CD image builds)
if [[ -n "${MI_PRINCIPAL}" ]]; then
    assign_role "${MI_PRINCIPAL}" "AcrPush" "${ACR_ID}" "platform identity"
    assign_role "${MI_PRINCIPAL}" "AcrPull" "${ACR_ID}" "platform identity"
fi

# Current user: AcrPush (for the initial manual image push in Step 02)
assign_role "${MY_OID}" "AcrPush" "${ACR_ID}" "current user (initial image push)"
assign_role "${MY_OID}" "AcrPull" "${ACR_ID}" "current user"

# =============================================================================
# 6. Validate
# =============================================================================
log_step "6. Validate"

PASS=0; FAIL=0

check() {
    local label="$1"; shift
    if eval "$@" &>/dev/null; then
        log_ok "${label}"
        ((PASS++)) || true
    else
        log_warn "FAIL: ${label}"
        ((FAIL++)) || true
    fi
}

check "Resource group exists" \
    "az group show --name '${RG_NAME}' --query name -o tsv | grep -q '${RG_NAME}'"

check "ACR exists (Premium)" \
    "az acr show --name '${ACR_NAME}' --resource-group '${RG_NAME}' \
        --query \"sku.name\" -o tsv | grep -q 'Premium'"

check "ACR admin account disabled" \
    "az acr show --name '${ACR_NAME}' --resource-group '${RG_NAME}' \
        --query adminUserEnabled -o tsv | grep -q false"

check "Platform managed identity exists" \
    "az identity show --name '${MI_NAME}' --resource-group '${RG_NAME}' --query name -o tsv"

check "Defender for Containers is Standard" \
    "az security pricing show --name Containers --query pricingTier -o tsv | grep -q Standard"

if [[ -n "${MI_PRINCIPAL}" ]]; then
    check "Platform identity has AcrPush" \
        "role_assigned '${MI_PRINCIPAL}' 'AcrPush' '${ACR_ID}'"
    check "Platform identity has AcrPull" \
        "role_assigned '${MI_PRINCIPAL}' 'AcrPull' '${ACR_ID}'"
fi

check "Current user has AcrPush" \
    "role_assigned '${MY_OID}' 'AcrPush' '${ACR_ID}'"

echo ""
echo -e "${BOLD}──────────────────────────────────────────────────${RESET}"
echo -e "${BOLD} Result: ${GREEN}${PASS} passed${RESET}${BOLD}  |  ${RED}${FAIL} failed${RESET}"
echo -e "${BOLD}──────────────────────────────────────────────────${RESET}"

if [[ "${FAIL}" -gt 0 ]]; then
    log_warn "Some checks failed. Review output above and rerun the script."
    exit 1
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
log_ok "ACR setup complete."
echo ""
echo -e "${BOLD}Resources created:${RESET}"
echo -e "  Resource group  : ${CYAN}${RG_NAME}${RESET}"
echo -e "  ACR             : ${CYAN}${ACR_LOGIN_SERVER}${RESET}"
echo -e "  Managed identity: ${CYAN}${MI_NAME}${RESET}"
echo -e "  Identity client : ${CYAN}${MI_CLIENT_ID}${RESET}"
echo ""
echo -e "${BOLD}Next step:${RESET}"
echo -e "  Build and push all images to ACR:"
echo -e "  ${CYAN}./scripts/bootstrap/build-and-push-images.sh --env ${ENV} --registry ${ACR_LOGIN_SERVER}${RESET}"
echo ""
echo -e "${YELLOW}NOTE:${RESET} ACR currently allows public access from this machine."
echo -e "      It will be locked to private-only after the VNet is in place (00-bootstrap.sh Phase 6)."
echo ""
