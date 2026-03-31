# Forge — Security Architecture & S360 Compliance

> **Standard:** Microsoft Security 360 (S360)
> **Status:** Production
> **Owner:** Platform Team

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Azure Key Vault](https://img.shields.io/badge/Key%20Vault-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/key-vault)

---

## Overview

Forge is designed Azure-native and S360-compliant from the ground up. Security is not a layer added on top — it is a constraint that shapes every architectural decision. This document maps each S360 requirement to concrete Forge controls.

---

## S360 Control Mapping

### 1. Identity & Access — No Long-Lived Credentials

**Requirement:** All service-to-service authentication must use short-lived, rotatable credentials. No static passwords, no client secrets in code or config.

**Forge control:**

All workload-to-Azure-resource authentication uses **Azure Workload Identity** (OIDC federation). The flow:

```
Pod (annotated SA)  →  OIDC token  →  Azure AD  →  short-lived access token  →  Azure Resource
```

- Zero storage account keys. Zero SAS tokens. Zero service principal secrets.
- OIDC tokens are scoped (audience-bound), short-lived (1 hour default), and require no rotation.
- Federated credentials are registered per-workload in Azure AD with minimum-required permissions.
- Human access via Azure AD with MFA enforced at tenant level — no local accounts in any platform component.

**Identities:**

| Workload Identity | Used by | Permissions |
|-------------------|---------|-------------|
| `id-forge-spark-{alias}-{env}` | Spark Operator pods | Storage Blob Data Contributor (bronze/silver/gold/code/checkpoints) · KV Secrets User |
| `id-forge-trino-{alias}-{env}` | Trino query pods + auth proxy (IMDS client_assertion) | Storage Blob Data Reader (silver/gold) · KV Secrets User |
| `id-forge-airflow-{alias}-{env}` | Airflow task pods | Storage Blob Data Contributor (bronze) · Data Reader (code) · KV Secrets User |
| `id-forge-dq-{alias}-{env}` | DQ framework pods | Storage Blob Data Reader (bronze/silver/gold) · KV Secrets User |
| `id-forge-portal-{alias}-{env}` | Developer Portal API | Storage Blob Data Reader (gold) · KV Secrets User |

Each identity has a distinct blast radius — a compromised workload cannot escalate to another workload's data or keys. See [Infrastructure Overview](01-overview.md) for the full identity inventory including AKS infrastructure identities.

---

### 2. Network Security — Zero Public Exposure

**Requirement:** No public endpoints on data plane resources. All traffic on private network paths.

**Forge control:**

```
Internet
  │
  │  HTTPS only
  ▼
AKS API server (public endpoint)       ← secured by AAD RBAC; disableLocalAccounts: true
Azure Application Gateway (WAF v2)     ← portal/grafana ingress

All data plane traffic:
  ADLS Gen2        → private endpoint only (public network access: DENIED)
  Key Vault        → private endpoint only (public network access: DENIED)
  ACR              → private endpoint only (public network access: DENIED)
  Azure Monitor    → private endpoint only
```

**Network segmentation:**

| Subnet | CIDR | Allowed inbound | Allowed outbound |
|--------|------|-----------------|-----------------|
| compute-cluster | 10.1.0.0/16 | orchestration-cluster (Spark API) | private-endpoints-subnet |
| orchestration-cluster | 10.2.0.0/16 | appgw-subnet (portal/grafana) | compute-cluster, private-endpoints-subnet |
| private-endpoints-subnet | 10.3.0.0/24 | compute + orchestration subnets | None (PaaS services) |
| appgw-subnet | 10.4.0.0/24 | Internet (HTTPS) | orchestration-cluster |
| bastion-subnet | 10.5.0.0/24 | Corporate VPN/ExpressRoute | compute + orchestration subnets |

Calico network policies enforce pod-to-pod traffic rules within each cluster — namespaces cannot communicate unless explicitly allowed.

---

### 3. Secrets Management — Key Vault as Single Source of Truth

**Requirement:** All secrets stored in a managed vault. No secrets in code, config files, environment variables set at build time, or container images.

**Forge control:**

- All secrets in **Azure Key Vault** (`kv-forge-<env>`) with RBAC authorization model (not legacy access policies).
- Pods consume secrets via **CSI Secrets Store Driver** — secrets mounted as in-memory tmpfs volumes at pod start. Never persisted to pod filesystem.
- Airflow connections backed by **Azure Key Vault Secrets Backend** — Airflow never stores connection passwords in its metadata DB.
- Key Vault soft-delete + purge protection enabled — secrets cannot be permanently deleted without explicit operator action.
- Key Vault audit logs streamed to Log Analytics (every GET, SET, DELETE logged with caller identity).
- Key rotation: all secrets have a defined rotation policy. Rotation triggers a new Key Vault version — pods pick up new version on next restart.

**What is in Key Vault:**

| Secret | Consumer |
|--------|----------|
| PostgreSQL password (Airflow metadata DB) | Airflow |
| Compute cluster kubeconfig | Airflow (SparkKubernetesOperator) |
| OIDC client secrets (Airflow webserver, Portal) | respective pods |
| Alerting webhook URLs (Teams, PagerDuty) | Azure Monitor Action Groups, Airflow callbacks |
| External source connection strings | Airflow connections |

---

### 4. Data Encryption

**Requirement:** All data encrypted at rest and in transit. Keys managed and auditable.

**At rest:**

| Resource | Encryption | Key |
|----------|-----------|-----|
| ADLS Gen2 | AES-256 | Microsoft-managed (default); Customer-managed key (CMK) option via Key Vault |
| Azure Disk (AKS node OS) | AES-256 | Platform-managed |
| PostgreSQL | AES-256 | Platform-managed |
| Key Vault secrets | FIPS 140-2 Level 2 HSM | Key Vault managed |
| ACR images | AES-256 | Platform-managed |

**In transit:**

- All ADLS access via HTTPS (TLS 1.2+) — HTTP disabled at storage account level
- All cluster internal traffic: mTLS via service mesh (optional) or TLS at application layer
- All Kubernetes API communication: TLS 1.2+
- All database connections: SSL required (`sslmode=require`)
- Spark Connect: TLS 1.2+ on gRPC transport

---

### 5. Vulnerability Management

**Requirement:** Container images must be scanned. Known vulnerabilities must be tracked and remediated within SLA.

**Forge control:**

- **Azure Container Registry** with **Defender for Containers** enabled — all pushed images scanned automatically.
- **Continuous assessment**: images already deployed to AKS are re-scanned against updated CVE databases daily.
- **Admission control**: OPA Gatekeeper policy blocks deployment of images with CRITICAL CVEs (configurable threshold).
- **Base image policy**: all Forge images use `mcr.microsoft.com/cbl-mariner` or `mcr.microsoft.com/distroless` — minimal attack surface.
- **Dependency scanning**: Python dependencies scanned via `pip-audit` in CI pipeline. Node dependencies via `npm audit`.
- **Remediation SLA**: CRITICAL = 7 days, HIGH = 30 days, MEDIUM = 90 days.

---

### 6. Audit Logging

**Requirement:** All control plane and data plane actions must be logged with caller identity, timestamp, and outcome. Logs must be immutable and retained per compliance requirements.

**Forge audit log coverage:**

| Layer | Log source | Destination | Retention |
|-------|-----------|------------|-----------|
| Azure control plane | Azure Activity Log | Log Analytics | 90 days |
| AKS control plane | AKS Diagnostic Logs (kube-apiserver, scheduler, etc.) | Log Analytics | 90 days |
| ADLS access | Storage diagnostic logs (read/write/delete per path) | Log Analytics | 90 days |
| Key Vault operations | KV audit logs (every secret access) | Log Analytics | 1 year |
| Airflow | DAG run / task instance audit log | ADLS + Log Analytics | 1 year |
| DQ framework | DQ run reports (Delta table) | ADLS Silver layer | Unlimited |
| OpenLineage events | Microsoft Purview (managed service) | Purview + ADLS archive | 1 year active, 2 years archive |
| Portal access | FastAPI structured access log | Log Analytics | 90 days |

All logs in Log Analytics are **immutable** (append-only, cannot be modified or deleted by application credentials).

---

### 7. Threat Detection — Microsoft Defender

**Requirement:** Continuous threat detection for cloud workloads. Alerts for anomalous behavior.

**Enabled Defender plans:**

| Plan | Coverage |
|------|----------|
| Defender for Containers | AKS runtime threat detection, Kubernetes API anomalies |
| Defender for Storage | Anomalous access patterns on ADLS (e.g. mass download, unusual IP) |
| Defender for Key Vault | Unusual secret access patterns |
| Defender for Databases | PostgreSQL anomaly detection (SQL injection patterns, unusual login) |
| Defender CSPM | Continuous posture assessment, misconfiguration alerts |

All Defender alerts routed to: Azure Monitor → Log Analytics → Azure Monitor Alerts / Action Groups → PagerDuty/Teams.

---

### 8. Secure Development Lifecycle

**Requirement:** Security built into the development process — not added at the end.

**CI/CD pipeline security gates:**

```
Git push
  │
  ▼
Pre-commit hooks
  • secret detection (detect-secrets)
  • Bicep security scan (checkov --framework arm)
  • Python lint + type check (ruff + mypy)
  │
  ▼
CI Pipeline (GitHub Actions / Azure DevOps)
  • pip-audit (Python dependency CVE scan)
  • npm audit (Node dependency CVE scan)
  • Microsoft Defender for Containers (container image scan)
  • checkov (IaC policy scan — S360 policies)
  • OWASP Dependency-Check
  • Unit + integration tests
  │
  ▼
Image push to ACR
  • Defender for Containers re-scans
  • OPA Gatekeeper admission policy on deploy
```

**Threat model:** A threat model (STRIDE) is maintained per component in `docs/security/threat-models/`. Updated when architecture changes.

---

### 9. Compliance Posture Summary

| S360 Control | Status | Implementation |
|-------------|--------|---------------|
| No long-lived credentials | Compliant | Azure Workload Identity (OIDC) |
| No public data plane endpoints | Compliant | Private endpoints on all PaaS (ADLS, KV, ACR); AKS API server is public but secured by AAD RBAC |
| Secrets in managed vault | Compliant | Azure Key Vault + CSI driver |
| Encryption at rest | Compliant | AES-256, platform + optional CMK |
| Encryption in transit | Compliant | TLS 1.2+ enforced everywhere |
| Vulnerability scanning | Compliant | ACR Defender + admission control |
| Audit logging | Compliant | Log Analytics, 90d–1yr retention |
| Threat detection | Compliant | Defender for Containers/Storage/KV/DB |
| RBAC via Azure AD | Compliant | All roles backed by AAD groups |
| SDL in CI/CD | Compliant | detect-secrets, checkov, Microsoft Defender for Containers, checkov |
| Network segmentation | Compliant | Private subnets + NSG + Calico |
| MFA enforced | Compliant | Azure AD tenant-level policy |

---

## Non-Goals (Out of Scope for S360 Baseline)

- **Data classification and labeling** — Microsoft Purview integration is a future phase
- **Customer-managed keys (CMK) for ADLS** — option available, not default; requires additional Key Vault HSM tier
- **Cross-tenant data sharing governance** — single-tenant architecture assumed
