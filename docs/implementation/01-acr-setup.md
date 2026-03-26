# Forge — ACR Setup Guide

> **Document:** 01 — Azure Container Registry Setup
> **Version:** 1.0
> **Status:** Production
> **Audience:** Platform engineers
> **Last updated:** 2026-03-24

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io)

---

## Table of Contents

1. [Why ACR Is Set Up First](#1-why-acr-is-set-up-first)
2. [Prerequisites](#2-prerequisites)
3. [Create the ACR Resource Group](#3-create-the-acr-resource-group)
4. [Create Azure Container Registry (Premium SKU)](#4-create-azure-container-registry-premium-sku)
5. [Enable Geo-Replication (Production Only)](#5-enable-geo-replication-production-only)
6. [Configure Private Endpoint for ACR](#6-configure-private-endpoint-for-acr)
7. [Configure Private DNS Zone](#7-configure-private-dns-zone)
8. [Disable Public Network Access](#8-disable-public-network-access)
9. [Enable Defender for Containers](#9-enable-defender-for-containers)
10. [Enable Content Trust — Notation/Notary v2](#10-enable-content-trust--notationnotary-v2)
11. [Create Platform Managed Identity](#11-create-platform-managed-identity)
12. [Assign AcrPush to the Build Identity](#12-assign-acrpush-to-the-build-identity)
13. [Assign AcrPull to AKS Node Pool Identities](#13-assign-acrpull-to-aks-node-pool-identities)
14. [Test ACR Connectivity](#14-test-acr-connectivity)
15. [Bicep Resource Snippets](#15-bicep-resource-snippets)

---

## 1. Why ACR Is Set Up First

Every container that runs on the Forge platform is pulled exclusively from ACR. No cluster node is ever permitted to pull from DockerHub, gcr.io, ghcr.io, quay.io, or any other public registry. This is a hard S360 compliance requirement and a supply-chain security control.

The practical consequence is that ACR must exist, be accessible from the private VNet, and have the correct role assignments in place **before** either AKS cluster is provisioned. The AKS node pools need AcrPull permission granted on the registry at cluster creation time — or shortly after, before any workload pod is scheduled. If ACR does not exist when the clusters are created, every pod that tries to pull an image will fail with an `ImagePullBackOff` error.

The setup order is therefore:

```
1. Networking (VNet, subnets, NSGs, private DNS zones)
2. ACR (this document)
3. AKS clusters (document 03)
4. Platform services (Airflow, Spark Operator, etc.)
```

ACR also must be reachable from the build agent that runs image import pipelines. The private endpoint and DNS configuration done in this guide establishes that reachability.

---

## 2. Prerequisites

Before running any command in this guide:

- Azure CLI version 2.57.0 or later: `az version`
- You are logged in with an identity that has **Contributor** and **User Access Administrator** on the target subscription: `az account show`
- The target subscription and tenant are set: `az account set --subscription "<subscription-id>"`
- The networking resources (VNet, private-endpoints subnet, private DNS zones link) are deployed. Specifically, the subnet `snet-forge-pe-{env}` in `vnet-forge-{env}` must exist before you can create the private endpoint.
- Define these shell variables once and reuse them throughout:

```bash
# Set once — adjust for your environment
ENV="prod"                                   # dev | prod
LOCATION="northcentralus"
LOCATION_SECONDARY="westus2"                 # prod only, for geo-replication
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
VNET_RG="rg-forge-network-${ENV}"
VNET_NAME="vnet-forge-${ENV}"
PE_SUBNET_NAME="snet-forge-pe-${ENV}"
ACR_RG="rg-forge-acr-${ENV}"
ACR_NAME="forgeacr${ENV}"                  # must be globally unique, lowercase, no hyphens
DNS_ZONE_NAME="privatelink.azurecr.io"
DNS_ZONE_RG="rg-forge-dns-${ENV}"
BUILD_MI_NAME="id-forge-${ENV}"
```

---

## 3. Create the ACR Resource Group

ACR lives in its own resource group, separate from networking and from the AKS clusters. This isolation makes it straightforward to audit ACR-scoped access, apply targeted locks, and delete or recreate the registry without touching other resources.

```bash
az group create \
  --name "rg-forge-acr-${ENV}" \
  --location "${LOCATION}" \
  --tags \
    platform=forge \
    environment="${ENV}" \
    component=acr \
    managed-by=bicep \
    owner=platform-team
```

Verify:

```bash
az group show --name "rg-forge-acr-${ENV}" --query "{name:name, location:location, state:properties.provisioningState}" -o table
```

Expected output:

```
Name                  Location    State
--------------------  ----------  ---------
rg-forge-acr-prod   northcentralus      Succeeded
```

---

## 4. Create Azure Container Registry (Premium SKU)

Premium SKU is required for:
- Private endpoints
- Geo-replication
- Content trust / Notary v2
- Retention policies
- Customer-managed keys (future)

```bash
az acr create \
  --resource-group "rg-forge-acr-${ENV}" \
  --name "${ACR_NAME}" \
  --sku Premium \
  --location "${LOCATION}" \
  --admin-enabled false \
  --public-network-enabled false \
  --zone-redundancy Enabled \
  --retention-days 365 \
  --tags \
    platform=forge \
    environment="${ENV}" \
    component=acr \
    managed-by=bicep \
    owner=platform-team
```

**Key flags explained:**

- `--admin-enabled false` — The admin account is a shared credential that cannot be audited per-user. Disabled permanently. All access goes through managed identities and service principals.
- `--public-network-enabled false` — Immediately locks the registry to VNet-only access. The private endpoint created in the next step provides the actual access path.
- `--zone-redundancy Enabled` — Distributes registry storage across availability zones. Requires Premium SKU and a zone-enabled region.
- `--retention-days 365` — Retains tagged images for a minimum of 365 days. Untagged manifests are swept by a separate retention policy.

Retrieve the ACR resource ID (used in subsequent role assignments):

```bash
ACR_ID=$(az acr show \
  --name "${ACR_NAME}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --query id -o tsv)

echo "ACR ID: ${ACR_ID}"
```

---

## 5. Enable Geo-Replication (Production Only)

For production, the registry is replicated to a secondary Azure region. This ensures images are available for DR failover and reduces pull latency if workloads run in the secondary region.

```bash
# Run for ENV=prod only
az acr replication create \
  --registry "${ACR_NAME}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --location "${LOCATION_SECONDARY}" \
  --zone-redundancy Enabled \
  --tags \
    platform=forge \
    environment="${ENV}"
```

Check replication status:

```bash
az acr replication list \
  --registry "${ACR_NAME}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --output table
```

Wait until `PROVISIONING STATE` shows `Succeeded` for both the primary and secondary replications before proceeding. This typically takes 2–5 minutes.

---

## 6. Configure Private Endpoint for ACR

The private endpoint places a private NIC for ACR in the `snet-forge-pe-{env}` subnet. All traffic from the AKS clusters and build agents to ACR flows through this private IP — never over the public internet.

```bash
# Retrieve the subnet resource ID
PE_SUBNET_ID=$(az network vnet subnet show \
  --resource-group "${VNET_RG}" \
  --vnet-name "${VNET_NAME}" \
  --name "${PE_SUBNET_NAME}" \
  --query id -o tsv)

# Create the private endpoint
az network private-endpoint create \
  --name "pe-forge-acr-${ENV}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --location "${LOCATION}" \
  --subnet "${PE_SUBNET_ID}" \
  --private-connection-resource-id "${ACR_ID}" \
  --group-id registry \
  --connection-name "plsc-forge-acr-${ENV}" \
  --tags \
    platform=forge \
    environment="${ENV}" \
    component=acr-private-endpoint
```

Verify the endpoint is provisioned:

```bash
az network private-endpoint show \
  --name "pe-forge-acr-${ENV}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --query "{name:name, provisioningState:provisioningState, networkInterfaces:networkInterfaces[0].id}" \
  -o table
```

Retrieve the private IP assigned to the endpoint (you will need this for the DNS A record):

```bash
PE_NIC_ID=$(az network private-endpoint show \
  --name "pe-forge-acr-${ENV}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --query "networkInterfaces[0].id" -o tsv)

PE_PRIVATE_IP=$(az network nic show \
  --ids "${PE_NIC_ID}" \
  --query "ipConfigurations[0].privateIPAddress" -o tsv)

echo "ACR private endpoint IP: ${PE_PRIVATE_IP}"
```

---

## 7. Configure Private DNS Zone

For pods and nodes inside the VNet to resolve `forgeacr${ENV}.azurecr.io` to the private endpoint IP (rather than ACR's public IP), a private DNS zone must be configured with an A record pointing to the endpoint.

### 7a. Create the private DNS zone (if not already present)

If you have a centralised private DNS zone resource group (`rg-forge-dns-{env}`), the zone may already exist from the networking setup. Check first:

```bash
az network private-dns zone show \
  --resource-group "${DNS_ZONE_RG}" \
  --name "${DNS_ZONE_NAME}" \
  --query name -o tsv 2>/dev/null \
  || echo "Zone does not exist — creating"
```

If the zone does not exist:

```bash
az network private-dns zone create \
  --resource-group "${DNS_ZONE_RG}" \
  --name "${DNS_ZONE_NAME}" \
  --tags \
    platform=forge \
    environment="${ENV}"
```

### 7b. Link the DNS zone to the VNet

```bash
az network private-dns link vnet create \
  --resource-group "${DNS_ZONE_RG}" \
  --zone-name "${DNS_ZONE_NAME}" \
  --name "link-forge-vnet-${ENV}" \
  --virtual-network "${VNET_NAME}" \
  --registration-enabled false \
  --tags \
    platform=forge \
    environment="${ENV}"
```

`--registration-enabled false` — DNS auto-registration of VM hostnames is disabled. Only the explicit A records we create below are registered.

### 7c. Create A records for the registry

ACR Premium exposes two DNS names per registry: the registry itself and the data endpoint (used for layer pulls). Both need A records.

```bash
# Registry endpoint (login and manifest operations)
az network private-dns record-set a add-record \
  --resource-group "${DNS_ZONE_RG}" \
  --zone-name "${DNS_ZONE_NAME}" \
  --record-set-name "${ACR_NAME}" \
  --ipv4-address "${PE_PRIVATE_IP}"

# Data endpoint (layer blob pulls — same IP, different hostname)
az network private-dns record-set a add-record \
  --resource-group "${DNS_ZONE_RG}" \
  --zone-name "${DNS_ZONE_NAME}" \
  --record-set-name "${ACR_NAME}.${LOCATION}.data" \
  --ipv4-address "${PE_PRIVATE_IP}"
```

### 7d. Verify DNS resolution from inside the VNet

From a VM or container in the VNet (e.g., via Azure Bastion on a jump VM):

```bash
nslookup forgeacr${ENV}.azurecr.io
# Expected: returns 10.3.0.7 (or whatever the PE IP is) — not a public Microsoft IP
```

From outside the VNet (your workstation), the same lookup should time out or fail — confirming public access is blocked.

---

## 8. Disable Public Network Access

The registry was created with `--public-network-enabled false`. Verify this is still the case and confirm no IP allow-list rules exist that would open a public path:

```bash
az acr update \
  --name "${ACR_NAME}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --public-network-enabled false

az acr show \
  --name "${ACR_NAME}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --query "{publicNetworkAccess:publicNetworkAccess, networkRuleBypassOptions:networkRuleBypassOptions}" \
  -o json
```

Expected output:

```json
{
  "publicNetworkAccess": "Disabled",
  "networkRuleBypassOptions": "AzureServices"
}
```

`networkRuleBypassOptions: AzureServices` permits Microsoft-first-party services (Defender for Containers, Azure Monitor) to reach the registry over the Azure backbone for scanning and monitoring. This is not a public internet path.

---

## 9. Enable Defender for Containers

Microsoft Defender for Containers scans every image pushed to ACR for OS-level and language-level CVEs. Scan results appear in Microsoft Defender for Cloud and are surfaced as security recommendations.

Enable at the subscription level (covers all registries in the subscription):

```bash
az security pricing create \
  --name Containers \
  --tier Standard
```

Verify the plan is active:

```bash
az security pricing show --name Containers --query "{name:name, pricingTier:pricingTier}" -o table
```

Confirm that the specific ACR registry is monitored:

```bash
az security assessment list \
  --query "[?contains(resourceDetails.id, '${ACR_NAME}')].[displayName, status.code]" \
  -o table
```

After the first image push, Defender performs an initial scan within 5 minutes. Subsequent scans run on every new push and on a weekly schedule.

---

## 10. Enable Content Trust — Notation/Notary v2

Forge uses Notation (the CNCF Notary v2 reference implementation) for image signing. Signed images provide a cryptographic guarantee that what was scanned and approved by the build pipeline is exactly what gets deployed — no tag mutation, no substitution.

### 10a. Enable OCI artifact support on the registry

Notation stores signatures as OCI artifacts attached to image manifests. ACR Premium supports this natively. No special flag is needed — it is enabled by default on Premium SKU.

Verify:

```bash
az acr show \
  --name "${ACR_NAME}" \
  --resource-group "rg-forge-acr-${ENV}" \
  --query "policies.exportPolicy.status" -o tsv
```

### 10b. Install Notation CLI (on the build agent)

```bash
# On the build agent (Linux)
NOTATION_VERSION="1.1.0"
curl -Lo notation.tar.gz \
  "https://github.com/notaryproject/notation/releases/download/v${NOTATION_VERSION}/notation_${NOTATION_VERSION}_linux_amd64.tar.gz"
tar -xzf notation.tar.gz
sudo mv notation /usr/local/bin/notation
notation version
```

### 10c. Enforce signed images via OPA Gatekeeper

Image signature enforcement is done in the cluster using OPA Gatekeeper and the Azure Image Integrity add-on. See document `03-cluster-setup.md`, Part 3 for the cluster-side Gatekeeper configuration. The ACR side requires no additional configuration beyond ensuring Premium SKU and the notation signer having AcrPush on the registry (covered in Section 12).

---

## 11. Create Platform Managed Identity

Forge uses a single user-assigned managed identity per environment — `id-forge-{env}` — shared by all platform workloads (Spark, Trino, Airflow, Portal, DQ) and the build pipeline. This eliminates identity sprawl while maintaining full auditability.

```bash
az identity create \
  --name "${BUILD_MI_NAME}" \
  --resource-group "rg-forge-platform-${ENV}" \
  --location "${LOCATION}" \
  --tags \
    platform=forge \
    environment="${ENV}" \
    component=platform-identity

# Capture the identity's principal ID and client ID
MI_PRINCIPAL_ID=$(az identity show \
  --name "${BUILD_MI_NAME}" \
  --resource-group "rg-forge-platform-${ENV}" \
  --query principalId -o tsv)

MI_CLIENT_ID=$(az identity show \
  --name "${BUILD_MI_NAME}" \
  --resource-group "rg-forge-platform-${ENV}" \
  --query clientId -o tsv)

echo "Platform MI Principal ID: ${MI_PRINCIPAL_ID}"
echo "Platform MI Client ID:    ${MI_CLIENT_ID}"
```

---

## 12. Assign AcrPush to the Build Identity

The build managed identity needs AcrPush to push images and AcrPull to pull base images during multi-stage builds.

```bash
# AcrPush — write images to the registry
az role assignment create \
  --assignee "${MI_PRINCIPAL_ID}" \
  --role "AcrPush" \
  --scope "${ACR_ID}"

# AcrPull — pull base images during build
az role assignment create \
  --assignee "${MI_PRINCIPAL_ID}" \
  --role "AcrPull" \
  --scope "${ACR_ID}"
```

If your build pipeline uses a service principal rather than a managed identity (e.g., Azure DevOps service connection backed by a service principal):

```bash
# Replace with your SP's object ID
SP_OBJECT_ID="<service-principal-object-id>"

az role assignment create \
  --assignee "${SP_OBJECT_ID}" \
  --role "AcrPush" \
  --scope "${ACR_ID}"

az role assignment create \
  --assignee "${SP_OBJECT_ID}" \
  --role "AcrPull" \
  --scope "${ACR_ID}"
```

Verify assignments:

```bash
az role assignment list \
  --scope "${ACR_ID}" \
  --query "[].{principal:principalName, role:roleDefinitionName}" \
  -o table
```

---

## 13. Assign AcrPull to AKS Node Pool Identities

AKS node pools pull images during pod scheduling. Each node pool has a kubelet managed identity that the node uses to authenticate to ACR. This identity must have AcrPull on the registry **before** pods are scheduled — if not, every pod that references a private image will fail with `ImagePullBackOff`.

At this stage of setup (before AKS clusters are provisioned), you cannot yet retrieve the kubelet identity object IDs. There are two approaches:

**Option A — Pre-create the kubelet managed identities** and reference them in the AKS Bicep module. This is the recommended approach in Forge because it makes role assignments declarative in Bicep.

**Option B — Assign after cluster creation.** Run the commands below after the clusters are provisioned (covered in document `03-cluster-setup.md`).

The commands are the same either way. When the cluster identities are known, run:

```bash
# Compute cluster — kubelet identity
COMPUTE_KUBELET_MI=$(az aks show \
  --name "aks-forge-compute-${ENV}" \
  --resource-group "rg-forge-compute-${ENV}" \
  --query identityProfile.kubeletidentity.objectId -o tsv)

az role assignment create \
  --assignee "${COMPUTE_KUBELET_MI}" \
  --role "AcrPull" \
  --scope "${ACR_ID}"

# Orchestration cluster — kubelet identity
ORCH_KUBELET_MI=$(az aks show \
  --name "aks-forge-orch-${ENV}" \
  --resource-group "rg-forge-orch-${ENV}" \
  --query identityProfile.kubeletidentity.objectId -o tsv)

az role assignment create \
  --assignee "${ORCH_KUBELET_MI}" \
  --role "AcrPull" \
  --scope "${ACR_ID}"
```

Verify both assignments exist:

```bash
az role assignment list \
  --scope "${ACR_ID}" \
  --role "AcrPull" \
  --query "[].{principal:principalName, principalId:principalId}" \
  -o table
```

---

## 14. Test ACR Connectivity

Run these tests from a machine that is either:
- Inside the VNet (via Azure Bastion on a jump VM), or
- On the corporate network connected via ExpressRoute/VPN

From a public workstation with no VPN, all these commands should fail — which is correct behaviour.

### 14a. Log in to ACR using the Azure CLI

```bash
az acr login --name "${ACR_NAME}"
```

Expected output: `Login Succeeded`

If this fails with `UNAUTHORIZED` or a network error, check:
- DNS resolution: `nslookup ${ACR_NAME}.azurecr.io` should return a private IP
- Private endpoint provisioning state: `az network private-endpoint show --name pe-forge-acr-${ENV} --resource-group rg-forge-acr-${ENV} --query provisioningState -o tsv`
- Role assignment: confirm AcrPull is assigned to your identity

### 14b. Pull, tag, and push a test image

```bash
# Pull hello-world from public registry (run this before locking down outbound on the jump VM)
docker pull hello-world:latest

# Tag it for ACR
docker tag hello-world:latest ${ACR_NAME}.azurecr.io/test/hello-world:latest

# Push to ACR
docker push ${ACR_NAME}.azurecr.io/test/hello-world:latest
```

Expected output for push:

```
The push refers to repository [forgeacr-prod.azurecr.io/test/hello-world]
e07ee1baac5f: Pushed
latest: digest: sha256:<hash> size: 525
```

### 14c. Verify the image appears in ACR

```bash
az acr repository list \
  --name "${ACR_NAME}" \
  --output table

az acr repository show-tags \
  --name "${ACR_NAME}" \
  --repository test/hello-world \
  --output table
```

### 14d. Verify Defender scan triggered

```bash
az security assessment list \
  --query "[?contains(resourceDetails.id, '${ACR_NAME}') && status.code=='Unhealthy'].[displayName, status.cause]" \
  -o table
```

If the registry has no CVEs, the assessment list will be empty. If there are findings, review them — test images do not need to be clean, but production images pushed by the build pipeline must pass Microsoft Defender for Containers pre-screening before they reach ACR.

### 14e. Clean up the test image

```bash
az acr repository delete \
  --name "${ACR_NAME}" \
  --repository test/hello-world \
  --yes
```

---

## 15. Bicep Resource Snippets

These snippets are the declarative equivalent of the CLI commands above. They are already covered in `infra/bicep/modules/` — reference them there.

### 15a. ACR resource

```hcl
resource "azurerm_container_registry" "acr" {
  name                          = var.acr_name
  resource_group_name           = azurerm_resource_group.acr.name
  location                      = var.location
  sku                           = "Premium"
  admin_enabled                 = false
  public_network_access_enabled = false
  zone_redundancy_enabled       = true

  retention_policy {
    days    = 365
    enabled = true
  }

  trust_policy {
    enabled = true
  }

  network_rule_bypass_option = "AzureServices"

  tags = local.common_tags
}
```

### 15b. Geo-replication (production only)

```hcl
resource "azurerm_container_registry_replication" "secondary" {
  count                   = var.environment == "prod" ? 1 : 0
  name                    = var.location_secondary
  container_registry_id   = azurerm_container_registry.acr.id
  location                = var.location_secondary
  zone_redundancy_enabled = true

  tags = local.common_tags
}
```

### 15c. Private endpoint

```hcl
resource "azurerm_private_endpoint" "acr" {
  name                = "pe-forge-acr-${var.environment}"
  resource_group_name = azurerm_resource_group.acr.name
  location            = var.location
  subnet_id           = var.private_endpoint_subnet_id

  private_service_connection {
    name                           = "plsc-forge-acr-${var.environment}"
    private_connection_resource_id = azurerm_container_registry.acr.id
    subresource_names              = ["registry"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "acr-dns-zone-group"
    private_dns_zone_ids = [var.acr_private_dns_zone_id]
  }

  tags = local.common_tags
}
```

### 15d. Private DNS zone and VNet link

```hcl
resource "azurerm_private_dns_zone" "acr" {
  name                = "privatelink.azurecr.io"
  resource_group_name = var.dns_resource_group_name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "acr" {
  name                  = "link-forge-vnet-${var.environment}"
  resource_group_name   = var.dns_resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.acr.name
  virtual_network_id    = var.vnet_id
  registration_enabled  = false
  tags                  = local.common_tags
}
```

### 15e. AcrPull role assignment for AKS node pools

```hcl
resource "azurerm_role_assignment" "acr_pull_compute" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = var.compute_cluster_kubelet_identity_object_id
}

resource "azurerm_role_assignment" "acr_pull_orch" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = var.orch_cluster_kubelet_identity_object_id
}
```

### 15f. AcrPush role assignment for build identity

```hcl
resource "azurerm_user_assigned_identity" "acr_build" {
  name                = "id-forge-${var.environment}"
  resource_group_name = azurerm_resource_group.acr.name
  location            = var.location
  tags                = local.common_tags
}

resource "azurerm_role_assignment" "acr_push_build" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.acr_build.principal_id
}

resource "azurerm_role_assignment" "acr_pull_build" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.acr_build.principal_id
}
```

### 15g. Module variables (`variables.tf`)

```hcl
variable "acr_name" {
  description = "Globally unique name for the Azure Container Registry (lowercase, no hyphens)"
  type        = string
}

variable "environment" {
  description = "Deployment environment: dev or prod"
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be 'dev' or 'prod'."
  }
}

variable "location" {
  description = "Primary Azure region"
  type        = string
  default     = "northcentralus"
}

variable "location_secondary" {
  description = "Secondary Azure region for geo-replication (prod only)"
  type        = string
  default     = "westus2"
}

variable "private_endpoint_subnet_id" {
  description = "Resource ID of the private endpoints subnet"
  type        = string
}

variable "acr_private_dns_zone_id" {
  description = "Resource ID of the privatelink.azurecr.io private DNS zone"
  type        = string
}

variable "vnet_id" {
  description = "Resource ID of the platform VNet (for DNS zone VNet link)"
  type        = string
}

variable "dns_resource_group_name" {
  description = "Resource group name containing the private DNS zones"
  type        = string
}

variable "compute_cluster_kubelet_identity_object_id" {
  description = "Object ID of the compute AKS cluster kubelet managed identity"
  type        = string
}

variable "orch_cluster_kubelet_identity_object_id" {
  description = "Object ID of the orchestration AKS cluster kubelet managed identity"
  type        = string
}
```

### 15h. Module outputs (`outputs.tf`)

```hcl
output "acr_id" {
  description = "Resource ID of the Azure Container Registry"
  value       = azurerm_container_registry.acr.id
}

output "acr_login_server" {
  description = "Login server URL for the registry"
  value       = azurerm_container_registry.acr.login_server
}

output "acr_build_identity_client_id" {
  description = "Client ID of the build managed identity (used by CI pipelines)"
  value       = azurerm_user_assigned_identity.acr_build.client_id
}

output "acr_build_identity_principal_id" {
  description = "Principal ID of the build managed identity"
  value       = azurerm_user_assigned_identity.acr_build.principal_id
}

output "acr_private_dns_zone_id" {
  description = "Resource ID of the ACR private DNS zone"
  value       = azurerm_private_dns_zone.acr.id
}
```

---

## Summary Checklist

Before proceeding to document `03-cluster-setup.md`, verify every item:

- [ ] Resource group `rg-forge-acr-{env}` exists in `northcentralus`
- [ ] Registry `forgeacr{env}` is Premium SKU with admin account disabled
- [ ] Geo-replication to `westus2` is in `Succeeded` state (prod only)
- [ ] Private endpoint `pe-forge-acr-{env}` is provisioned and has a private IP
- [ ] DNS zone `privatelink.azurecr.io` has A records for registry and data endpoints
- [ ] VNet link from the DNS zone to `vnet-forge-{env}` is active
- [ ] `nslookup forgeacr{env}.azurecr.io` from inside VNet returns a private IP
- [ ] Public network access is `Disabled`
- [ ] Defender for Containers is `Standard` tier at subscription level
- [ ] Managed identity `id-forge-{env}` exists with AcrPush + AcrPull
- [ ] `az acr login` succeeds from inside VNet
- [ ] Test image push and delete completed successfully
- [ ] ACR resources confirmed in `infra/bicep/modules/`
