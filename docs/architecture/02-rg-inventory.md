# Forge Platform — Resource Group Inventory

> Complete list of every Azure resource created per environment, which resource group it lives in,
> why it exists, and what uses it.
> Example names use alias `prproddu`, environment `dev`.

---

## rg-forge-acr-prproddu — Shared Container Registry

One per alias. Not duplicated per environment.

| Resource | Name | Why it exists | Used by |
|---|---|---|---|
| Container Registry | `forgeacrprproddu` | Central image store for all custom platform images (Spark, Trino, Airflow, Portal, DQ). Private — public pull disabled. | AKS kubelet identities on both clusters pull images at pod startup |

---

## rg-forge-platform-prproddu-dev — Networking Foundation

Everything needed for connectivity. Must exist before any AKS cluster or PaaS service is deployed.

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 1 | Virtual Network | `vnet-forge-prproddu-dev` | Provides the private address space for all cluster nodes and private endpoints. Everything in the platform communicates over this VNet. | AKS nodes, private endpoints |
| 2 | Subnet | `snet-compute` | Isolated address space for compute cluster nodes. Separate subnet = separate NSG = separate blast radius from orchestration. | Compute AKS node VMSS |
| 3 | Subnet | `snet-orchestration` | Isolated address space for orchestration cluster nodes. | Orchestration AKS node VMSS |
| 4 | Subnet | `snet-private-endpoints` | Dedicated subnet for all private endpoint NICs. Keeps PE traffic isolated from node subnets. | ADLS, Key Vault, ACR private endpoints |
| 5 | Subnet | `snet-postgres` | Delegated subnet for PostgreSQL Flexible Server VNet Integration. Delegation (`Microsoft.DBforPostgreSQL/flexibleServers`) allows the managed service to join the VNet directly — no public IP needed. | PostgreSQL Flexible Server (`psql-forge-prproddu-dev`) |
| 6 | NSG | `nsg-snet-compute` | Network security group for the compute subnet. Controls inbound/outbound rules at subnet level. | Attached to `snet-compute` |
| 7 | NSG | `nsg-snet-orchestration` | Network security group for the orchestration subnet. | Attached to `snet-orchestration` |
| 8 | NSG | `nsg-snet-private-endpoints` | Network security group for the private endpoints subnet. | Attached to `snet-private-endpoints` |
| 9 | NSG | `nsg-snet-postgres` | Allows inbound 5432 from compute subnet only (HMS pods). All other inbound denied. | Attached to `snet-postgres` |
| 10 | Route Table | `rt-forge-prproddu-dev` | Custom route table — controls egress path for AKS nodes. Currently routes outbound via AKS load balancer; will route via Azure Firewall in prod. | Attached to compute + orchestration subnets |
| 11 | Private DNS Zone | `privatelink.blob.core.windows.net` | Resolves ADLS Blob FQDN to the private endpoint IP inside the VNet instead of the public Azure IP. Without this, blob access from pods would go over the internet. | ADLS Blob private endpoint, all pods using `wasbs://` |
| 12 | Private DNS Zone | `privatelink.dfs.core.windows.net` | Resolves ADLS DFS FQDN to private endpoint IP. DFS is the hierarchical namespace endpoint used by workload identities for RBAC-based ADLS access (`abfss://`). | ADLS DFS private endpoint, all pods using `abfss://` |
| 13 | Private DNS Zone | `privatelink.vaultcore.azure.net` | Resolves Key Vault FQDN to private endpoint IP. Without this, pods would fail to reach the vault (public network access is disabled on the vault). | Key Vault private endpoint, CSI driver, all pods reading secrets |
| 14 | Private DNS Zone | `privatelink.azurecr.io` | Resolves ACR FQDN to private endpoint IP. AKS nodes pull images from ACR — this ensures pulls go over the private network. | ACR private endpoint, AKS kubelet image pulls |
| 15 | Private DNS Zone | `privatelink.postgres.database.azure.com` | Resolves PostgreSQL Flexible Server FQDN to its VNet-integrated IP. Required for HMS pods to reach the server by hostname. | HMS pod (JDBC), postgres module |
| 16 | VNet Link (×5) | `vnetlink-blob`, `vnetlink-dfs`, `vnetlink-vault`, `vnetlink-acr`, `vnetlink-postgres` | Links each private DNS zone to the VNet so DNS queries from within the VNet are answered by the private zone, not public Azure DNS. | All pods and nodes doing DNS resolution |
| 17 | Private Endpoint | `pe-forgeacrprproddu-dev` | Connects the shared ACR into this environment's VNet. AKS nodes pull images via this endpoint — ACR has public access disabled. | AKS compute + orchestration kubelet |
| 18 | NIC | `nic-pe-forgeacrprproddu-dev` | Network interface card for the ACR private endpoint. Holds the private IP assigned inside `snet-private-endpoints`. | Azure networking — backing resource for the PE |
| 19 | Log Analytics Workspace | `law-forge-platform-prproddu-dev` | Diagnostic sink for platform-level network resources (NSG flow logs, VNet diagnostics). Kept separate from workload LAWs so network ops logs don't mix with application logs. | NSG diagnostics, VNet flow data |

---

## rg-forge-prproddu-dev — Platform Workloads

All compute, storage, identity, and observability resources. Deployed after the platform RG.

### Log Analytics Workspaces (deployed first — AKS preflight requires them)

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 1 | Log Analytics Workspace | `law-forge-compute-prproddu-dev` | Receives all logs and metrics from the compute AKS cluster. Separate from orchestration LAW so Spark/Trino operational noise doesn't interfere with Airflow/DQ alerting. | Compute AKS OMS agent, Defender, diagnostic settings |
| 2 | Log Analytics Workspace | `law-forge-orchestration-prproddu-dev` | Receives logs from the orchestration AKS cluster, ADLS access logs, and Key Vault audit logs. Acts as the primary operational sink for all non-compute workloads. | Orchestration AKS OMS agent, ADLS diagnostics, KV audit logs |

### Managed Identities — AKS Infrastructure

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 3 | Managed Identity | `id-aks-controlplane-compute-prproddu-dev` | AKS control plane needs its own identity to manage Azure resources on the cluster's behalf — creating load balancers, updating NIC configs, managing node RG resources. | AKS compute cluster control plane |
| 4 | Managed Identity | `id-aks-kubelet-compute-prproddu-dev` | Each compute cluster node runs under this identity to pull container images from ACR and access Azure Disk/node-level resources. Separate from control plane so a node compromise cannot affect cluster management operations. | Compute cluster node VMSS (kubelet) |
| 5 | Managed Identity | `id-aks-controlplane-orchestration-prproddu-dev` | Same as #3 but for the orchestration cluster control plane. | AKS orchestration cluster control plane |
| 6 | Managed Identity | `id-aks-kubelet-orchestration-prproddu-dev` | Same as #4 but for orchestration cluster nodes. | Orchestration cluster node VMSS (kubelet) |

### Managed Identities — Workloads

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 7 | Managed Identity | `id-forge-spark-prproddu-dev` | Spark executor pods need to read/write all storage layers and access Key Vault secrets (e.g., Hive Metastore credentials). Federated to the `spark` service account in the `spark-jobs` namespace on the compute cluster. | Spark Operator pods — ADLS Contributor on bronze/silver/gold/code/checkpoints, KV Secrets User |
| 8 | Managed Identity | `id-forge-trino-prproddu-dev` | Trino workers read gold and silver layers for BI/ad-hoc queries. Read-only access — Trino never writes data. Federated to the `trino` service account in the `trino` namespace. | Trino coordinator + worker pods — ADLS Reader on silver/gold, KV Secrets User |
| 9 | Managed Identity | `id-forge-airflow-prproddu-dev` | Airflow DAGs write raw data to bronze and read job scripts from code. Does not need access to silver/gold — it orchestrates the jobs that do. Federated to the `airflow` service account in the `airflow` namespace. | Airflow task pods — ADLS Contributor on bronze, Reader on code, KV Secrets User |
| 10 | Managed Identity | `id-forge-dq-prproddu-dev` | DQ runner reads from bronze, silver, and gold to validate data quality at each layer transition. Read-only — it validates, not transforms. Federated to `dq-runner` in `dq` namespace. | DQ framework pods — ADLS Reader on bronze/silver/gold, KV Secrets User |
| 11 | Managed Identity | `id-forge-portal-prproddu-dev` | Developer Portal API serves data from the gold layer to the UI. Read-only — the portal is a consumer, not a producer. Federated to `portal-api` in `portal` namespace. | Portal API pods — ADLS Reader on gold, KV Secrets User |

### Public IPs (deployed before AKS clusters)

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 12 | Public IP (Static) | `pip-aks-forge-compute-prproddu-dev-outbound` | AKS nodes need outbound internet access during bootstrapping (apt repos, Kubernetes components). Pre-created so we can apply `FirstPartyUsage=/NonProd` ipTag — required for S360 NS2.1.1. AKS auto-created IPs cannot have this tag applied. | Compute cluster outbound load balancer (SNAT) |
| 13 | Public IP (Static) | `pip-aks-forge-orchestration-prproddu-dev-outbound` | Same as #12 for the orchestration cluster. | Orchestration cluster outbound load balancer (SNAT) |

### AKS Clusters

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 14 | AKS Cluster | `aks-forge-compute-prproddu-dev` | Runs all elastic data processing workloads (Spark, Trino). Kept separate from orchestration so Spark OOM events or node scaling storms don't destabilise Airflow or the portal. Scales aggressively; isolated blast radius. | Spark Operator, Trino |
| 15 | AKS Cluster | `aks-forge-orchestration-prproddu-dev` | Runs stable, long-lived platform control services (Airflow, DQ, Portal). Always-on, sized conservatively. Triggers jobs on the compute cluster; does not run data processing itself. | Airflow, DQ runner, Developer Portal |

### Storage

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 16 | Storage Account (ADLS Gen2) | `forgeadlsprproddudev` | Central data lake — all pipeline data flows through this account. Hierarchical namespace enables folder-level RBAC without ABAC conditions. Public network access disabled. | All workloads via private endpoints |
| 17 | Storage Container | `bronze` | Immutable raw landing zone — source systems write here first, no transforms applied. Schema-on-read. Append-only by operational convention. | Airflow (write), Spark (read) |
| 18 | Storage Container | `silver` | Cleaned, schema-enforced, DQ-validated data. No record reaches silver without passing all DQ gates. Delta Lake format for ACID and time travel. | Spark (read/write), Trino (read) |
| 19 | Storage Container | `gold` | Aggregated, SLA-governed, consumer-ready. Read by BI tools, ML pipelines, and the Developer Portal. | Spark (write), Trino (read), Portal (read) |
| 20 | Storage Container | `code` | Spark job notebooks, JARs, and the `papermill_runner.py` entry point. Versioned by CI/CD — jobs always run the committed version of their notebook. | CI/CD (write), Spark (read) |
| 21 | Storage Container | `checkpoints` | Spark Structured Streaming checkpoint state. Required for exactly-once semantics on streaming jobs — stores offsets and micro-batch metadata. | Spark (read/write) |
| 22 | Private Endpoint | `pep-forgeadlsprproddudev-dfs` | Connects ADLS DFS sub-resource to the VNet. Pods use `abfss://` URIs — this endpoint resolves the FQDN to a private IP. ADLS public network access is disabled. | All pods using `abfss://` (Spark, Trino, Airflow, DQ, Portal) |
| 23 | NIC | `nic-pep-forgeadlsprproddudev-dfs` | Network interface for the DFS private endpoint. Holds the private IP inside `snet-private-endpoints`. Predictable name set via `customNetworkInterfaceName`. | Azure networking backing resource |
| 24 | Private Endpoint | `pep-forgeadlsprproddudev-blob` | Connects ADLS Blob sub-resource to the VNet. Required for legacy blob API compatibility (`wasbs://`) and some Azure SDK code paths that use the blob endpoint even with hierarchical namespace. | Spark (legacy blob access), Azure SDK internals |
| 25 | NIC | `nic-pep-forgeadlsprproddudev-blob` | Network interface for the Blob private endpoint. | Azure networking backing resource |

### Key Vault

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 26 | Key Vault | `kv-forge-prproddu-dev` | Single source of truth for all secrets. RBAC-authorized — no legacy access policies. Premium SKU for HSM-backed keys. Public network access disabled. | CSI driver mounts secrets into pods; Airflow KV secrets backend; platform admin group manages secrets |
| 27 | Private Endpoint | `pep-kv-forge-prproddu-dev` | Connects Key Vault to the VNet. Pods reach the vault via this endpoint — public access is disabled so there is no other path. | All pods via CSI driver, Airflow secrets backend |
| 28 | NIC | `nic-pep-kv-forge-prproddu-dev` | Network interface for the Key Vault private endpoint. | Azure networking backing resource |

### PostgreSQL (Hive Metastore backend)

| # | Resource | Name | Why it exists | Used by |
|---|---|---|---|---|
| 29 | PostgreSQL Flexible Server | `psql-forge-prproddu-dev` | Metadata backend for Hive Metastore. HMS stores all table registrations (name → ADLS path, schema, partition info) here. Uses VNet Integration — no public access. | Hive Metastore pod (JDBC on port 5432) |
| 30 | Database | `hms_db` | The HMS schema database. Schema DDL is applied by HMS `schemaInit` on first startup. | Hive Metastore |

---

## rg-mc-compute-prproddu-dev — AKS Compute Node RG (auto-created)

Created and managed by AKS. Do not manually modify resources in this group.

| Resource | Why it exists |
|---|---|
| VMSS (`aks-systempool-*`) | Virtual machine scale set backing the system node pool |
| VMSS (`aks-sparkpool-*`) | Virtual machine scale set backing the Spark node pool (scales to zero) |
| VMSS (`aks-trinopool-*`) | Virtual machine scale set backing the Trino node pool (scales to zero) |
| Load Balancer (outbound) | Uses the pre-created `pip-aks-forge-compute-prproddu-dev-outbound` IP for SNAT egress |
| Managed Disks | OS disks for each node — ephemeral where supported |
| NICs | One per node — connected to `snet-compute` |

---

## rg-mc-orch-prproddu-dev — AKS Orchestration Node RG (auto-created)

| Resource | Why it exists |
|---|---|
| VMSS (`aks-systempool-*`) | System node pool VMSS |
| VMSS (`aks-workerpool-*`) | Worker node pool VMSS |
| Load Balancer (outbound) | Uses `pip-aks-forge-orchestration-prproddu-dev-outbound` for SNAT |
| Managed Disks | OS disks per node |
| NICs | One per node — connected to `snet-orchestration` |

---

## Resource Count Summary

| Resource Group | Customer-managed resources |
|---|---|
| `rg-forge-acr-prproddu` | 1 |
| `rg-forge-platform-prproddu-dev` | 16 |
| `rg-forge-prproddu-dev` | 28 |
| `rg-mc-compute-prproddu-dev` | AKS-managed (do not touch) |
| `rg-mc-orch-prproddu-dev` | AKS-managed (do not touch) |
| **Total** | **~45 resources per environment** |
