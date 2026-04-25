# Forge — Networking Architecture

> **Version:** 1.1
> **Status:** Active
> **Audience:** Platform engineers, network engineers, security architects
> **Last updated:** 2026-04-09

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io)

---

## Table of Contents

1. [Networking Philosophy](#1-networking-philosophy)
2. [Full Network Topology Diagram](#2-full-network-topology-diagram)
3. [VNet Design and Subnet Sizing](#3-vnet-design-and-subnet-sizing)
4. [AKS Networking: Azure CNI Overlay](#4-aks-networking-azure-cni-overlay)
5. [Private AKS Clusters](#5-private-aks-clusters)
6. [Private Endpoints: Full Inventory](#6-private-endpoints-full-inventory)
7. [DNS Resolution Flow](#7-dns-resolution-flow)
8. [Application Gateway: WAF and Ingress](#8-application-gateway-waf-and-ingress)
9. [Azure Bastion: Operational Access](#9-azure-bastion-operational-access)
10. [Calico Network Policies](#10-calico-network-policies)
11. [NSG Rules](#11-nsg-rules)
12. [Cross-Cluster Communication](#12-cross-cluster-communication)

---

## 1. Networking Philosophy

Forge's network design is built on three constraints:

**Public ingress via ingress-nginx, TLS via Let's Encrypt.** Both AKS clusters expose public LoadBalancer IPs. Portal and Trino are served over HTTPS (port 443) terminated by ingress-nginx with Let's Encrypt certificates issued via cert-manager. Spark Connect (port 15002) and Hive Metastore Thrift (port 9083) are exposed as raw TCP on the compute cluster LoadBalancer. NSG rules on the compute subnet allow these ports from Internet. The orchestration cluster subnet has no subnet-level NSG — public access is controlled by the AKS node NSG only. Application Gateway WAF is planned for production but not deployed in dev.

**Private endpoints for all PaaS services.** Every Azure managed service is accessed via a private endpoint with a private IP in the VNet. DNS resolution for those services returns the private IP, not the public Microsoft backbone IP. There is no exception to this rule.

**Clusters are sovereign.** Each AKS cluster has no direct network path to the other. Cross-cluster coordination happens only through shared data stores (ADLS Gen2, Key Vault) accessed via private endpoints. The only intentional cross-cluster connection is Airflow reaching the compute cluster's Kubernetes API server — a specific, controlled path with explicit network policy approval.

---

## 2. Full Network Topology Diagram

```
Internet
  │
  ├── HTTPS :443  ──────────────────────────────────────────────────────────────┐
  │                                                                             │
  │   ┌──────────────────────────────────────────────────────────────────────┐ │
  │   │  DNS: forge-portal-{env}.northcentralus.cloudapp.azure.com             │ │
  │   │  Public LB IP: assigned by Azure at deploy time                      │ │
  │   │  ingress-nginx → TLS terminated (cert-manager / Let's Encrypt)       │ │
  │   │                                                                      │ │
  │   │    /oauth2/*    → portal-auth-proxy:8080  (Flask OAuth2 proxy)       │ │
  │   │    /api/*       → portal-api:8080          (FastAPI)                 │ │
  │   │    /*           → portal-web:3001          (Next.js)                 │ │
  │   └──────────────────────────────────────────────────────────────────────┘ │
  │                                                                             │
  └── HTTPS :443  ──────────────────────────────────────────────────────────────┼──┐
  │   TCP   :15002 ─────────────────────────────────────────────────────────────┼──┤
  │   TCP   :9083  ─────────────────────────────────────────────────────────────┼──┤
  │                                                                             │  │
  │   ┌──────────────────────────────────────────────────────────────────────┐    │
  │   │  DNS: forge-compute-{env}.northcentralus.cloudapp.azure.com            │    │
  │   │  Public LB IP: assigned by Azure at deploy time                      │    │
  │   │                                                                      │    │
  │   │  :443  ingress-nginx → TLS (cert-manager / Let's Encrypt)            │    │
  │   │    /*  → trino-auth-proxy:8080  (Flask OAuth2 proxy) → Trino         │    │
  │   │  :15002  LoadBalancer → Spark Connect (gRPC, TCP)                    │    │
  │   │  :9083   LoadBalancer → Hive Metastore Thrift (TCP)                  │    │
  │   └──────────────────────────────────────────────────────────────────────┘    │
  │                                                                                │
  └────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Azure Region: West Central US                                                       │
│                                                                                      │
│  vnet-forge-{env}  (dev: 10.0.0.0/12  |  prod: 10.16.0.0/12)                        │
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │  10.1.0.0/16  —  compute-cluster-subnet                                         │ │
│  │  NSG: nsg-forge-compute-dev — AllowHttpHttpsInbound (80,443,8080,9083,15002)     │ │
│  │                                                                                  ││
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  ││
│  │  │  aks-forge-compute-{env}  (AKS cluster, public LB — IP assigned at deploy)  │  │ │
│  │  ││                                                                           │  ││
│  │  │  Node Pool: system   (1–3 × Standard_D4s_v5, CriticalAddonsOnly taint)    │  ││
│  │  │  Node Pool: spark    (0–20 × Standard_E8s_v5, spot)                       │  ││
│  │  │  Node Pool: trino    (2–8 × Standard_E16s_v5)                             │  ││
│  │  ││                                                                           │  ││
│  │  │  Pod CIDR (overlay):  192.168.0.0/16   (does not consume VNet space)       │  ││
│  │  ││  Service CIDR:        172.20.0.0/16                                       │  ││
│  │  ││                                                                           │  ││
│  │  ││  Namespaces:                                                              │  ││
│  │  ││    trino          — trino-auth-proxy, trino coordinator, trino workers    │  ││
│  │  ││    spark-system   — spark-operator, spark-connect                         │  ││
│  │  ││    spark-jobs     — driver/executor pods (ephemeral)                      │  ││
│  │  ││    hive-metastore — HMS server                                            │  ││
│  │  ││    cert-manager   — cert-manager v1.17.1 (ACME HTTP-01, LB probe /healthz)│  ││
│  │  ││    ingress-nginx  — ingress controller (public LB, IP assigned at deploy)  │  ││
│  │  ││                                                                           │  ││
│  │  │  Azure Monitor Agent DaemonSet ────────────────────────────────────────────┼──┼──┼──▶ Azure Monitor / Log Analytics
│  │  └────────────────────────────────────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │  10.2.0.0/16  —  orchestration-cluster-subnet                                   │ │
│  │  (No subnet-level NSG — public access via AKS node NSG only)                    │ │
│  │                                                                                  ││
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  ││
│  │  │  aks-forge-orchestration-{env}  (AKS cluster, public LB — IP assigned at deploy) │  │ │
│  │  ││                                                                           │  ││
│  │  │  Node Pool: system    (1–3 × Standard_D4s_v5)                              │  ││
│  │  │  Node Pool: airflow   (2–10 × Standard_D8s_v5)                             │  ││
│  │  │  Node Pool: platform  (1–4 × Standard_D4s_v5)                              │  ││
│  │  ││                                                                           │  ││
│  │  │  Pod CIDR (overlay):  192.169.0.0/16   (does not consume VNet space)       │  ││
│  │  ││  Service CIDR:        172.21.0.0/16                                       │  ││
│  │  ││                                                                           │  ││
│  │  ││  Namespaces:                                                              │  ││
│  │  ││    airflow        — scheduler, webserver, workers (KubernetesExecutor)    │  ││
│  │  ││    portal         — portal-auth-proxy, portal-api, portal-web             │  ││
│  │  ││    ingress-nginx  — ingress controller (public LB, IP assigned at deploy)  │  ││
│  │  ││    monitoring     — azure-monitor-agent, otel-collector                   │  ││
│  │  └────────────────────────────────────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │  10.3.0.0/24  —  private-endpoints-subnet  (NSG: inbound from VNet CIDR only)   │  │
│  │                                                                                  ││
│  │  10.3.0.4   — ADLS Gen2 (dfs endpoint)       privatelink.dfs.core.windows.net   │ │
│  │  10.3.0.5   — ADLS Gen2 (blob endpoint)      privatelink.blob.core.windows.net  │ │
│  │  10.3.0.6   — Key Vault                       privatelink.vaultcore.azure.net    ││
│  │  10.3.0.7   — Azure Container Registry        privatelink.azurecr.io             ││
│  │  10.3.0.8   — PostgreSQL (Airflow metadata)   privatelink.postgres.database...   ││
│  │  10.3.0.9   — Microsoft Purview               privatelink.purview.azure.com      ││
│  │  10.3.0.10  — Azure Monitor (metrics)         privatelink.monitor.azure.com      ││
│  │  10.3.0.11  — (reserved for Compute AKS API server, prod private cluster only)   ││
│  │  10.3.0.12  — (reserved for Orch AKS API server, prod private cluster only)      ││
│  │  10.3.0.13  — Azure DevOps (agent outbound)   (service endpoint, not PE)         ││
│  │                                                                                  ││
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │  10.5.0.0/24  —  bastion-subnet  (AzureBastionSubnet — name is fixed by Azure)  │ │
│  │                                                                                  ││
│  │  Azure Bastion (Standard tier)                                                   ││
│  │    Provides RDP/SSH to VMs in the VNet without public IPs on VMs                 ││
│  │    Used for: emergency node shell access, jump to private resources             │ │
│  │                                                                                  ││
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│  Private DNS Zones (linked to vnet-forge-{env}):                                     │
│    privatelink.dfs.core.windows.net        → 10.3.0.4                                │
│    privatelink.blob.core.windows.net       → 10.3.0.5                                │
│    privatelink.vaultcore.azure.net         → 10.3.0.6                                │
│    privatelink.azurecr.io                  → 10.3.0.7                                │
│    privatelink.postgres.database.azure.com → 10.3.0.8, 10.3.0.9                     │
│    privatelink.monitor.azure.com           → 10.3.0.10                               │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘

Traffic flows (dev):
  Internet :443  → ingress-nginx (orch LB, forge-portal-{env}.northcentralus.cloudapp.azure.com) → portal-auth-proxy / portal-api / portal-web
  Internet :443  → ingress-nginx (compute LB, forge-compute-{env}.northcentralus.cloudapp.azure.com) → trino-auth-proxy → Trino
  Internet :15002 → Spark Connect (compute LB, TCP)
  Internet :9083  → Hive Metastore Thrift (compute LB, TCP)
  Corp VPN → Bastion → node shell (emergency only)
  Airflow (orch cluster) → Compute AKS API server private endpoint (10.3.0.11)
  Any pod → ADLS/KV/ACR/PostgreSQL → private endpoint (10.3.0.x)
```

---

## 3. VNet Design and Subnet Sizing

### 3.1 One VNet Per Environment

Each environment (dev, prod) has its own dedicated VNet. Dev and prod VNets are **completely independent** — they share no subnets, no peering, no private DNS zone links. This enforces environment isolation at the network layer: a misconfigured dev workload cannot reach prod data under any circumstances.

| Environment | VNet name | Address space |
|-------------|-----------|--------------|
| dev | `vnet-forge-dev` | `10.0.0.0/12` (10.0.0.0 – 10.15.255.255) |
| prod | `vnet-forge-prod` | `10.16.0.0/12` (10.16.0.0 – 10.31.255.255) |

Using non-overlapping `/12` blocks means both VNets can be peered to a corporate hub VNet (ExpressRoute / VPN gateway) without address conflicts if that becomes a requirement. Each `/12` still provides over 1 million IP addresses — far more than needed.

### 3.2 Subnet Allocation Per Environment

Subnets use the same relative offsets in each environment. Only the first octet block differs:

| Subnet | dev CIDR | prod CIDR | Purpose |
|--------|----------|-----------|---------|
| `snet-forge-compute` | `10.1.0.0/16` | `10.17.0.0/16` | AKS compute cluster nodes |
| `snet-forge-orch` | `10.2.0.0/16` | `10.18.0.0/16` | AKS orchestration cluster nodes |
| `snet-forge-private-endpoints` | `10.3.0.0/24` | `10.19.0.0/24` | All PaaS private endpoint NICs |
| `snet-forge-appgw` | `10.4.0.0/24` | `10.20.0.0/24` | Application Gateway WAF |
| `AzureBastionSubnet` | `10.5.0.0/24` | `10.21.0.0/24` | Azure Bastion (name is fixed by Azure) |

### 3.3 Subnet Sizing Rationale

#### Compute and Orchestration Cluster Subnets — `/16`

AKS with Azure CNI Overlay allocates **one IP per node** from the VNet subnet (not one per pod — see Section 4). The `/16` provides 65,534 node IPs, which is far more than needed today but eliminates any future subnet resize operation (which would require reprovisioning the AKS cluster).

- Spark node pool: 0–20 nodes × Standard_E8s_v5 (spot)
- Orchestration node pool: 2–10 nodes × Standard_D8s_v5
- System and platform node pools: 1–4 nodes each

Rule of thumb: provision 3× peak node count. For 20 Spark nodes, that is 60 IPs. A `/26` would be tight; `/16` provides headroom for large burst pools with zero reconfiguration.

#### Private Endpoints Subnet — `/24`

Each private endpoint consumes one NIC with one private IP. Forge has 11 private endpoints today. A `/24` (254 IPs) provides room for ~240 more as the platform grows. Azure recommends a dedicated private endpoints subnet to simplify NSG management.

Network policies must be **disabled** on this subnet (`privateEndpointNetworkPolicies: Disabled` in Bicep) — private endpoint NICs do not support NIC-level NSG rules.

#### Application Gateway Subnet — `/24`

Azure Application Gateway v2 requires a dedicated subnet. Minimum is `/26` (64 IPs) for autoscaling. Forge uses `/24` for safety margin.

#### Bastion Subnet — `/24`

Azure Bastion **requires** its subnet to be named exactly `AzureBastionSubnet`. Minimum size is `/26`. Forge uses `/24` for alignment.

---

## 4. AKS Networking: Azure CNI Overlay

### 4.1 Why Azure CNI Overlay (Not Standard Azure CNI)

Both AKS clusters use **Azure CNI Overlay** mode. This is the critical networking decision that makes the `/16` cluster subnets practical.

With **standard Azure CNI**, every pod gets an IP from the VNet subnet. For a node pool with 50 Spark executors per node and 20 nodes, that is 1000 pod IPs consumed from the VNet — plus node IPs, load balancer IPs, and internal service IPs. Standard Azure CNI requires pre-allocating large VNet subnets, and organizations on shared enterprise networks frequently run out of available address space.

With **Azure CNI Overlay**:

```
Standard Azure CNI:                   Azure CNI Overlay:
─────────────────────                 ──────────────────
VNet subnet: 10.1.0.0/16             VNet subnet: 10.1.0.0/16
  Node 1:    10.1.0.4   ✓              Node 1:    10.1.0.4   ✓ (one VNet IP per node)
  Pod 1.1:   10.1.0.5   ✓              Pod 1.1:   192.168.0.1 ← overlay (not VNet)
  Pod 1.2:   10.1.0.6   ✓              Pod 1.2:   192.168.0.2 ← overlay (not VNet)
  Pod 1.3:   10.1.0.7   ✓              Pod 1.3:   192.168.0.3 ← overlay (not VNet)
  Node 2:    10.1.0.8   ✓              Node 2:    10.1.0.5   ✓
  ...                                   ...
  (1000 pods = 1000+ VNet IPs)          (1000 pods = 20 VNet IPs)
```

In Overlay mode, pod-to-pod communication within a node goes directly (no encapsulation). Pod-to-pod communication across nodes uses VXLAN encapsulation over the node's VNet NIC. This adds ~1–2µs latency for cross-node pod communication, which is negligible for Spark (shuffle over TCP) and Airflow (task scheduling).

**Pod CIDR (Overlay):** `192.168.0.0/16` (compute cluster), `192.169.0.0/16` (orchestration cluster)
- Each `/16` provides 65,534 pod IPs
- Pods on the compute cluster are in `192.168.x.x`; pods on the orchestration cluster are in `192.169.x.x`
- These addresses do not appear in the Azure VNet routing table — they are only meaningful within each cluster
- No routing configuration needed in the VNet for inter-cluster pod communication (they communicate via private endpoint IPs, not pod IPs)

**Service CIDR:** `172.20.0.0/16` (compute), `172.21.0.0/16` (orchestration)
- Kubernetes ClusterIP services get IPs from this range
- Must not overlap with the VNet address space or pod CIDR
- The `/16` provides 65,534 service IPs — far more than any cluster will use, but the non-overlapping ranges prevent confusion

### 4.2 CoreDNS Configuration

CoreDNS runs as a Deployment (2 replicas, managed by AKS) in the `kube-system` namespace on each cluster. It is the authoritative DNS resolver for all pods.

Default CoreDNS configuration (AKS-managed):

```
# Corefile
.:53 {
    errors
    health
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    prometheus :9153
    forward . 168.63.129.16   ← Azure DNS virtual IP (recursive resolver)
    cache 30
    loop
    reload
    loadbalance
}
```

Forge adds a custom ConfigMap (`coredns-custom`) to override resolution for private DNS zones. This ensures that when a pod queries `forge-prod-adls.dfs.core.windows.net`, the response comes from the private DNS zone (returning `10.3.0.4`), not from public Azure DNS:

```yaml
# ConfigMap: coredns-custom (in kube-system namespace)
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  privatelink.override: |
    privatelink.dfs.core.windows.net:53 {
        errors
        cache 30
        forward . 168.63.129.16
    }
    privatelink.blob.core.windows.net:53 {
        errors
        cache 30
        forward . 168.63.129.16
    }
    privatelink.vaultcore.azure.net:53 {
        errors
        cache 30
        forward . 168.63.129.16
    }
    privatelink.azurecr.io:53 {
        errors
        cache 30
        forward . 168.63.129.16
    }
    privatelink.postgres.database.azure.com:53 {
        errors
        cache 30
        forward . 168.63.129.16
    }
```

The `168.63.129.16` address is Azure's internal DNS resolver. Because the private DNS zones are linked to the VNet, this resolver returns private endpoint IPs for `privatelink.*` queries made from within the VNet. See Section 7 for the full DNS resolution flow trace.

---

## 5. AKS Cluster API Server Access

### 5.1 Dev: Public API Server (current)

In the dev environment both AKS clusters have `privateCluster: false` — the Kubernetes API server has a **public endpoint**. This keeps the deploy loop simple: `kubectl` and `helm` can be run directly from any developer laptop or CI/CD agent without VPN or jump host.

```
Developer laptop / CI agent
  → kubectl → public AKS API server:443
  → authenticates via Azure AD kubeconfig token (az aks get-credentials)
```

> **Note:** `enablePrivateCluster` is **immutable** — a cluster must be recreated to change it. Dev clusters will remain public until prod is stood up. This is a deliberate trade-off: dev is a non-production environment with no sensitive customer data.

### 5.2 Prod: Private API Server (planned)

Production clusters will have `privateCluster: true`. This means:

- The Kubernetes API server has no public endpoint
- An Azure Private Endpoint NIC is created in `private-endpoints-subnet` (`10.3.0.0/24`) with a private IP (10.3.0.11 / 10.3.0.12 reserved)
- API server FQDN resolves to the private IP only from within the VNet
- Subnets 10.3.0.11/10.3.0.12 are pre-reserved in the VNet for this purpose

Prod developer access will require one of:

**Method 1 — Corporate VPN / ExpressRoute (Standard)**

```
Developer laptop (VPN active)
  → corporate DNS → forwards *.azmk8s.io to Azure DNS 168.63.129.16
  → Azure DNS returns private IP of API server
  → kubectl connects to private API server:443
```

**Method 2 — Azure Bastion + Jump Host (Break-glass)**

Azure Bastion provides browser-based SSH to a jump VM in the VNet. From the jump VM, kubectl works normally.

See Section 9 for Bastion details.

**Method 3 — Azure Cloud Shell (Ad-hoc)**

Forge pre-provisions a `/27` subnet (`10.6.0.0/27`) for Cloud Shell VNet injection. A Cloud Shell session attached to this subnet can reach the private API server endpoint.

### 5.3 CI/CD Pipeline Access

The Azure DevOps pipeline agents that deploy to the clusters must be inside the VNet. Forge uses **self-hosted Azure DevOps agents** deployed as a Kubernetes Deployment in the `devops-agents` namespace on the orchestration cluster:

```
Azure DevOps pipeline trigger
  │
  │  agent poll over HTTPS (Azure DevOps service → agent, not inbound to VNet)
  ▼
Self-hosted agent pod (orchestration cluster, devops-agents namespace)
  │
  │  kubectl / helm commands
  ▼
AKS API server (private endpoint 10.3.0.12)
  │
  ▼
Kubernetes objects created / updated
```

The agent pods have a Kubernetes ServiceAccount with `cluster-admin` on the orchestration cluster and a kubeconfig for the compute cluster (mounted from Key Vault). The Azure DevOps agent image is Forge-built and imported to ACR — no public registry access.

Azure DevOps Pipelines run on ADO-hosted agents that reach the AKS API server over HTTPS — this egress path is allowed by NSG rules (outbound to port 443, destination service tag `AzureDevOps`).

---

## 6. Private Endpoints: Full Inventory

### 6.1 Private Endpoint List

| Service | Resource | Private Endpoint Name | Subnet | Private IP | Private DNS Zone |
|---------|----------|-----------------------|--------|------------|-----------------|
| ADLS Gen2 (DFS) | `forge<env>adls` | `pe-adls-dfs` | private-endpoints | 10.3.0.4 | `privatelink.dfs.core.windows.net` |
| ADLS Gen2 (Blob) | `forge<env>adls` | `pe-adls-blob` | private-endpoints | 10.3.0.5 | `privatelink.blob.core.windows.net` |
| Azure Key Vault | `kv-forge-{env}` | `pe-keyvault` | private-endpoints | 10.3.0.6 | `privatelink.vaultcore.azure.net` |
| Azure Container Registry | `forgeacr<env>` | `pe-acr` | private-endpoints | 10.3.0.7 | `privatelink.azurecr.io` |
| PostgreSQL (Airflow) | `psql-forge-airflow-<env>` | `pe-psql-airflow` | private-endpoints | 10.3.0.8 | `privatelink.postgres.database.azure.com` |
| ~~Microsoft Purview~~ | ~~`purview-forge-<env>`~~ | ~~`pe-purview`~~ | private-endpoints | 10.3.0.9 | ~~`privatelink.purview.azure.com`~~ — **removed Apr 2026; Purview integration retired** |
| Azure Monitor | `azmon-forge-<env>` | `pe-azmon` | private-endpoints | 10.3.0.10 | `privatelink.monitor.azure.com` |
| AKS API (Compute) | `forge-compute` AKS | (managed by AKS) | private-endpoints | 10.3.0.11 | `privatelink.northcentralus.azmk8s.io` |
| AKS API (Orchestration) | `forge-orchestration` AKS | (managed by AKS) | private-endpoints | 10.3.0.12 | `privatelink.northcentralus.azmk8s.io` |

**Why two ADLS private endpoints?** ADLS Gen2 has two sub-resources that each need their own private endpoint: `dfs` (Data Lake Storage — used by Spark and all Hadoop/ABFS clients) and `blob` (Blob Storage — used by ACR layer pulls and some Azure SDKs that fall back to blob). Both must be present for complete private access.

~~**Why is there a Purview private endpoint?**~~ Purview integration was retired in April 2026 — the private endpoint, `purview_client.py`, and all OpenLineage-to-Purview transport config have been removed. Lineage is now derived from Airflow DAG tags (source/output) via the portal API.

### 6.2 Private DNS Zone Linking

All private DNS zones are linked to `vnet-forge-{env}` with auto-registration disabled (auto-registration is only for VM A records, not private endpoints). The link ensures that any resource in the VNet — pods on either AKS cluster, Bastion sessions, VPN-connected developer laptops (via DNS forwarding) — can resolve the private endpoint hostnames.

```
Private DNS Zone: privatelink.dfs.core.windows.net
  A record: forge-prod-adls.dfs.core.windows.net → 10.3.0.4
  (created automatically when the private endpoint is created)

VNet link: vnet-forge-{env}
  Registration enabled: false  (no auto-registration of VM names)
  Resolution enabled: true     (all DNS queries from VNet resolved here)
```

Bicep provisioning (example for ADLS private endpoint, from `infra/bicep/modules/networking.bicep`):

```bicep
resource adlsDfsPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-adls-dfs'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'psc-adls-dfs'
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: ['dfs']
        }
      }
    ]
  }
}

resource adlsDfsDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: adlsDfsPrivateEndpoint
  name: 'adls-dfs-dns-group'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'dfs', properties: { privateDnsZoneId: adlsDfsDnsZoneId } }
    ]
  }
}
```

---

## 7. DNS Resolution Flow

### 7.1 End-to-End Trace: Pod Resolving an ADLS Hostname

This section traces every DNS hop from a Spark driver pod attempting to connect to `forge-prod-adls.dfs.core.windows.net`.

```
Step 1: Application DNS lookup initiated
─────────────────────────────────────────
Spark driver pod (pod IP: 192.168.5.12, on compute cluster)
  Python code: `spark.read.parquet("abfss://bronze@forge-prod-adls.dfs.core.windows.net/...")`
  Hadoop ABFS client initiates TCP connection to:
    forge-prod-adls.dfs.core.windows.net:443

Step 2: Pod queries its configured DNS resolver
─────────────────────────────────────────────────
Pod's /etc/resolv.conf (injected by kubelet):
  nameserver 172.20.0.10    ← kube-dns ClusterIP (CoreDNS service)
  search spark-jobs.svc.cluster.local svc.cluster.local cluster.local
  options ndots:5

Pod sends DNS query to 172.20.0.10:53 (CoreDNS):
  Query: forge-prod-adls.dfs.core.windows.net A

Step 3: CoreDNS evaluates the query
─────────────────────────────────────
CoreDNS checks its Corefile:
  - Not a cluster.local name → not Kubernetes internal
  - Not in custom zone overrides
  - Falls through to: forward . 168.63.129.16
  CoreDNS forwards the query to 168.63.129.16:53

Step 4: Azure DNS (168.63.129.16) resolves the query
──────────────────────────────────────────────────────
168.63.129.16 is Azure's internal recursive DNS resolver.
It is a virtual IP accessible from any Azure VM in any VNet.

Azure DNS receives: forge-prod-adls.dfs.core.windows.net A

It checks:
  1. Is there a private DNS zone linked to this VNet for *.dfs.core.windows.net?
  2. Yes: privatelink.dfs.core.windows.net is linked to vnet-forge-{env}
  3. Does the zone have an A record for forge-prod-adls.dfs.core.windows.net?
  4. Yes: A record → 10.3.0.4 (private endpoint NIC IP)

Azure DNS returns: forge-prod-adls.dfs.core.windows.net → 10.3.0.4

Step 5: CoreDNS receives the response and caches it
────────────────────────────────────────────────────
CoreDNS caches the response for 30 seconds (default cache TTL)
Returns to the pod: forge-prod-adls.dfs.core.windows.net → 10.3.0.4

Step 6: Pod establishes TLS connection to the private endpoint
───────────────────────────────────────────────────────────────
Pod connects to 10.3.0.4:443 (ADLS private endpoint NIC in private-endpoints-subnet)
  → TLS 1.2 handshake
  → Certificate: *.dfs.core.windows.net (Microsoft-issued, trusted)
  → Connection reaches ADLS Gen2 via Azure backbone (not internet)
  → ABFS client authenticates via Workload Identity access token
  → Read/write proceeds

Public internet is never involved. The DNS response is private. The connection is private.
```

### 7.2 What Happens Without the Private DNS Zone Link

If the private DNS zone were not linked to the VNet, Step 4 would resolve the public CNAME chain:

```
forge-prod-adls.dfs.core.windows.net
  → CNAME forge-prod-adls.privatelink.dfs.core.windows.net
  → CNAME blob.eus2prdstr05a.store.core.windows.net
  → A 20.60.240.5  ← PUBLIC IP (Microsoft backbone, but public)
```

The pod would attempt to connect to the public IP. This connection would be **blocked by the storage account firewall** (`publicNetworkAccess: Disabled` in Bicep), resulting in a `403 AuthorizationFailure` or connection refused. This is the intended behavior — misconfigured DNS fails closed, not open.

### 7.3 DNS Resolution for Cross-Cluster API Access

When the Airflow pod on the orchestration cluster reaches the compute cluster's Kubernetes API server:

```
Airflow pod → FQDN: forge-compute-aks-xxxx.privatelink.northcentralus.azmk8s.io
  → CoreDNS (172.21.0.10)
  → 168.63.129.16 (Azure DNS)
  → privatelink.northcentralus.azmk8s.io zone linked to vnet-forge-{env}
  → A record: 10.3.0.11
  → Airflow connects to 10.3.0.11:443 (compute AKS API private endpoint)
  → kubectl auth via ServiceAccount token in the kubeconfig (fetched from Key Vault)
```

---

## 8. Public Ingress: ingress-nginx and cert-manager (dev)

### 8.1 Architecture

In the dev environment, both clusters use **ingress-nginx** as the public ingress controller backed by an Azure public LoadBalancer. TLS certificates are issued by **cert-manager v1.17.1** via ACME HTTP-01 challenge against Let's Encrypt. There is no Application Gateway WAF in dev.

```
Internet (HTTPS :443)
    │
    ├─▶ orch cluster LB (forge-portal-{env}.northcentralus.cloudapp.azure.com)
    │     ingress-nginx → TLS termination (cert-manager / Let's Encrypt)
    │       /oauth2/*  → portal-auth-proxy:8080
    │       /api/*     → portal-api:8080
    │       /*         → portal-web:3001
    │
    └─▶ compute cluster LB (forge-compute-{env}.northcentralus.cloudapp.azure.com)
          ingress-nginx → TLS termination (cert-manager / Let's Encrypt)
            /*  → trino-auth-proxy:8080 → Trino coordinator:8080
```

The LB health probe path is `/healthz` — AKS forces HTTP probes for ports 80/443 and nginx returns non-2xx for `/`, which would cause the backend to appear unhealthy.

### 8.2 cert-manager Deployment (compute cluster)

cert-manager v1.17.1 is deployed on `aks-forge-compute-dev` as Phase 6.0.5 of forge-up.sh. All cert-manager pods tolerate `CriticalAddonsOnly` to run on the systempool. ACME HTTP-01 solver pods tolerate all workload taints so they can be scheduled during certificate issuance.

Trino coordinator has `http-server.process-forwarded=true` configured so it correctly handles `X-Forwarded-For` headers from nginx.

### 8.3 Production Plan

Application Gateway WAF v2 (OWASP CRS 3.2, Prevention mode, TLS via Key Vault DigiCert integration) is planned for production once dev has run reliably for 2–3 weeks. The `appgw-subnet` (`10.4.0.0/24`) and NSG rules are pre-provisioned in the VNet design for this purpose. The NSG rules documented in Section 11.4 reflect the planned production configuration, not the current dev state.

---

## 9. Azure Bastion: Operational Access

### 9.1 Purpose

Azure Bastion Standard tier is deployed in the `AzureBastionSubnet` (`10.5.0.0/24`). It provides secure, browser-based SSH and RDP access to VMs in the VNet without requiring any VM to have a public IP.

**When to use Bastion vs kubectl port-forward:**

| Scenario | Tool |
|----------|------|
| Checking pod logs, running kubectl commands | kubectl (via VPN or Cloud Shell) |
| Connecting to a specific AKS node for node-level debugging (kernel issues, disk pressure) | Bastion → node shell via `kubectl debug node/...` |
| Accessing a non-Kubernetes resource (e.g., the jump VM, a PostgreSQL CLI session) | Bastion SSH |
| Emergency: VPN is down, need to investigate production cluster | Bastion (browser-based, no VPN needed) |
| Routine development work | Never use Bastion — use kubectl via VPN |

Bastion sessions require Azure AD authentication (MFA). All sessions are logged to Log Analytics with the user identity, session duration, and target host.

### 9.2 Node Shell Access Pattern

AKS nodes do not have public IPs and do not accept direct SSH from Bastion (they are AKS-managed VMs without a jumpable SSH key). Node-level access uses the `kubectl debug` node shell pattern:

```bash
# Step 1: authenticate kubectl via VPN or Cloud Shell
kubectl --context forge-orchestration get nodes

# Step 2: open a privileged shell on a specific node
kubectl debug node/aks-platform-vmss000000 \
  -it \
  --image=forgeacr-prod.azurecr.io/node-debug:latest \
  --profile=sysadmin

# The debug pod runs with hostPID, hostNetwork, and hostIPC
# Provides access to: node filesystem (mounted at /host), cgroup, systemd
```

The `node-debug` image is a minimal Forge-built image (imported to ACR) with: `strace`, `tcpdump`, `perf`, `iproute2`, `procps`, and `kubectl`. No debugging tools are present on the production node images themselves.

---

## 10. Calico Network Policies

### 10.1 Default-Deny Model

Both AKS clusters use Calico for network policy enforcement (selected at cluster creation: `--network-plugin azure --network-policy calico`). Calico enforces Kubernetes NetworkPolicy objects.

The default posture in every namespace is **deny all ingress and egress** unless explicitly allowed. This is implemented by deploying a default-deny policy to every namespace during cluster bootstrap (via ADO Pipeline + Helm):

```yaml
# Applied to every namespace except kube-system
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```

Specific allow rules are then added per namespace as separate NetworkPolicy objects. This means: any new namespace is isolated by default until a platform engineer explicitly opens the required paths.

### 10.2 Namespace-to-Namespace Allow Rules

**airflow namespace — allow ingress from Application Gateway, allow egress to required services:**

```yaml
# Ingress: allow Application Gateway to reach Airflow webserver
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-appgw-to-airflow-webserver
  namespace: airflow
spec:
  podSelector:
    matchLabels:
      component: webserver
  policyTypes:
    - Ingress
  ingress:
    - from:
        - ipBlock:
            cidr: 10.4.0.0/24   # appgw-subnet
      ports:
        - port: 8080
          protocol: TCP
---
# Egress: allow Airflow to reach PostgreSQL (metadata DB)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-airflow-to-postgres
  namespace: airflow
spec:
  podSelector:
    matchLabels:
      app: airflow
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.3.0.8/32   # PostgreSQL private endpoint IP
      ports:
        - port: 5432
          protocol: TCP
---
# Egress: allow Airflow to reach compute cluster AKS API server
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-airflow-to-compute-api
  namespace: airflow
spec:
  podSelector:
    matchLabels:
      component: scheduler
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.3.0.11/32  # Compute AKS API private endpoint
      ports:
        - port: 443
          protocol: TCP
---
# Egress: allow Airflow to reach ADLS, Key Vault (Purview removed Apr 2026)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-airflow-to-private-endpoints
  namespace: airflow
spec:
  podSelector:
    matchLabels:
      app: airflow
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.3.0.0/24   # entire private-endpoints-subnet
      ports:
        - port: 443
          protocol: TCP
```

**spark-system namespace (compute cluster) — allow Spark Operator, restrict executor egress:**

```yaml
# Allow Spark Operator to reach Kubernetes API (on same cluster)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-spark-operator-to-api
  namespace: spark-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: spark-operator
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.3.0.11/32  # Compute AKS API private endpoint
      ports:
        - port: 443
          protocol: TCP
---
# Allow Spark executors: egress to ADLS only (Purview removed Apr 2026)
# No egress to internet, no egress to orchestration cluster directly
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-spark-jobs-egress
  namespace: spark-jobs
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    # ADLS Gen2 (DFS + Blob private endpoints)
    - to:
        - ipBlock:
            cidr: 10.3.0.4/32
        - ipBlock:
            cidr: 10.3.0.5/32
      ports:
        - port: 443
          protocol: TCP
    # NOTE: Purview private endpoint (10.3.0.9) was removed Apr 2026 — rule no longer applied
    # CoreDNS (DNS resolution)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # Driver-to-executor communication (within spark-jobs namespace)
    - to:
        - podSelector: {}
      ports:
        - port: 7078
          protocol: TCP
        - port: 7079
          protocol: TCP
        - port: 4040
          protocol: TCP
```

**monitoring namespace — allow Azure Monitor Agent (AMA) scraping:**

```yaml
# Allow Azure Monitor Agent to scrape app metrics from all namespaces
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ama-scrape-ingress
  namespace: airflow          # Apply to each monitored namespace
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              component: ama-metrics
      ports:
        - port: 9102    # statsd-exporter
          protocol: TCP
        - port: 8080    # app metrics
          protocol: TCP
```

Azure Monitor Alerts / Action Groups send notifications via Azure's managed infrastructure — no pod-level egress to Teams/PagerDuty webhooks is required from within the AKS cluster. The previous Alertmanager egress exception is no longer needed.

---

## 11. NSG Rules

### 11.1 compute-cluster-subnet NSG (`nsg-forge-compute-dev`)

Both clusters also inherit NRMS corporate rules at priorities 105–109 (deny specific dangerous ports; these do not block 80, 443, 8080, 9083, or 15002).

| Priority | Name | Direction | Source | Destination | Port | Action |
|----------|------|-----------|--------|-------------|------|--------|
| 100 | AllowHttpHttpsInbound | Inbound | Internet | Any | 80,443,8080,9083,15002 TCP | Allow |
| 105–109 | NRMS-* | Inbound | Internet | Any | (specific dangerous ports) | Deny |
| 110 | AllowLoadBalancerProbe | Inbound | AzureLoadBalancer | Any | Any | Allow |
| 200 | AllowVnetInbound | Inbound | VirtualNetwork | VirtualNetwork | Any | Allow |
| 4096 | DenyAllInbound | Inbound | Any | Any | Any | Deny |
| 100 | AllowToPrivateEndpoints | Outbound | 10.1.0.0/16 | 10.3.0.0/24 | 443,5432 TCP | Allow |
| 110 | AllowToAzureAD | Outbound | 10.1.0.0/16 | AzureActiveDirectory | 443 TCP | Allow |
| 120 | AllowToAzureMonitor | Outbound | 10.1.0.0/16 | AzureMonitor | 443 TCP | Allow |
| 130 | AllowDNS | Outbound | 10.1.0.0/16 | 168.63.129.16/32 | 53 UDP/TCP | Allow |
| 4096 | DenyAllOutbound | Outbound | Any | Any | Any | Deny |

### 11.2 orchestration-cluster-subnet

The orchestration cluster subnet has **no subnet-level NSG** in dev. Public access to the orchestration cluster is controlled by the AKS node NSG only. The ingress-nginx LoadBalancer on the orchestration cluster accepts traffic on ports 80 and 443 from the public internet.

Both clusters inherit NRMS corporate rules at priorities 105–109 that deny specific dangerous ports, but do not block 80 or 443.

### 11.3 private-endpoints-subnet NSG (`nsg-private-endpoints`)

```
Note: privateEndpointNetworkPolicies = Disabled on this subnet.
NSG rules are evaluated at the subnet level for traffic entering/leaving,
but cannot be applied to individual private endpoint NICs directly.
```

| Priority | Name | Direction | Source | Destination | Port | Action |
|----------|------|-----------|--------|-------------|------|--------|
| 100 | AllowFromClusters | Inbound | VirtualNetwork | 10.3.0.0/24 | 443,5432 TCP | Allow |
| 110 | AllowFromBastion | Inbound | 10.5.0.0/24 | 10.3.0.0/24 | 443,5432 TCP | Allow |
| 4096 | DenyAllInbound | Inbound | Any | Any | Any | Deny |
| 4096 | DenyAllOutbound | Outbound | Any | Any | Any | Deny |

### 11.4 appgw-subnet NSG (`nsg-appgw`)

The `appgw-subnet` (`10.4.0.0/24`) is pre-provisioned in the VNet for future Application Gateway WAF deployment in production. It is not actively used in dev. The NSG rules below reflect the planned production configuration:

| Priority | Name | Direction | Source | Destination | Port | Action |
|----------|------|-----------|--------|-------------|------|--------|
| 100 | AllowHTTPS | Inbound | Internet | 10.4.0.0/24 | 443 TCP | Allow |
| 110 | AllowGatewayManager | Inbound | GatewayManager | Any | 65200-65535 TCP | Allow |
| 120 | AllowAzureLB | Inbound | AzureLoadBalancer | Any | Any | Allow |
| 4096 | DenyAllInbound | Inbound | Any | Any | Any | Deny |
| 100 | AllowToOrchCluster | Outbound | 10.4.0.0/24 | 10.2.0.0/16 | 3000,8080 TCP | Allow |
| 4096 | DenyAllOutbound | Outbound | Any | Any | Any | Deny |

### 11.5 bastion-subnet NSG (`nsg-bastion`)

Azure Bastion has strictly defined required NSG rules (deviating from these breaks Bastion functionality):

| Priority | Name | Direction | Source | Destination | Port | Action |
|----------|------|-----------|--------|-------------|------|--------|
| 100 | AllowHTTPS | Inbound | Internet | Any | 443 TCP | Allow |
| 110 | AllowGatewayManager | Inbound | GatewayManager | Any | 443 TCP | Allow |
| 120 | AllowAzureLB | Inbound | AzureLoadBalancer | Any | 443 TCP | Allow |
| 130 | AllowBastionHostComm | Inbound | VirtualNetwork | VirtualNetwork | 8080,5701 TCP | Allow |
| 4096 | DenyAllInbound | Inbound | Any | Any | Any | Deny |
| 100 | AllowSSH | Outbound | Any | VirtualNetwork | 22 TCP | Allow |
| 110 | AllowRDP | Outbound | Any | VirtualNetwork | 3389 TCP | Allow |
| 120 | AllowToAzureCloud | Outbound | Any | AzureCloud | 443 TCP | Allow |
| 130 | AllowBastionComm | Outbound | Any | VirtualNetwork | 8080,5701 TCP | Allow |
| 140 | AllowGetSessionInfo | Outbound | Any | Internet | 80 TCP | Allow |
| 4096 | DenyAllOutbound | Outbound | Any | Any | Any | Deny |

---

## 12. Cross-Cluster Communication

### 12.1 The Communication Problem

Airflow runs on `forge-orchestration` and submits Spark jobs by creating `SparkApplication` CRD objects on `forge-compute`. This requires the Airflow scheduler to have API access to the compute cluster's Kubernetes API server.

This is the **only** intentional direct cross-cluster communication path. It is carefully controlled:

```
forge-orchestration cluster
  Airflow scheduler pod
  Namespace: airflow
  ServiceAccount: airflow-scheduler
    │
    │  HTTP/2 (TLS) to 10.3.0.11:443
    │  (compute AKS API server private endpoint)
    │
    ▼
forge-compute cluster
  kube-apiserver (private endpoint: 10.3.0.11)
    │  authenticates the kubeconfig token
    ▼
  RBAC:
    ClusterRole: forge-airflow-spark-submitter
      Verbs: create, get, list, watch, delete
      Resources: sparkapplications, pods, pods/log
      Namespaces: spark-jobs only
```

Airflow has **no cluster-admin** on the compute cluster. Its Kubernetes ServiceAccount (on the compute cluster) is bound to a custom ClusterRole that grants only the permissions needed to submit and monitor Spark jobs.

### 12.2 kubeconfig in Key Vault

The kubeconfig that authorizes Airflow to the compute cluster API server is stored in Key Vault:

```
Key Vault: kv-forge-{env}
  Secret: compute-cluster-kubeconfig
    Content: YAML kubeconfig with:
      cluster: forge-compute (API server: https://10.3.0.11:443)
      user: airflow-spark-submitter (token: <ServiceAccount token>)
      context: forge-compute

Airflow scheduler pod mounts this secret via CSI Secrets Store Driver:
  Volume: compute-kubeconfig
    SecretProviderClass: compute-kubeconfig-spc
    MountPath: /mnt/secrets/kubeconfig
    Type: tmpfs (in-memory, not written to node disk)
```

The ServiceAccount token is a long-lived token (not the default short-lived bound token) because Airflow needs persistent API access across scheduler pod restarts. Token rotation is managed by Key Vault secret rotation policy (every 90 days). On rotation, the Airflow scheduler pod restarts to pick up the new token via the CSI driver.

### 12.3 Compute Cluster RBAC for Airflow

```yaml
# On forge-compute cluster
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: forge-airflow-spark-submitter
rules:
  - apiGroups: ["sparkoperator.k8s.io"]
    resources: ["sparkapplications"]
    verbs: ["create", "get", "list", "watch", "delete", "patch", "update"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list"]
    resourceNames: ["spark-connect-server"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: forge-airflow-spark-submitter
subjects:
  - kind: ServiceAccount
    name: airflow-spark-submitter
    namespace: airflow-remote   # a dedicated namespace on the compute cluster
roleRef:
  kind: ClusterRole
  name: forge-airflow-spark-submitter
  apiGroup: rbac.authorization.k8s.io
```

The `airflow-remote` namespace on the compute cluster is not used for running workloads — it exists solely to host the Airflow ServiceAccount. Spark jobs run in `spark-jobs` namespace.

### 12.4 Calico Policy for Cross-Cluster Path

The network policy allowing Airflow to reach the compute API server is defined in Section 10.2 (`allow-airflow-to-compute-api`). It is tightly scoped:

- Source: `airflow` namespace, `component: scheduler` pods only
- Destination: `10.3.0.11/32` (compute AKS API private endpoint) only
- Port: `443` TCP only

No other pod in the orchestration cluster has egress permission to the compute cluster API server.

### 12.5 Monitoring and Observability of Cross-Cluster Calls

The Airflow `SparkKubernetesOperator` emits metrics on every API call to the compute cluster. These metrics are scraped by the Azure Monitor Agent (AMA) and used in the Airflow Health dashboard in Azure Managed Grafana:

| Metric | Alert |
|--------|-------|
| `airflow_spark_submit_duration_seconds` | P95 > 10s → API server slow |
| `airflow_spark_submit_errors_total` | Any → critical (Spark jobs not starting) |
| `airflow_spark_submit_timeout_total` | Any → critical (compute API unreachable) |

If the compute cluster API server is unreachable (network policy misconfiguration, private endpoint outage, compute AKS upgrade), `airflow_spark_submit_timeout_total` increments and an alert fires within 2 minutes. All pending Spark-backed DAG tasks will fail and queue up for retry per the Airflow retry policy.
