# Forge — Networking Setup

> **Document:** 00 — VNet, Subnets, NSGs, Private DNS Zones
> **Version:** 1.0
> **Status:** Production
> **Audience:** Platform engineers
> **Run before:** All other steps. Nothing else can be provisioned until this is done.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Set Shell Variables](#3-set-shell-variables)
4. [Create the Platform Resource Group](#4-create-the-platform-resource-group)
5. [Create the VNet](#5-create-the-vnet)
6. [Create NSGs](#6-create-nsgs)
7. [Create Subnets](#7-create-subnets)
8. [Create Private DNS Zones](#8-create-private-dns-zones)
9. [Verify](#9-verify)

---

## 1. Overview

All Forge infrastructure is private — no cluster, storage account, or registry has a public endpoint. Everything connects over a single VNet per environment via private endpoints and internal DNS.

This guide provisions:

| Resource | dev | prod |
|----------|-----|------|
| Resource group | `rg-forge-platform-dev` | `rg-forge-platform-prod` |
| VNet | `vnet-forge-dev` (`10.0.0.0/12`) | `vnet-forge-prod` (`10.16.0.0/12`) |
| Compute subnet | `10.1.0.0/16` | `10.17.0.0/16` |
| Orchestration subnet | `10.2.0.0/16` | `10.18.0.0/16` |
| Private endpoints subnet | `10.3.0.0/24` | `10.19.0.0/24` |
| App Gateway subnet | `10.4.0.0/24` | `10.20.0.0/24` |
| Bastion subnet | `10.5.0.0/24` | `10.21.0.0/24` |
| Private DNS zones | 7 zones linked to VNet | same |

---

## 2. Prerequisites

- Azure CLI ≥ 2.57: `az version`
- Logged in with **Contributor** + **User Access Administrator** on the subscription
- Correct subscription set: `az account set --subscription "<subscription-id>"`

---

## 3. Set Shell Variables

Set these once. All commands below reference them.

```bash
ENV="dev"                    # change to "prod" for production
LOCATION="westcentralus"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
RG="rg-forge-platform-${ENV}"
VNET_NAME="vnet-forge-${ENV}"

# Address spaces — dev uses 10.x.x.x, prod uses 10.1x.x.x
if [ "${ENV}" = "dev" ]; then
  VNET_PREFIX="10.0.0.0/12"
  COMPUTE_PREFIX="10.1.0.0/16"
  ORCH_PREFIX="10.2.0.0/16"
  PE_PREFIX="10.3.0.0/24"
  APPGW_PREFIX="10.4.0.0/24"
  BASTION_PREFIX="10.5.0.0/24"
else
  VNET_PREFIX="10.16.0.0/12"
  COMPUTE_PREFIX="10.17.0.0/16"
  ORCH_PREFIX="10.18.0.0/16"
  PE_PREFIX="10.19.0.0/24"
  APPGW_PREFIX="10.20.0.0/24"
  BASTION_PREFIX="10.21.0.0/24"
fi
```

---

## 4. Create the Platform Resource Group

This RG holds VNet, NSGs, private DNS zones, ADLS, Key Vault, Managed Grafana, and Azure Monitor.

```bash
az group create \
  --name "${RG}" \
  --location "${LOCATION}" \
  --tags \
    platform=forge \
    environment="${ENV}" \
    component=platform \
    managed-by=bicep \
    owner=platform-team
```

Verify:
```bash
az group show --name "${RG}" --query "{name:name, location:location, state:properties.provisioningState}" -o table
```

---

## 5. Create the VNet

```bash
az network vnet create \
  --resource-group "${RG}" \
  --name "${VNET_NAME}" \
  --location "${LOCATION}" \
  --address-prefixes "${VNET_PREFIX}" \
  --tags \
    platform=forge \
    environment="${ENV}" \
    managed-by=bicep
```

---

## 6. Create NSGs

Create one NSG per subnet that needs inbound restrictions. The private endpoints subnet and cluster subnets get dedicated NSGs.

### Compute cluster NSG

```bash
az network nsg create \
  --resource-group "${RG}" \
  --name "nsg-forge-compute-${ENV}" \
  --location "${LOCATION}" \
  --tags platform=forge environment="${ENV}"

# Allow inbound from VNet only (deny all other inbound)
az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-compute-${ENV}" \
  --name "Allow-VNet-Inbound" \
  --priority 100 \
  --direction Inbound \
  --access Allow \
  --protocol "*" \
  --source-address-prefixes VirtualNetwork \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "*"

az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-compute-${ENV}" \
  --name "Deny-All-Inbound" \
  --priority 4096 \
  --direction Inbound \
  --access Deny \
  --protocol "*" \
  --source-address-prefixes "*" \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "*"
```

### Orchestration cluster NSG

```bash
az network nsg create \
  --resource-group "${RG}" \
  --name "nsg-forge-orch-${ENV}" \
  --location "${LOCATION}" \
  --tags platform=forge environment="${ENV}"

az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-orch-${ENV}" \
  --name "Allow-VNet-Inbound" \
  --priority 100 \
  --direction Inbound \
  --access Allow \
  --protocol "*" \
  --source-address-prefixes VirtualNetwork \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "*"

az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-orch-${ENV}" \
  --name "Deny-All-Inbound" \
  --priority 4096 \
  --direction Inbound \
  --access Deny \
  --protocol "*" \
  --source-address-prefixes "*" \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "*"
```

### Private endpoints NSG

```bash
az network nsg create \
  --resource-group "${RG}" \
  --name "nsg-forge-pe-${ENV}" \
  --location "${LOCATION}" \
  --tags platform=forge environment="${ENV}"

# Only VNet traffic allowed inbound to PE subnet
az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-pe-${ENV}" \
  --name "Allow-VNet-Inbound" \
  --priority 100 \
  --direction Inbound \
  --access Allow \
  --protocol "*" \
  --source-address-prefixes VirtualNetwork \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "*"

az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-pe-${ENV}" \
  --name "Deny-All-Inbound" \
  --priority 4096 \
  --direction Inbound \
  --access Deny \
  --protocol "*" \
  --source-address-prefixes "*" \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "*"
```

### App Gateway NSG

```bash
az network nsg create \
  --resource-group "${RG}" \
  --name "nsg-forge-appgw-${ENV}" \
  --location "${LOCATION}" \
  --tags platform=forge environment="${ENV}"

# HTTPS inbound from internet
az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-appgw-${ENV}" \
  --name "Allow-HTTPS-Inbound" \
  --priority 100 \
  --direction Inbound \
  --access Allow \
  --protocol Tcp \
  --source-address-prefixes Internet \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges 443

# Required by Azure: GatewayManager health probes
az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-appgw-${ENV}" \
  --name "Allow-GatewayManager" \
  --priority 110 \
  --direction Inbound \
  --access Allow \
  --protocol Tcp \
  --source-address-prefixes GatewayManager \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "65200-65535"

# Required by Azure: Load balancer probes
az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "nsg-forge-appgw-${ENV}" \
  --name "Allow-AzureLoadBalancer" \
  --priority 120 \
  --direction Inbound \
  --access Allow \
  --protocol "*" \
  --source-address-prefixes AzureLoadBalancer \
  --source-port-ranges "*" \
  --destination-address-prefixes "*" \
  --destination-port-ranges "*"
```

---

## 7. Create Subnets

### Compute cluster subnet

```bash
az network vnet subnet create \
  --resource-group "${RG}" \
  --vnet-name "${VNET_NAME}" \
  --name "snet-forge-compute" \
  --address-prefix "${COMPUTE_PREFIX}" \
  --network-security-group "nsg-forge-compute-${ENV}"
```

### Orchestration cluster subnet

```bash
az network vnet subnet create \
  --resource-group "${RG}" \
  --vnet-name "${VNET_NAME}" \
  --name "snet-forge-orch" \
  --address-prefix "${ORCH_PREFIX}" \
  --network-security-group "nsg-forge-orch-${ENV}"
```

### Private endpoints subnet

> Private endpoint NICs do not support NSG rules at the NIC level — the NSG on the subnet still applies for subnet-level enforcement, but `privateEndpointNetworkPolicies` must be disabled.

```bash
az network vnet subnet create \
  --resource-group "${RG}" \
  --vnet-name "${VNET_NAME}" \
  --name "snet-forge-pe-${ENV}" \
  --address-prefix "${PE_PREFIX}" \
  --network-security-group "nsg-forge-pe-${ENV}" \
  --private-endpoint-network-policies Disabled
```

### Application Gateway subnet

```bash
az network vnet subnet create \
  --resource-group "${RG}" \
  --vnet-name "${VNET_NAME}" \
  --name "snet-forge-appgw" \
  --address-prefix "${APPGW_PREFIX}" \
  --network-security-group "nsg-forge-appgw-${ENV}"
```

### Bastion subnet

> Azure requires the name to be exactly `AzureBastionSubnet`.

```bash
az network vnet subnet create \
  --resource-group "${RG}" \
  --vnet-name "${VNET_NAME}" \
  --name "AzureBastionSubnet" \
  --address-prefix "${BASTION_PREFIX}"
```

---

## 8. Create Private DNS Zones

Create all zones upfront. They are linked to the VNet now; private endpoints created later auto-register in the correct zone.

```bash
DNS_ZONES=(
  "privatelink.azurecr.io"
  "privatelink.dfs.core.windows.net"
  "privatelink.blob.core.windows.net"
  "privatelink.vaultcore.azure.net"
  "privatelink.postgres.database.azure.com"
  "privatelink.monitor.azure.com"
)

for ZONE in "${DNS_ZONES[@]}"; do
  echo "Creating DNS zone: ${ZONE}"
  az network private-dns zone create \
    --resource-group "${RG}" \
    --name "${ZONE}"

  echo "Linking ${ZONE} to ${VNET_NAME}"
  az network private-dns link vnet create \
    --resource-group "${RG}" \
    --zone-name "${ZONE}" \
    --name "link-${VNET_NAME}" \
    --virtual-network "${VNET_NAME}" \
    --registration-enabled false
done
```

This takes 2–4 minutes. Each zone link enables any resource in the VNet to resolve private endpoint FQDNs (e.g. `forgeacrdev.azurecr.io` → `10.3.0.7`).

---

## 9. Verify

```bash
# VNet and subnets
az network vnet show \
  --resource-group "${RG}" \
  --name "${VNET_NAME}" \
  --query "{name:name, addressSpace:addressSpace.addressPrefixes}" -o table

az network vnet subnet list \
  --resource-group "${RG}" \
  --vnet-name "${VNET_NAME}" \
  --query "[].{name:name, prefix:addressPrefix, nsg:networkSecurityGroup.id}" -o table

# Private DNS zones
az network private-dns zone list \
  --resource-group "${RG}" \
  --query "[].{name:name}" -o table
```

Expected output (dev):
```
Subnets:
Name                    Prefix          NSG
----------------------  --------------  --------
snet-forge-compute      10.1.0.0/16     set
snet-forge-orch         10.2.0.0/16     set
snet-forge-pe-dev       10.3.0.0/24     set
snet-forge-appgw        10.4.0.0/24     set
AzureBastionSubnet      10.5.0.0/24     -

DNS Zones (7):
privatelink.azurecr.io
privatelink.dfs.core.windows.net
privatelink.blob.core.windows.net
privatelink.vaultcore.azure.net
privatelink.postgres.database.azure.com
privatelink.monitor.azure.com
```

---

**Next step → [01-acr-setup.md](./01-acr-setup.md)**
