# Forge — Networking Architecture

> **Version:** 1.0
> **Status:** Production
> **Audience:** Platform engineers, network engineers, security architects
> **Last updated:** 2026-03-24

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

**Zero public exposure on the data plane.** No storage account, no database, no Kubernetes API server, no container registry is reachable from the public internet. The only public-facing IP is the Application Gateway WAF, which serves the Developer Portal and Azure Managed Grafana — both read-only UIs backed by Azure AD authentication.

**Private endpoints for all PaaS services.** Every Azure managed service is accessed via a private endpoint with a private IP in the VNet. DNS resolution for those services returns the private IP, not the public Microsoft backbone IP. There is no exception to this rule.

**Clusters are sovereign.** Each AKS cluster has no direct network path to the other. Cross-cluster coordination happens only through shared data stores (ADLS Gen2, Marquez API, Key Vault) accessed via private endpoints. The only intentional cross-cluster connection is Airflow reaching the compute cluster's Kubernetes API server — a specific, controlled path with explicit network policy approval.

---

## 2. Full Network Topology Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Azure Region: East US                                                                │
│                                                                                       │
│  forge-vnet  (10.0.0.0/8)                                                           │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│  │  10.1.0.0/16  —  compute-cluster-subnet                                         │  │
│  │                                                                                  │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  forge-compute AKS cluster                                                │  │  │
│  │  │                                                                             │  │  │
│  │  │  Node Pool: system   (10.1.1.0/24, 1–3 × Standard_D4s_v5)                  │  │  │
│  │  │  Node Pool: spark    (10.1.2.0/22, 0–20 × Standard_E8s_v5, spot)           │  │  │
│  │  │  Node Pool: trino    (10.1.6.0/24, 2–8 × Standard_E16s_v5)                 │  │  │
│  │  │                                                                             │  │  │
│  │  │  Pod CIDR (overlay):  192.168.0.0/16   (does not consume VNet space)       │  │  │
│  │  │  Service CIDR:        172.20.0.0/16                                         │  │  │
│  │  │                                                                             │  │  │
│  │  │  Azure Monitor Agent DaemonSet ────────────────────────────────────────────┼──┼──┼──▶ Azure Monitor / Log Analytics
│  │  └────────────────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│  │  10.2.0.0/16  —  orchestration-cluster-subnet                                   │  │
│  │                                                                                  │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  forge-orchestration AKS cluster                                          │  │  │
│  │  │                                                                             │  │  │
│  │  │  Node Pool: system    (10.2.1.0/24, 1–3 × Standard_D4s_v5)                 │  │  │
│  │  │  Node Pool: airflow   (10.2.2.0/22, 2–10 × Standard_D8s_v5)                │  │  │
│  │  │  Node Pool: platform  (10.2.6.0/24, 1–4 × Standard_D4s_v5)                 │  │  │
│  │  │                                                                             │  │  │
│  │  │  Pod CIDR (overlay):  192.169.0.0/16   (does not consume VNet space)       │  │  │
│  │  │  Service CIDR:        172.21.0.0/16                                         │  │  │
│  │  │                                                                             │  │  │
│  │  │  Namespaces:                                                                │  │  │
│  │  │    airflow        — scheduler, webserver, workers (KubernetesExecutor)      │  │  │
│  │  │    lineage        — marquez-api, marquez-web                                │  │  │
│  │  │    monitoring     — azure-monitor-agent, otel-collector                     │  │  │
│  │  │    portal         — portal-api, portal-web                                  │  │  │
│  │  │    argocd         — argocd-server, application-controller                   │  │  │
│  │  └────────────────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│  │  10.3.0.0/24  —  private-endpoints-subnet  (NSG: inbound from 10.0.0.0/8 only) │  │
│  │                                                                                  │  │
│  │  10.3.0.4   — ADLS Gen2 (dfs endpoint)       privatelink.dfs.core.windows.net   │  │
│  │  10.3.0.5   — ADLS Gen2 (blob endpoint)      privatelink.blob.core.windows.net  │  │
│  │  10.3.0.6   — Key Vault                       privatelink.vaultcore.azure.net    │  │
│  │  10.3.0.7   — Azure Container Registry        privatelink.azurecr.io             │  │
│  │  10.3.0.8   — PostgreSQL (Airflow metadata)   privatelink.postgres.database...   │  │
│  │  10.3.0.9   — PostgreSQL (Marquez)            privatelink.postgres.database...   │  │
│  │  10.3.0.10  — Azure Monitor (metrics)         privatelink.monitor.azure.com      │  │
│  │  10.3.0.11  — Compute AKS API server          (AKS private endpoint)             │  │
│  │  10.3.0.12  — Orchestration AKS API server    (AKS private endpoint)             │  │
│  │  10.3.0.13  — Azure DevOps (agent outbound)   (service endpoint, not PE)         │  │
│  │                                                                                  │  │
│  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│  │  10.4.0.0/24  —  appgw-subnet  (NSG: inbound from Internet on 443; GatewayMgr) │  │
│  │                                                                                  │  │
│  │  Application Gateway v2 (WAF)                                                    │  │
│  │    Public IP: <forge-appgw-pip>                                                 │  │
│  │    DNS: portal.forge.<domain>  → Portal backend pool (10.2.x.x)               │  │
│  │    DNS: grafana.forge.<domain> → Azure Managed Grafana (Azure-hosted)         │  │
│  │    TLS cert from Key Vault (cert name: forge-tls-cert)                         │  │
│  │    WAF policy: OWASP 3.2 managed rules + custom exclusions                       │  │
│  │                                                                                  │  │
│  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│  │  10.5.0.0/24  —  bastion-subnet  (AzureBastionSubnet — name is fixed by Azure)  │  │
│  │                                                                                  │  │
│  │  Azure Bastion (Standard tier)                                                   │  │
│  │    Provides RDP/SSH to VMs in the VNet without public IPs on VMs                 │  │
│  │    Accessible only from corporate network (ExpressRoute / VPN)                   │  │
│  │    Used for: emergency node shell access, jump to private resources               │  │
│  │                                                                                  │  │
│  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                       │
│  Private DNS Zones (linked to forge-vnet):                                          │
│    privatelink.dfs.core.windows.net       → 10.3.0.4                                 │
│    privatelink.blob.core.windows.net      → 10.3.0.5                                 │
│    privatelink.vaultcore.azure.net        → 10.3.0.6                                 │
│    privatelink.azurecr.io                 → 10.3.0.7                                 │
│    privatelink.postgres.database.azure.com → 10.3.0.8, 10.3.0.9                     │
│    privatelink.monitor.azure.com          → 10.3.0.10                                │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘

Traffic flows:
  Internet → AppGW (443) → Portal (orch cluster internal LoadBalancer) / Azure Managed Grafana (Azure-hosted)
  Corp VPN → Bastion → node shell (emergency only)
  Corp VPN → Orch AKS API server private endpoint (10.3.0.12) → kubectl
  Airflow (orch cluster) → Compute AKS API server private endpoint (10.3.0.11)
  Any pod → ADLS/KV/ACR/PostgreSQL → private endpoint (10.3.0.x)
  No cluster → public internet (no public egress for data plane)
```

---

## 3. VNet Design and Subnet Sizing

### 3.1 Address Space

The Forge VNet uses `10.0.0.0/8` as its address space. This is a deliberate choice:

- Provides 16.7 million IP addresses — effectively unlimited growth headroom
- The `/8` block does not consume a scarce enterprise address range; it is subdivided into `/16` cluster subnets and `/24` infrastructure subnets
- Azure CNI Overlay mode means pod IPs are **not** allocated from the VNet address space (see Section 4) — the large VNet is primarily for node IPs and private endpoints

If Forge is deployed into an enterprise network connected via ExpressRoute, the VNet CIDR must not conflict with the corporate address space. In that case, the address space can be changed to a non-overlapping range (e.g., `172.16.0.0/12`) with no change to the overlay pod CIDRs.

### 3.2 Subnet Sizing Rationale

#### Compute Cluster Subnet — `10.1.0.0/16` (/16 = 65,534 usable IPs)

The compute cluster subnet uses a `/16` because AKS with Azure CNI Overlay allocates **one IP per node** from the VNet subnet (not one per pod). However:

- The `spark` node pool scales to 20 nodes × Standard_E8s_v5. Each Spark job creates a driver pod and up to 50 executor pods. In a burst scenario, 10 concurrent jobs = 10 drivers + 500 executors = 510 pods, all on at most 20 nodes.
- The `/16` provides 256 `/24` sub-ranges. Sub-ranges are allocated per node pool for clarity (`10.1.1.0/24` for system, `10.1.2.0/22` for spark giving 1022 node IPs — far more than needed today, but we are accounting for multi-region expansion or much larger spot pools in the future).
- Private endpoint NICs, load balancer frontend IPs, and AKS internal load balancer IPs also consume IPs from this subnet.
- Rule of thumb: provision 3× the expected peak node count in IPs per subnet. For 20 compute nodes, that's 60 IPs. A `/26` (62 IPs) would be tight. The `/16` provides room to scale compute to 1000+ nodes with zero subnet reconfiguration.

#### Orchestration Cluster Subnet — `10.2.0.0/16` (/16 = 65,534 usable IPs)

Same rationale as compute. Orchestration scales more conservatively (max ~17 nodes), but the platform node pool may be expanded to host additional platform services over time. The `/16` eliminates the need for a subnet resize operation (which requires cluster reprovisioning in AKS).

#### Private Endpoints Subnet — `10.3.0.0/24` (/24 = 254 usable IPs)

Each private endpoint consumes one NIC with one private IP. Forge has 11 private endpoints today (see Section 6). A `/24` provides 254 IPs — room for ~240 additional private endpoints as the platform grows. Azure recommends a dedicated private endpoints subnet to simplify NSG management.

Network policies must be **disabled** on the private endpoints subnet (`privateEndpointNetworkPolicies: Disabled` in Bicep) because private endpoint NICs do not support NSG rules applied to the NIC directly — NSG is applied at the subnet level for ingress control.

#### Application Gateway Subnet — `10.4.0.0/24` (/24 = 254 usable IPs)

Azure Application Gateway v2 requires a dedicated subnet. The minimum size is `/26` (64 IPs) for autoscaling. Forge uses `/24` for safety margin. The WAFv2 policy can scale to multiple instances during DDoS events; each instance needs an IP from this subnet.

#### Bastion Subnet — `10.5.0.0/24` (/24 = 254 usable IPs)

Azure Bastion **requires** its subnet to be named exactly `AzureBastionSubnet`. The minimum required size is `/26`. Forge uses `/24` for alignment with the other infrastructure subnets.

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

## 5. Private AKS Clusters

### 5.1 Private API Server Endpoint

Both AKS clusters have `--enable-private-cluster` set. This means:

- The Kubernetes API server (`kube-apiserver`) does **not** have a public endpoint
- An Azure Private Endpoint NIC is created in the VNet with a private IP
- The API server FQDN (e.g., `forge-compute-aks-abc123.abc123.privatelink.northcentralus.azmk8s.io`) resolves to the private IP when queried from within the VNet
- From the public internet, the FQDN does not resolve at all (no public DNS record)

```
Before private cluster:
  kubectl → public.api.server:443 ← accessible from internet

After private cluster:
  kubectl → private.api.server:443 ← private IP in VNet (10.3.0.11)
                                      only accessible from VNet or connected networks
```

The private endpoint for the AKS API server is placed in the `private-endpoints-subnet` (`10.3.0.0/24`) alongside all other PaaS private endpoints. A private DNS zone entry is created by AKS automatically in the `privatelink.northcentralus.azmk8s.io` zone.

### 5.2 Developer kubectl Access

Developers cannot reach the AKS API server from their laptops directly over the internet. Access requires one of three methods:

**Method 1 — Corporate VPN / ExpressRoute (Standard)**

The VNet is connected to the corporate network via ExpressRoute or Site-to-Site VPN. Developers on the corporate network (or connected via VPN client) resolve the AKS FQDN to the private IP via the linked private DNS zone and can run kubectl normally:

```
Developer laptop (VPN active)
  → corporate DNS server
  → forwards *.privatelink.northcentralus.azmk8s.io to Azure DNS 168.63.129.16
  → Azure DNS returns 10.3.0.12 (private IP of orch cluster API server)
  → kubectl connects to 10.3.0.12:443
  → API server authenticates via Azure AD kubeconfig token
```

**Method 2 — Azure Bastion + Jump Host (Break-glass)**

For situations where VPN is unavailable (e.g., a new engineer onboarding, an incident without VPN access), Azure Bastion provides browser-based SSH to a jump VM in the VNet. From the jump VM, kubectl works normally as the jump VM is inside the VNet.

See Section 9 for Bastion details.

**Method 3 — Azure Cloud Shell (Ad-hoc)**

Azure Cloud Shell sessions are injected into a VNet subnet via Azure Cloud Shell VNet integration. Forge provisions a dedicated `/27` subnet (`10.6.0.0/27`) for Cloud Shell VNet injection. From a Cloud Shell session connected to this subnet, the AKS API server private endpoint is reachable.

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

For ArgoCD-based GitOps, ArgoCD runs inside the orchestration cluster and manages its own application synchronization against the Git repository. ArgoCD's `repo-server` reaches the Azure DevOps Git remote over HTTPS — this egress path is allowed by NSG rules (outbound to port 443, destination service tag `AzureDevOps`).

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
| PostgreSQL (Marquez) | `psql-forge-marquez-<env>` | `pe-psql-marquez` | private-endpoints | 10.3.0.9 | `privatelink.postgres.database.azure.com` |
| Azure Monitor | `azmon-forge-<env>` | `pe-azmon` | private-endpoints | 10.3.0.10 | `privatelink.monitor.azure.com` |
| AKS API (Compute) | `forge-compute` AKS | (managed by AKS) | private-endpoints | 10.3.0.11 | `privatelink.northcentralus.azmk8s.io` |
| AKS API (Orchestration) | `forge-orchestration` AKS | (managed by AKS) | private-endpoints | 10.3.0.12 | `privatelink.northcentralus.azmk8s.io` |

**Why two ADLS private endpoints?** ADLS Gen2 has two sub-resources that each need their own private endpoint: `dfs` (Data Lake Storage — used by Spark and all Hadoop/ABFS clients) and `blob` (Blob Storage — used by ACR layer pulls and some Azure SDKs that fall back to blob). Both must be present for complete private access.

**Why two PostgreSQL private endpoints?** The Airflow metadata database and the Marquez lineage database are separate PostgreSQL Flexible Server instances — they use separate managed identities and may be sized and patched independently. Each gets its own private endpoint.

### 6.2 Private DNS Zone Linking

All private DNS zones are linked to `forge-vnet` with auto-registration disabled (auto-registration is only for VM A records, not private endpoints). The link ensures that any resource in the VNet — pods on either AKS cluster, Bastion sessions, VPN-connected developer laptops (via DNS forwarding) — can resolve the private endpoint hostnames.

```
Private DNS Zone: privatelink.dfs.core.windows.net
  A record: forge-prod-adls.dfs.core.windows.net → 10.3.0.4
  (created automatically when the private endpoint is created)

VNet link: forge-vnet
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
  2. Yes: privatelink.dfs.core.windows.net is linked to forge-vnet
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
  → privatelink.northcentralus.azmk8s.io zone linked to forge-vnet
  → A record: 10.3.0.11
  → Airflow connects to 10.3.0.11:443 (compute AKS API private endpoint)
  → kubectl auth via ServiceAccount token in the kubeconfig (fetched from Key Vault)
```

---

## 8. Application Gateway: WAF and Ingress

### 8.1 Architecture

Azure Application Gateway v2 (WAF SKU) is the only public-facing component in Forge. It sits in the `appgw-subnet` (`10.4.0.0/24`) and has a single public IP address. All traffic from external users (developers, analysts on corporate laptops) arrives through the Application Gateway.

```
Internet (HTTPS :443)
    │
    ▼
Application Gateway WAF v2 (Public IP: forge-appgw-pip)
    │
    ├── Listener: portal.forge.<domain>:443
    │     └── Routing rule: portal-rule
    │           └── Backend pool: portal-backend
    │                 └── Backend target: portal-web Service (orch cluster internal LB)
    │                       → HTTP :3000 (Next.js)
    │
    └── Listener: grafana.forge.<domain>:443
          └── Routing rule: grafana-rule
                └── Backend pool: grafana-backend
                      └── Backend target: Azure Managed Grafana (Azure-hosted endpoint)
                            → HTTPS (Azure Managed Grafana service URL)
```

The Application Gateway communicates with the orchestration cluster pods via the cluster's internal Azure Load Balancer (created by Kubernetes when a Service of type `LoadBalancer` is deployed). The ILB frontend IP is in the orchestration cluster subnet (`10.2.0.0/16`).

### 8.2 WAF Policy

The WAF uses **OWASP CRS 3.2** managed rules in Prevention mode. Custom rule exclusions:

| Exclusion | Reason |
|-----------|--------|
| Request header `Authorization` — rule 941100 | JWT Bearer tokens trigger false positives on the XSS header ruleset |
| Request URI `/api/v1/lineage/graph` — rules 942100–942200 | Lineage graph JSON bodies contain SQL-like syntax that triggers SQLi rules |
| Request body size limit raised to 10MB | Airflow DAG upload via portal can exceed 1MB default |

WAF is in **Prevention** mode (blocks threats, does not just log them). All WAF events are logged to Log Analytics for review.

### 8.3 TLS Termination from Key Vault

TLS certificates are managed by Azure Key Vault and referenced by the Application Gateway directly — no certificate files in Helm values or Bicep parameters.

```
Key Vault
  certificate: forge-tls-cert
    (auto-renewed via DigiCert integration, 90-day cert, renews at 80 days)
    (covers: *.forge.<domain>)

Application Gateway listener:
  SSL certificate: Key Vault reference → forge-tls-cert (latest version)
  Application Gateway managed identity (id-forge-appgw) has:
    Key Vault Certificate User role on kv-forge-{env}
```

The Application Gateway uses the managed identity to fetch the certificate from Key Vault at startup and on rotation events. No Bicep re-deploy is needed for certificate rotation.

Backend connections (Application Gateway → orchestration cluster ILB) use **HTTP** (not HTTPS). This is acceptable because:
1. The backend is within the private VNet — traffic does not traverse public networks
2. The orchestration cluster NSG allows inbound traffic to the portal ports only from the `appgw-subnet` prefix (Azure Managed Grafana is Azure-hosted and does not require inbound traffic to the orchestration cluster)
3. End-to-end TLS (AppGW to backend) can be added if required by a stricter compliance posture, at the cost of certificate management on the AKS ingress controller

### 8.4 Health Probes

| Backend Pool | Probe Path | Protocol | Interval | Timeout | Unhealthy Threshold |
|-------------|------------|----------|----------|---------|---------------------|
| portal-backend | `/api/health` | HTTP | 30s | 10s | 3 |

Health probe responses are not forwarded to the WAF (probes bypass WAF inspection to prevent false-positive blocks on health check paths).

### 8.5 Routing Rules

Both routing rules use path-based routing with a single backend pool each. No URL rewriting is needed — the portal is deployed at the root path of its FQDN. For Azure Managed Grafana, the Application Gateway forwards to the Azure-hosted Grafana endpoint.

Connection draining is enabled with a 30-second drain timeout — in-flight requests complete before a backend pod is removed during rolling updates.

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

The default posture in every namespace is **deny all ingress and egress** unless explicitly allowed. This is implemented by deploying a default-deny policy to every namespace during cluster bootstrap (via ArgoCD ApplicationSet):

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
# Egress: allow Airflow to reach ADLS, Key Vault, Marquez
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
# Allow Spark executors: egress to ADLS and Marquez only
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
    # Marquez API (lineage events)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: lineage
          podSelector:
            matchLabels:
              app: marquez
      ports:
        - port: 8080
          protocol: TCP
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

### 11.1 compute-cluster-subnet NSG (`nsg-compute-cluster`)

| Priority | Name | Direction | Source | Destination | Port | Action |
|----------|------|-----------|--------|-------------|------|--------|
| 100 | AllowOrchToSparkAPI | Inbound | 10.2.0.0/16 (orch subnet) | 10.1.0.0/16 | 443 TCP | Allow |
| 110 | AllowLoadBalancerProbe | Inbound | AzureLoadBalancer | Any | Any | Allow |
| 200 | AllowVnetInbound | Inbound | VirtualNetwork | VirtualNetwork | Any | Allow |
| 4096 | DenyAllInbound | Inbound | Any | Any | Any | Deny |
| 100 | AllowToPrivateEndpoints | Outbound | 10.1.0.0/16 | 10.3.0.0/24 | 443,5432 TCP | Allow |
| 110 | AllowToAzureAD | Outbound | 10.1.0.0/16 | AzureActiveDirectory | 443 TCP | Allow |
| 120 | AllowToAzureMonitor | Outbound | 10.1.0.0/16 | AzureMonitor | 443 TCP | Allow |
| 130 | AllowDNS | Outbound | 10.1.0.0/16 | 168.63.129.16/32 | 53 UDP/TCP | Allow |
| 140 | AllowAlertWebhooks | Outbound | 10.1.0.0/16 | Internet | 443 TCP | Allow |
| 4096 | DenyAllOutbound | Outbound | Any | Any | Any | Deny |

Note: `AllowAlertWebhooks` was previously required for self-hosted Alertmanager. With Azure Monitor Alerts / Action Groups, alert notifications are sent by Azure's managed infrastructure and this NSG rule can be removed. It is retained here only if a self-hosted webhook forwarder is deployed for other purposes.

### 11.2 orchestration-cluster-subnet NSG (`nsg-orchestration-cluster`)

| Priority | Name | Direction | Source | Destination | Port | Action |
|----------|------|-----------|--------|-------------|------|--------|
| 100 | AllowAppGWToPortal | Inbound | 10.4.0.0/24 (appgw subnet) | 10.2.0.0/16 | 3000,8080 TCP | Allow |
| 110 | AllowLoadBalancerProbe | Inbound | AzureLoadBalancer | Any | Any | Allow |
| 200 | AllowVnetInbound | Inbound | VirtualNetwork | VirtualNetwork | Any | Allow |
| 4096 | DenyAllInbound | Inbound | Any | Any | Any | Deny |
| 100 | AllowToPrivateEndpoints | Outbound | 10.2.0.0/16 | 10.3.0.0/24 | 443,5432 TCP | Allow |
| 110 | AllowToComputeCluster | Outbound | 10.2.0.0/16 | 10.1.0.0/16 | 443 TCP | Allow |
| 120 | AllowToAzureAD | Outbound | 10.2.0.0/16 | AzureActiveDirectory | 443 TCP | Allow |
| 130 | AllowToAzureDevOps | Outbound | 10.2.0.0/16 | AzureDevOps | 443 TCP | Allow |
| 140 | AllowToAzureMonitor | Outbound | 10.2.0.0/16 | AzureMonitor | 443 TCP | Allow |
| 150 | AllowDNS | Outbound | 10.2.0.0/16 | 168.63.129.16/32 | 53 UDP/TCP | Allow |
| 160 | AllowAlertWebhooks | Outbound | 10.2.0.0/16 | Internet | 443 TCP | Allow |
| 4096 | DenyAllOutbound | Outbound | Any | Any | Any | Deny |

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

Azure Application Gateway requires specific NSG rules — it uses a management infrastructure that communicates on ports 65200–65535.

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
