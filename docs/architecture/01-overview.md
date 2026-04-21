# Forge Platform — Architecture Overview

> Infrastructure reference for the Forge data platform.
> For design principles and developer workflow see [DESIGN.md](../DESIGN.md).
> For a full resource inventory per resource group see [02-rg-inventory.md](02-rg-inventory.md).

---

## 1. Resource Groups

Two resource groups per environment, one shared ACR group per alias:

| # | Resource Group | Contents |
|---|---|---|
| 1 | `rg-forge-platform-{alias}-{env}` | VNet, subnets, NSGs, route tables, private DNS zones, platform LAW, ACR private endpoint |
| 2 | `rg-forge-{alias}-{env}` | AKS clusters, ADLS Gen2, Key Vault, managed identities, compute + orchestration LAWs |
| — | `rg-forge-acr-{alias}` | Shared ACR — one per alias, not duplicated per environment |
| — | `rg-mc-{purpose}-{alias}-{env}` | AKS node resource group — auto-created by AKS for VMSS, load balancers, NICs, disks |

---

## 2. Networking

All resources live in `rg-forge-platform-{alias}-{env}`.

### 2.1 Virtual Network

`vnet-forge-{alias}-{env}` — single VNet containing all subnets.

| Subnet | Used by |
|---|---|
| `snet-compute` | Compute AKS nodes |
| `snet-orchestration` | Orchestration AKS nodes |
| `snet-private-endpoints` | All private endpoints (ADLS, Key Vault, ACR) |

Network plugin: **Azure CNI Overlay** with **Calico** network policy. Pod and service CIDRs are non-overlapping between clusters:

| Cluster | Pod CIDR | Service CIDR |
|---|---|---|
| Compute | `10.100.0.0/16` | `10.200.0.0/16` |
| Orchestration | `10.101.0.0/16` | `10.201.0.0/16` |

### 2.2 Private DNS Zones

| Zone | Resolves |
|---|---|
| `privatelink.blob.core.windows.net` | ADLS Blob endpoint → private IP |
| `privatelink.dfs.core.windows.net` | ADLS DFS endpoint → private IP |
| `privatelink.vaultcore.azure.net` | Key Vault endpoint → private IP |
| `privatelink.azurecr.io` | ACR endpoint → private IP |

### 2.3 Private Endpoints

All data plane services are unreachable from public internet. Pods resolve service FQDNs to private IPs via the DNS zones above.

| Endpoint | Service | Sub-resource | Location |
|---|---|---|---|
| `pe-forgeacr{alias}-{env}` | ACR | `registry` | `rg-forge-platform-{alias}-{env}` |
| `pep-forgeadls{alias}{env}-dfs` | ADLS Gen2 | `dfs` | `rg-forge-{alias}-{env}` |
| `pep-forgeadls{alias}{env}-blob` | ADLS Gen2 | `blob` | `rg-forge-{alias}-{env}` |
| `pep-kv-forge-{alias}-{env}` | Key Vault | `vault` | `rg-forge-{alias}-{env}` |

Each endpoint has a predictably named NIC: `nic-{endpoint-name}`.

### 2.4 Public IPs

AKS clusters use pre-created static public IPs for outbound SNAT. Required because AKS auto-created IPs cannot have `FirstPartyUsage` ipTags applied (S360 NS2.1.1).

| Resource | Cluster | ipTag |
|---|---|---|
| `pip-aks-forge-compute-{alias}-{env}-outbound` | Compute | `/NonProd` (dev) · `/Prod` (prod) |
| `pip-aks-forge-orchestration-{alias}-{env}-outbound` | Orchestration | `/NonProd` (dev) · `/Prod` (prod) |

AKS API server has a separate Microsoft-managed public IP — not taggable by customers.

---

## 3. AKS Clusters

Two clusters per environment, both in `rg-forge-{alias}-{env}`.

| Cluster | Name | Purpose |
|---|---|---|
| Compute | `aks-forge-compute-{alias}-{env}` | Spark Operator, Trino |
| Orchestration | `aks-forge-orchestration-{alias}-{env}` | Airflow, DQ runner, Portal API |

### 3.1 Node Pools

**Compute cluster:**

| Pool | VM Size | Min | Max | Workload |
|---|---|---|---|---|
| `systempool` | Standard_D4s_v5 | 1 | 2 | System addons only (tainted `CriticalAddonsOnly`) |
| `sparkpool` | Standard_E8s_v5 | 0 | 5 (dev) | Spark executors — memory-optimised |
| `trinopool` | Standard_D4s_v5 | 0 | 3 (dev) | Trino workers |

**Orchestration cluster:**

| Pool | VM Size | Min | Max | Workload |
|---|---|---|---|---|
| `systempool` | Standard_D4s_v5 | 1 | 2 | System addons only (tainted `CriticalAddonsOnly`) |
| `workerpool` | Standard_D4s_v5 | 1 | 3 (dev) | Airflow, DQ, Portal |

Spark and Trino pools scale to zero when idle. Node taints + labels ensure workloads land only on their designated pool.

### 3.2 Security Configuration

| Feature | Setting | What it does |
|---|---|---|
| AAD-managed RBAC | `managed: true`, `enableAzureRBAC: true` | K8s permissions via Azure role assignments — no separate RBAC manifests |
| No local accounts | `disableLocalAccounts: true` | Static `--admin` certs disabled; only AAD auth works (S360) |
| Admin AAD group | `adminGroupObjectIDs` | Platform team group → `AKS RBAC Cluster Admin` |
| Workload Identity | `oidcIssuerProfile` + `securityProfile.workloadIdentity` | Pods get Azure tokens via OIDC federation — no secrets anywhere |
| Key Vault CSI | `azureKeyvaultSecretsProvider` addon | Mounts KV secrets into pods as in-memory volumes |
| Defender for Containers | `securityProfile.defender` | Runtime threat detection → Log Analytics |
| Image Cleaner | `imageCleaner` every 48h | Removes unused node images, reduces CVE surface |
| Azure Policy addon | `azurePolicy: enabled` | OPA Gatekeeper policies enforced at admission |
| Auto-upgrade | `patch` channel + `NodeImage` OS | Auto patches Kubernetes and node OS |

### 3.3 AAD Roles for Engineers

| Role | Access level |
|---|---|
| `AKS RBAC Cluster Admin` | Full cluster |
| `AKS RBAC Admin` | Manage resources within a namespace |
| `AKS RBAC Writer` | Deploy workloads, no RBAC changes |
| `AKS RBAC Reader` | Read-only `kubectl get/describe` |

**One-time setup per engineer:**
```bash
az aks get-credentials --resource-group rg-forge-prproddu-dev --name aks-forge-compute-prproddu-dev
kubelogin convert-kubeconfig -l azurecli
kubectl get nodes
```

---

## 4. Storage (ADLS Gen2)

Storage account `forgeadls{alias}{env}` in `rg-forge-{alias}-{env}`.

| Container | Purpose | Who writes | Who reads |
|---|---|---|---|
| `bronze` | Raw ingested data, immutable source of truth | Airflow | Spark |
| `silver` | Cleaned, schema-enforced, DQ-validated | Spark | Spark, Trino |
| `gold` | Aggregated, consumer-ready, SLA-governed | Spark | Trino, Portal |
| `code` | Spark driver scripts (`spark/jobs/`), DQ rule YAML files (`dq/rules/`), and Structured Streaming checkpoints (`checkpoints/<pipeline_id>/`) | CI/CD, sync-jobs.sh | Spark, ForgeDqGateOperator |

Role assignments are scoped per container — not storage account scope. No ABAC conditions needed.

---

## 5. Managed Identities

9 identities per environment, all in `rg-forge-{alias}-{env}`.

### 5.1 AKS Infrastructure (4)

| Identity | Used by |
|---|---|
| `id-aks-controlplane-compute-{alias}-{env}` | Compute cluster control plane — manages load balancers, NICs in VNet |
| `id-aks-kubelet-compute-{alias}-{env}` | Compute cluster nodes — pulls images from ACR, accesses node disk |
| `id-aks-controlplane-orchestration-{alias}-{env}` | Orchestration cluster control plane |
| `id-aks-kubelet-orchestration-{alias}-{env}` | Orchestration cluster nodes |

### 5.2 Workload Identities (5)

Each is federated to a Kubernetes service account via OIDC — no secrets anywhere.

| Identity | K8s Service Account | Storage Access | KV |
|---|---|---|---|
| `id-forge-spark-{alias}-{env}` | `spark` in `spark-jobs` | Contributor: bronze, silver, gold, code | Secrets User |
| `id-forge-trino-{alias}-{env}` | `trino` in `trino` | Reader: silver, gold | Secrets User |
| `id-forge-airflow-{alias}-{env}` | `airflow` in `airflow` | Contributor: bronze · Reader: code | Secrets User |
| `id-forge-dq-{alias}-{env}` | `dq-runner` in `dq` | Reader: bronze, silver, gold | Secrets User |
| `id-forge-portal-{alias}-{env}` | `portal-api` in `portal` | Reader: gold | Secrets User |

---

## 6. Key Vault

`kv-forge-{alias}-{env}` in `rg-forge-{alias}-{env}`.

| Setting | Value |
|---|---|
| SKU | Premium (HSM-backed) |
| Authorization | RBAC |
| Soft-delete | 90 days |
| Purge protection | Enabled |
| Public network access | Disabled — private endpoint only |

Role assignments:
- Platform admin group → `Key Vault Secrets Officer` + `Key Vault Crypto Officer`
- Each workload identity → `Key Vault Secrets User`

> Subscription policy blocks `DeletedVaultPurge`. If the RG is deleted, the vault name is reserved for 90 days — recover via portal or use a different name.

---

## 7. Observability

All in `rg-forge-{alias}-{env}` except Platform LAW.

| Workspace | Where | What feeds into it |
|---|---|---|
| `law-forge-compute-{alias}-{env}` | `rg-forge-*` | Compute AKS: apiserver, audit, scheduler, controller logs; Defender; OMS metrics |
| `law-forge-orchestration-{alias}-{env}` | `rg-forge-*` | Orchestration AKS logs; ADLS diagnostics; Key Vault audit logs |
| `law-forge-platform-{alias}-{env}` | `rg-forge-platform-*` | VNet flow data, NSG diagnostics |

AKS diagnostic categories enabled on both clusters: `kube-apiserver`, `kube-audit`, `kube-audit-admin`, `kube-controller-manager`, `kube-scheduler`, `cluster-autoscaler`, `cloud-controller-manager`, `AllMetrics`.

Microsoft Defender for Containers enabled at **subscription scope** — covers all AKS clusters and ACRs.

---

## 8. Known Subscription Quirks

| Issue | Detail |
|---|---|
| `kvSecretsUserRoleId` ends in `e6` | Verify: `az role definition list --name "Key Vault Secrets User" --query "[].name"` |
| `DeletedVaultPurge` blocked | Subscription policy prevents purging soft-deleted Key Vaults |
| `az aks command invoke` broken | Returns `Operation returned an invalid status 'OK'` — known bug with `aks-preview` extension |
| Corp network DNS | Public AKS FQDN resolves to private IP on corp network — use `kubelogin` |
| `enablePrivateCluster` immutable | Cannot change private↔public after cluster creation without full cluster recreation |
