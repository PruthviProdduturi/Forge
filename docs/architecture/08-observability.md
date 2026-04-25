# Forge — Observability Architecture

> **Version:** 1.1
> **Status:** Partially deployed — see section 1 for current state
> **Audience:** Platform engineers, SREs, data engineers
> **Last updated:** 2026-04-24

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Prometheus](https://img.shields.io/badge/Prometheus-E6522C?style=flat-square&logo=prometheus&logoColor=white)](https://prometheus.io) [![Grafana](https://img.shields.io/badge/Grafana-F46800?style=flat-square&logo=grafana&logoColor=white)](https://grafana.com) [![Azure Monitor](https://img.shields.io/badge/Azure%20Monitor-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/monitor)

---

## Table of Contents

1. [Observability Philosophy](#1-observability-philosophy)
2. [Full Stack Diagram](#2-full-stack-diagram)
3. [Observability Pillars](#3-observability-pillars)
4. [Azure Monitor / Container Insights: Metrics Collection](#4-azure-monitor--container-insights-metrics-collection)
5. [Azure Managed Grafana: Dashboards and Visualization](#5-azure-managed-grafana-dashboards-and-visualization)
6. [Azure Log Analytics Workspace: Log Aggregation](#6-azure-log-analytics-workspace-log-aggregation)
7. [Azure Monitor Alerts / Action Groups: Routing and Notification](#7-azure-monitor-alerts--action-groups-routing-and-notification)
8. [OpenTelemetry: Distributed Tracing](#8-opentelemetry-distributed-tracing)
9. [SLO Framework](#9-slo-framework)
10. [Per-Component Metric Catalog](#10-per-component-metric-catalog)
11. [Cost Telemetry](#11-cost-telemetry)

---

## 1. Observability Philosophy

> **Current state (dev, April 2026):** Log Analytics Workspaces and Container Insights are provisioned and collecting metrics/logs from both clusters. Azure Managed Grafana, Azure Monitor Alerts, and OpenTelemetry distributed tracing are **not yet deployed** — they are on the roadmap for the first prod promotion cycle. The `/observability` portal page is currently a "Coming Soon" placeholder; it will surface Grafana dashboard links and Azure Monitor metric queries once those services are provisioned.

Forge treats observability as a first-class platform capability. Every pipeline run, every query, every data write must be observable without SSH access, without log scraping, and without tribal knowledge. As a pure-Azure platform, Forge uses the Azure-native observability stack, which covers four signals:

- **Metrics** — Azure Monitor / Container Insights for all Kubernetes and application-level time-series data
- **Logs** — Azure Log Analytics Workspace for structured log aggregation from all pods on both clusters
- **Traces** — OpenTelemetry + Azure Monitor / Application Insights for distributed request tracing through the portal API and (optionally) Spark jobs
- **Cost telemetry** — custom cost facets attached to OpenLineage events, reconstructed from Azure Cost Management API, surfaced in Azure Managed Grafana dashboards and the Developer Portal

The guiding rule: if a pipeline fails at 3am, the on-call engineer must be able to determine the root cause — bad data, OOM executor, failed DQ check, network timeout — within ten minutes, using only Azure Managed Grafana, without touching a cluster.

All observability signals are collected by the Azure Monitor Agent (AMA), which runs as a DaemonSet on **both** clusters and ships metrics and logs to the central Azure Monitor workspace and Azure Log Analytics Workspace. This replaces the self-hosted pod-based stack with zero monitoring pods to maintain, native AKS integration, and compliance through the existing Azure enterprise agreement.

---

## 2. Full Stack Diagram

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                         FORGE OBSERVABILITY STACK                              │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Signal Sources                                                          │  │
│  │                                                                          │  │
│  │  Compute Cluster (forge-compute)                                       │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────────┐  │    │
│  │  │ Spark Driver │ │Spark Executor│ │    Trino     │ │  AKS nodes    │  │    │
│  │  │ /metrics     │ │ /metrics     │ │ /v1/info     │ │  (host metrics│  │    │
│  │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └───────┬───────┘  │    │
│  │         │  metrics       │                │                  │          │   │
│  │         └────────────────┴────────────────┴──────────────────┘          │   │
│  │                          │                                               │  │
│  │  ┌───────────────────────▼─────────────────────────────────────────┐   │    │
│  │  │  Azure Monitor Agent (AMA) DaemonSet (compute cluster)           │   │   │
│  │  │  collects metrics + tails /var/log/containers/*                  │   │   │
│  │  │  ships to Azure Monitor workspace + Log Analytics Workspace      │   │   │
│  │  └───────────────────────┬─────────────────────────────────────────┘   │    │
│  │                          │  metrics + log streams                        │  │
│  └──────────────────────────┼──────────────────────────────────────────────┘   │
│                             │                                                  │
│  ┌──────────────────────────┼──────────────────────────────────────────────┐   │
│  │  Orchestration Cluster (forge-orchestration)                          │     │
│  │                          │                                               │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │    │
│  │  │  Signal Sources (orchestration cluster)                          │   │   │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │   │     │
│  │  │  │ Airflow  │ │  Portal  │ │  AKS     │                       │   │     │
│  │  │  │ metrics  │ │ API      │ │ nodes    │                       │   │     │
│  │  │  │          │ │ /metrics │ │ (host    │                       │   │     │
│  │  │  │          │ │          │ │ metrics) │                       │   │     │
│  │  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘           │   │     │
│  │  └───────┼────────────┼────────────┼────────────┼───────────────────┘   │   │
│  │          │            │            │            │                         │ │
│  │          └────────────┴────────────┴────────────┘                        │  │
│  │                             │  metrics + logs                             │ │
│  │  ┌──────────────────────────▼─────────────────────────────────────┐   │     │
│  │  │  Azure Monitor Agent (AMA) DaemonSet (orchestration cluster)    │   │    │
│  │  │  ships to Azure Monitor workspace + Log Analytics Workspace     │   │    │
│  │  └──────────────────────────────────────────────────────────────────┘   │   │
│  │                             │                                             │ │
│  └─────────────────────────────┼────────────────────────────────────────────   │
│                                │                                               │
│  ┌─────────────────────────────▼──────────────────────────────────────────┐    │
│  │  Azure-Native Observability Backend                                      │  │
│  │                                                                          │  │
│  │  ┌──────────────────────────────────────┐                               │   │
│  │  │  Azure Monitor / Container Insights  │                               │   │
│  │  │  • AKS-native metrics (Container     │                               │   │
│  │  │    Insights add-on)                  │                               │   │
│  │  │  • recording rules (metric alerts)   │                               │   │
│  │  └──────────────┬───────────────────────┘                               │   │
│  │                 │                      ▲                                  │ │
│  │                 │ queries              │ alerts                           │ │
│  │                 ▼                      │                                  │ │
│  │  ┌──────────────────────┐   ┌──────────────────────────────────────┐    │   │
│  │  │  Azure Managed       │   │  Azure Monitor Alerts /              │    │   │
│  │  │  Grafana             │   │  Action Groups                       │    │   │
│  │  │  • Azure Monitor DS  │   │  • routing rules                     │    │   │
│  │  │  • Log Analytics DS  │   │  • suppression rules                 │    │   │
│  │  │  • App Insights DS   │   │  • PagerDuty action group (crit)     │    │   │
│  │  │  • Azure Cost DS     │   │  • Teams action group (warning)      │    │   │
│  │  │  • OIDC via Azure AD │   └──────────────────────────────────────┘    │   │
│  │  │  • provisioned DBs   │                                                │  │
│  │  └──────────────────────┘                                                │  │
│  │                                                                          │  │
│  │  ┌──────────────────────────────┐   ┌──────────────────────────────┐    │   │
│  │  │  Azure Log Analytics         │   │  Azure Monitor /             │    │   │
│  │  │  Workspace                   │   │  Application Insights        │    │   │
│  │  │  • KQL queries               │   │  • OTLP ingest               │    │   │
│  │  │  • AMA log ingest            │   │  • trace correlation         │    │   │
│  │  │  • configurable retention    │   │  • end-to-end transaction    │    │   │
│  │  └──────────────────────────────┘   └──────────────────────────────┘    │   │
│  │          ▲                                   ▲                           │  │
│  │          │ push (log streams via AMA)        │ OTLP/gRPC (traces)       │   │
│  │  ┌───────┴───────────────────────────────────┴────────────────────┐    │    │
│  │  │  Azure Monitor Agent (AMA) DaemonSets   OpenTelemetry Collector │    │   │
│  │  │  (both clusters — AKS built-in add-on)  (sidecar or Deployment)│    │    │
│  │  └────────────────────────────────────────────────────────────────┘    │    │
│  │                                                                          │  │
│  │  Azure Cost Management API (cost telemetry source)                       │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Observability Pillars

### 3.1 Metrics (Azure Monitor / Container Insights)

Time-series numeric data sampled at a fixed interval. Used for dashboards, SLO burn rate tracking, and alerts. Azure Monitor / Container Insights (enabled via the AKS Container Insights add-on) collects Kubernetes and application-level metrics from both clusters. The Azure Monitor Agent (AMA) scrapes Prometheus-compatible `/metrics` endpoints every 15 seconds and forwards them to the Azure Monitor workspace.

Metric families used across the platform:

| Type | Use |
|------|-----|
| `Counter` | Total events — task completions, DQ failures, bytes written |
| `Gauge` | Current state — active Spark executors, Airflow scheduler lag |
| `Histogram` | Latency distributions — Trino query duration, portal API response time |
| `Summary` | Not used (Histogram preferred for PromQL quantile calculation) |

### 3.2 Logs (Azure Log Analytics Workspace)

Structured and unstructured log lines from all pods on both clusters, collected by the Azure Monitor Agent (AMA) and stored in Azure Log Analytics Workspace, queryable via KQL. The AMA runs as a DaemonSet (AKS built-in add-on) and captures every pod's stdout/stderr. Structured JSON logs (used by the Portal API and DQ SDK) are parsed and promoted to indexed fields in Log Analytics.

### 3.3 Traces (OpenTelemetry → Azure Monitor / Application Insights)

> **Not yet deployed.** OTel instrumentation is planned; the code exists in `portal/backend/app/telemetry.py` but is not active in dev. See Section 1 for current deployment state.

Distributed traces for the Developer Portal API and (optionally) Spark jobs. Traces capture the full request path through portal-api → Airflow API, enabling precise latency attribution. Traces are ingested via OTLP (OpenTelemetry Protocol) and stored in Azure Monitor / Application Insights.

> **Note:** Purview Data Map API was removed from the trace path in April 2026 — `purview_client.py` has been deleted and Purview is no longer part of the lineage stack. Lineage is now derived from Airflow DAG tags (source/output) via the portal lineage API.

Trace IDs are injected into structured logs as `trace_id` fields, enabling Azure Managed Grafana's exemplar linking: click a slow portal API call in the latency histogram → jump directly to the trace.

### 3.4 Cost Telemetry

Pipeline cost is not a metric from Azure Monitor — it is reconstructed from two sources:

1. **Azure Cost Management API** — actual Azure resource spend (compute nodes, storage, networking) aggregated by tag
2. **Custom OpenLineage cost facets** — emitted by Airflow tasks at the end of each pipeline run, containing the pipeline's logical cost allocation (node hours × SKU price × executor count × duration)

Cost telemetry is surfaced in Azure Managed Grafana (Cost Tracking dashboard) and in the Developer Portal's Cost page.

---

## 4. Azure Monitor / Container Insights: Metrics Collection

### 4.1 Deployment

Azure Monitor / Container Insights is enabled as a managed AKS add-on (`--enable-addons monitoring`) on both clusters. This installs the Azure Monitor Agent (AMA) as a DaemonSet — no Helm chart, no StatefulSet, no PVC to manage. Metrics are forwarded to an Azure Monitor Workspace (managed, no self-hosted TSDB).

For Prometheus-compatible metrics emitted by Spark, Trino, and the Portal API, the AMA is configured to scrape custom endpoints via Azure Monitor Managed Prometheus scrape configuration (ConfigMap-based, analogous to ServiceMonitor/PodMonitor):

### 4.2 Scrape Architecture

Each component exposes metrics on a `/metrics` endpoint; the AMA scrapes them:

```
Component                  Exposure method                     AMA scrape config
─────────────────────────────────────────────────────────────────────────────
Airflow                    StatsD → statsd-exporter :9102       PodAnnotation scrape
Spark driver               /metrics on :4040 (SparkUI)          PodAnnotation scrape
Spark executor             /metrics on :4040 (per executor)     PodAnnotation scrape
Trino coordinator          /v1/info + /v1/cluster :8080         PodAnnotation scrape
Trino worker               /v1/info :8080                       PodAnnotation scrape
Microsoft Purview          (managed service)                    Azure Monitor metrics (via Purview Diagnostic Settings)
Portal API                 /metrics :8000 (prometheus-fastapi)  PodAnnotation scrape
AKS nodes                  Container Insights add-on (built-in) Add-on (automatic)
kube-state-metrics         Managed (Container Insights add-on)  Add-on (automatic)
```

All scrape targets for custom applications use the `prometheus.io/scrape`, `prometheus.io/port`, and `prometheus.io/path` pod annotations. Container Insights built-in metrics (node CPU, memory, disk, pod status) are collected automatically by the add-on with no configuration.

Spark driver metrics use the `PrometheusServlet` metrics sink, configured in `spark-defaults.conf`:

```
spark.metrics.conf.*.sink.prometheus.class=org.apache.spark.metrics.sink.PrometheusServlet
spark.metrics.conf.*.sink.prometheus.path=/metrics
spark.metrics.conf.driver.sink.prometheus.port=4040
spark.ui.prometheus.enabled=true
```

Airflow emits metrics via StatsD. The `statsd-exporter` DaemonSet translates StatsD UDP packets into Prometheus metrics, applying label mapping rules to expand Airflow's dot-notation metric names into labeled Prometheus metrics:

```yaml
# statsd-exporter mapping excerpt
mappings:
  - match: "airflow.dag_processing.total_parse_time"
    name: "airflow_dag_processing_parse_time_seconds"
    labels:
      component: "scheduler"
  - match: "airflow.dagrun.duration.success.*"
    name: "airflow_dagrun_duration_seconds"
    labels:
      dag_id: "$1"
      status: "success"
  - match: "airflow.dagrun.duration.failed.*"
    name: "airflow_dagrun_duration_seconds"
    labels:
      dag_id: "$1"
      status: "failed"
  - match: "airflow.task_instance_created-*.*"
    name: "airflow_task_instance_created_total"
    labels:
      operator: "$1"
      dag_id: "$2"
```

### 4.3 Retention and Storage

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Azure Monitor Workspace retention | 18 months (default) | Covers SLO trend analysis and FinOps reporting; no PVC or disk to manage |
| Container Insights retention | Configurable in Log Analytics (default 30 days) | Operational debugging window; extend to 90 days for compliance |
| Long-term cost trend data | DQ results Delta table + Purview event store | Durable record — not Azure Monitor |

All retention is managed through Azure portal / Bicep on the Azure Monitor Workspace and Log Analytics Workspace resources. No pod restarts or disk resizes required.

### 4.4 Alerting Rules Structure

All alerting rules are defined as Azure Monitor Metric Alert rules or Log Analytics Scheduled Query Alert rules, organized by component. The rule configuration hierarchy:

```
infra/bicep/modules/observability/
  alerts/
    airflow.bicep         — Airflow scheduler, task failure, SLA miss rules
    spark.bicep           — Spark OOM, executor loss, job failure rules
    trino.bicep           — Trino query failure, high latency, OOM rules
    purview.bicep         — Purview event ingestion failure rules
    platform.bicep        — Node pressure, pod crashloop rules
    slos.bicep            — SLO burn rate rules (see Section 9)
    recording-rules.bicep — Pre-aggregated recording rules for dashboards
```

Recording rules (Azure Monitor recording rules / KQL functions) reduce dashboard query cost for frequently queried, expensive aggregations. Key recording rules:

```kql
// 5-minute rate of Airflow task successes per DAG (Log Analytics KQL function)
InsightsMetrics
| where Name == "airflow_task_instance_duration_seconds_count" and Tags contains "state=success"
| summarize rate5m = rate_of_change(Val, 5m) by dag_id = tostring(Tags.dag_id)

// Trino query P95 latency over 10-minute window
InsightsMetrics
| where Name == "trino_query_execution_time_seconds_bucket"
| summarize p95 = percentile(Val, 95) by bin(TimeGenerated, 10m)

// Pipeline success rate over 1 hour
InsightsMetrics
| where Name == "airflow_dagrun_duration_seconds_count"
| summarize
    success = sumif(Val, Tags contains "status=success"),
    total   = sum(Val)
  by bin(TimeGenerated, 1h)
| extend ratio1h = success / total

// DQ pass rate over 24 hours
InsightsMetrics
| where Name in ("forge_dq_checks_passed_total", "forge_dq_checks_total")
| summarize passed = sumif(Val, Name == "forge_dq_checks_passed_total"),
            total  = sumif(Val, Name == "forge_dq_checks_total")
  by bin(TimeGenerated, 24h)
| extend pass_rate = passed / total
```

Alert rule example for Airflow scheduler heartbeat (Azure Monitor Scheduled Query Alert):

```json
{
  "alertName": "AirflowSchedulerHeartbeatMissed",
  "query": "InsightsMetrics | where Name == 'airflow_scheduler_heartbeat_timestamp_seconds' | summarize maxHeartbeat = max(Val) | where now() - unixtime_seconds_todatetime(maxHeartbeat) > 30s",
  "evaluationFrequency": "PT1M",
  "windowSize": "PT5M",
  "severity": 0,
  "actionGroups": ["forge-platform-critical"],
  "description": "Airflow scheduler has not emitted a heartbeat in >30s. No new tasks are being scheduled."
}
```

### 4.5 Multi-Cluster Metrics

Azure Monitor / Container Insights natively supports multi-cluster collection. Both `forge-compute` and `forge-orchestration` AKS clusters are onboarded to the same Azure Monitor Workspace. Metrics from both clusters arrive in the same workspace and are distinguished by the `cluster` dimension, so dashboards can filter by `cluster="forge-compute"` or `cluster="forge-orchestration"` without any federation configuration.

---

## 5. Azure Managed Grafana: Dashboards and Visualization

### 5.1 Deployment

Azure Managed Grafana is provisioned as a first-class Azure resource (not a pod). It is deployed via Bicep in the platform resource group and accessed at `https://grafana.forge.<domain>`. There are no Grafana pods to manage, no PVCs, and no container image to build or maintain.

Azure Managed Grafana is accessible via the Application Gateway at `https://grafana.forge.<domain>`. Authentication is enforced via Azure AD before the request reaches Grafana — the Managed Grafana service integrates with Azure AD natively.

### 5.2 Data Sources

Azure Managed Grafana is pre-wired with Azure-native data sources. No manual provisioning YAML is required:

| Data Source | Type | Auth | Purpose |
|-------------|------|------|---------|
| `Azure Monitor` | Azure Monitor | Managed Identity (automatic) | All metrics from Azure Monitor Workspace |
| `Azure Log Analytics` | Azure Monitor Logs | Managed Identity (automatic) | All logs from Log Analytics Workspace |
| `Application Insights` | Azure Monitor | Managed Identity (automatic) | Distributed traces |
| `Azure Cost Management` | Azure Monitor | Managed Identity (automatic) | Cost data |

Data source connections are configured in Bicep when provisioning the Managed Grafana resource:

```hcl
resource "azurerm_dashboard_grafana" "forge" {
  name                = "grafana-forge-${var.env}"
  resource_group_name = azurerm_resource_group.platform.name
  location            = var.location
  grafana_major_version = 10

  identity {
    type = "SystemAssigned"
  }

  azure_monitor_workspace_integrations {
    resource_id = azurerm_monitor_workspace.forge.id
  }
}
```

The Managed Grafana system-assigned identity is granted `Monitoring Reader` on the subscription and `Log Analytics Reader` on the Log Analytics Workspace via Bicep role assignments — no client secrets required.

### 5.3 Authentication via Azure AD

Azure Managed Grafana uses Azure AD as its identity provider natively — no `grafana.ini` OIDC configuration is needed. All Forge engineers authenticate with their corporate Azure AD identity.

Role mapping from Azure AD groups to Grafana roles is managed via Azure RBAC on the Managed Grafana resource:

| Azure AD Group | Grafana Role | Access |
|----------------|-------------|--------|
| `forge-platform-admins` | Admin | Full access including data source management |
| `forge-data-engineers` | Editor | Create/edit dashboards, explore metrics/logs |
| `forge-analysts` | Viewer | Read-only dashboard access |

### 5.4 Dashboard Provisioning from Git

All production dashboards are version-controlled in Git as JSON files under `infra/grafana/dashboards/` and provisioned to Azure Managed Grafana via the Grafana HTTP API in the CI/CD pipeline. Dashboard updates are deployed as part of the standard platform release process — no Helm release or pod restart required.

### 5.5 Dashboard Folder Structure

```
Forge/
├── Platform Overview           — top-level health: DQ pass rate, pipeline success rate
├── Spark/
│   ├── Spark Cluster           — job throughput, executor utilization, shuffle IO, GC
│   └── Spark Job Detail        — per-dag_id / per-pipeline_id drilldown
├── Trino/
│   ├── Trino Cluster           — query volume, latency dist, failed queries, memory
│   └── Trino Query Analysis    — long-running query breakdown, resource-hungry users
├── Airflow/
│   ├── Airflow Health          — scheduler lag, task state breakdown, SLA misses
│   └── DAG Performance         — per-DAG run duration trend, success/failure rate
├── Lineage/
│   └── Lineage Activity        — OpenLineage event delivery rate, Purview ingestion
├── Cost/
│   ├── Cost Overview           — spend by pipeline, by cluster, projected vs actual
│   └── Cost Anomaly            — pipelines with cost deviation > 2σ from baseline
└── SLOs/
    ├── SLO Dashboard           — error budget burn, current burn rate, SLO status
    └── Dataset Freshness       — freshness SLA status per serving-zone dataset
```

---

## 6. Azure Log Analytics Workspace: Log Aggregation

### 6.1 Architecture

Azure Log Analytics Workspace is an Azure-managed service — no Loki pod, no object-storage backend configuration, no compactor to manage. The Azure Monitor Agent (AMA), installed as a DaemonSet via the AKS Container Insights add-on, collects pod logs from both clusters and forwards them to the workspace.

Log ingestion path:

```
Pod stdout/stderr (both clusters)
        │
        ▼
Azure Monitor Agent (AMA) DaemonSet (one per cluster node — AKS built-in add-on)
        │  reads /var/log/containers/*.log
        │  applies DCR (Data Collection Rule) parsing and filtering
        │  ships log streams via HTTPS to Log Analytics ingestion endpoint
        ▼
Azure Log Analytics Workspace
        │  ingests into ContainerLog / ContainerLogV2 tables
        │  indexes all fields (full-text search available)
        │  configurable retention (default 30 days, extendable)
        ▼
Azure Managed Grafana (KQL queries via Explore or dashboard panels)
```

Log parsing and field extraction is configured via Azure Monitor Data Collection Rules (DCRs), which are Bicep-managed resources:

```hcl
resource "azurerm_monitor_data_collection_rule" "aks_logs" {
  name                = "dcr-forge-${var.env}"
  resource_group_name = azurerm_resource_group.platform.name
  location            = var.location

  data_flow {
    streams      = ["Microsoft-ContainerLogV2"]
    destinations = [azurerm_log_analytics_workspace.forge.name]
  }
}
```

### 6.2 Azure Monitor Agent: DaemonSet on Each Node

The AMA runs as a DaemonSet on every node of **both** clusters, deployed automatically when the Container Insights add-on is enabled on the AKS cluster. The AMA:

1. **Collects pod logs** — captures stdout/stderr from all containers via the container runtime log path
2. **Enriches with Kubernetes metadata** — namespace, pod name, container name, node name, cluster name added automatically
3. **Parses structured JSON logs** — ContainerLogV2 schema extracts common fields from structured log output (Portal API, DQ SDK)
4. **Filters noise** — health-check probe logs suppressed via DCR `transformKql` filter

AMA enrichment is automatic; no pipeline stages to configure per cluster.

### 6.3 Log Schema and Query Strategy

Log Analytics indexes all fields. High-cardinality values (trace_id, pod_name, run_id) are stored as columns and can be queried directly without any label cardinality concern.

**Key columns in ContainerLogV2:**

| Column | Values | Source |
|--------|--------|--------|
| `Namespace` | airflow, spark-jobs, lineage, portal | Kubernetes pod metadata |
| `ContainerName` | scheduler, webserver, driver, executor, trino-coordinator, portal-api | Kubernetes pod metadata |
| `PodName` | full pod name | Kubernetes pod metadata |
| `Computer` | node name | AMA |
| `ClusterName` | forge-compute, forge-orchestration | AKS cluster resource |
| `LogMessage` | raw log line | Container stdout/stderr |

Structured fields (level, dag_id, pipeline_id, trace_id, etc.) extracted by `parse_json` in KQL at query time — no pre-indexed labels required.

### 6.4 Retention Policies

Log Analytics retention is configured on the workspace and per-table:

| Table | Retention | Rationale |
|-------|-----------|-----------|
| `ContainerLogV2` (default) | 30 days | Operational debugging window |
| `ContainerLogV2` (error-tier archive) | 90 days | Error logs for post-incident analysis (via Auxiliary tier) |
| Audit tables (AzureActivity, etc.) | 1 year | Compliance requirement |

For long-term log archival (compliance or audit), the Airflow and DQ framework write structured audit records to Delta tables in ADLS — these are the durable record, not Log Analytics.

### 6.5 KQL Query Examples

**Find all errors for a specific DAG run:**
```kql
ContainerLogV2
| where Namespace == "airflow" and TimeGenerated > ago(24h)
| extend parsed = parse_json(LogMessage)
| where parsed.dag_id == "ingest_orders" and parsed.level == "ERROR"
| where parsed.dag_run_id == "scheduled__2026-03-24T06:00:00+00:00"
| project TimeGenerated, task_id = tostring(parsed.task_id), msg = tostring(parsed.message)
```

**Find all Spark OOM events across all jobs:**
```kql
ContainerLogV2
| where Namespace == "spark-jobs" and ContainerName == "driver"
| where LogMessage matches regex @"(?i)(OutOfMemoryError|killed by the driver)"
| extend parsed = parse_json(LogMessage)
| project TimeGenerated, pipeline_id = tostring(parsed.pipeline_id), LogMessage
```

**Count DQ failures by dataset in the last 24 hours:**
```kql
ContainerLogV2
| where Namespace == "airflow" and TimeGenerated > ago(24h)
| where LogMessage contains "DQ_CRITICAL_FAILURE"
| extend parsed = parse_json(LogMessage)
| where isnotempty(parsed.dataset)
| summarize count() by dataset = tostring(parsed.dataset)
```

**Trace all log lines for a specific pipeline run (across all components):**
```kql
ContainerLogV2
| where TimeGenerated > ago(24h)
| extend parsed = parse_json(LogMessage)
| where parsed.pipeline_id == "pipeline-uuid-here"
| project TimeGenerated, ClusterName, Namespace, ContainerName, parsed.level, parsed.message
| order by TimeGenerated asc
```

**Find Trino out-of-memory query failures:**
```kql
ContainerLogV2
| where Namespace == "compute-system" and ContainerName == "coordinator"
| where LogMessage matches regex @"(?i)(Query exceeded per-node memory limit|Exceeded global memory limit)"
| extend query_id = extract(@"queryId=([0-9_]+)", 1, LogMessage)
| project TimeGenerated, query_id, LogMessage
```

**Find portal API 5xx errors in the last hour:**
```kql
ContainerLogV2
| where Namespace == "portal" and ContainerName == "portal-api"
| where TimeGenerated > ago(1h)
| extend parsed = parse_json(LogMessage)
| where toint(parsed.status_code) >= 500
| project TimeGenerated, method = tostring(parsed.method), path = tostring(parsed.path),
    status_code = tostring(parsed.status_code), error = tostring(parsed.error)
```

---

## 7. Azure Monitor Alerts / Action Groups: Routing and Notification

### 7.1 Deployment

Azure Monitor Alerts are a managed Azure service — no Alertmanager pod to deploy or maintain. Alert rules are defined in Bicep as `Microsoft.Insights/metricAlerts` or `Microsoft.Insights/scheduledQueryRules` resources. Action Groups handle notification routing, replacing Alertmanager receivers.

### 7.2 Routing via Action Groups

Alerts are routed based on severity. Azure Monitor Alert rules reference Action Groups directly:

```
Severity 0 (Critical)
  → Action Group: forge-platform-critical
      → PagerDuty connector (platform on-call)
  → Action Group: forge-dataeng-critical
      → PagerDuty connector (data engineering on-call)

Severity 2 (Warning)
  → Action Group: forge-warning
      → Microsoft Teams webhook (#forge-alerts channel)
```

Action Group configuration (Bicep):

```hcl
resource "azurerm_monitor_action_group" "platform_critical" {
  name                = "forge-platform-critical-${var.env}"
  resource_group_name = azurerm_resource_group.platform.name
  short_name          = "plat-crit"

  pagerduty_receiver {
    name                    = "pagerduty-platform"
    service_uri             = data.azurerm_key_vault_secret.pagerduty_platform_key.value
    send_resolve            = true
  }
}

resource "azurerm_monitor_action_group" "warning" {
  name                = "forge-warning-${var.env}"
  resource_group_name = azurerm_resource_group.platform.name
  short_name          = "warning"

  webhook_receiver {
    name        = "teams-warning"
    service_uri = data.azurerm_key_vault_secret.teams_webhook_url.value
    use_common_alert_schema = true
  }
}
```

All secrets (PagerDuty keys, Teams webhook URL) are read from Key Vault via Bicep `existing` resource references at deployment time — no secrets in Helm values or config files.

### 7.3 Alert Suppression

Azure Monitor Alerts support alert suppression via **Alert Processing Rules** (the Azure equivalent of Alertmanager inhibition rules). Key suppression rules:

**Suppress all Airflow task alerts when the Airflow scheduler is down:**
Alert processing rule suppresses alerts with dimension `alertname != AirflowSchedulerHeartbeatMissed` when `AirflowSchedulerHeartbeatMissed` is firing in the same cluster.

Rationale: if the scheduler is down, every task will appear as overdue or failed. Suppressing those child alerts prevents false-positive floods until the root cause is fixed.

**Suppress Spark executor loss alerts when the Spark driver has already failed:**
Alert processing rule suppresses `SparkExecutorLost` alerts when `SparkDriverFailed` is firing for the same `pipeline_id` dimension.

Rationale: executor losses during driver failure are expected side effects. Page once for the driver failure, not once per executor.

**Suppress dataset freshness SLA alerts during an ongoing pipeline failure:**
Alert processing rule suppresses `DatasetFreshnessBreached` alerts when `PipelineRunFailed` is firing for the same `dag_id` dimension.

Rationale: if the pipeline failed, the dataset will obviously be stale. Alert on the cause (pipeline failure), not the symptom (stale data).

### 7.4 Maintenance Window Suppression

Planned maintenance windows are managed via Azure Monitor Alert Processing Rules with a time-window condition. Suppression rules are created via Bicep or Azure CLI:

```bash
# Create a suppression rule for a 2-hour maintenance window
az monitor alert-processing-rule create \
  --name "suppress-spark-upgrade-2026-03-25" \
  --resource-group rg-forge-platform-prod \
  --rule-type Suppression \
  --scopes "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-platform-prod" \
  --filter-alert-context "contains" "Spark" \
  --schedule-start-datetime "2026-03-25T02:00:00" \
  --schedule-end-datetime  "2026-03-25T04:00:00"
```

All suppression rules are tracked in the platform runbook system. Rules with an end-datetime automatically expire — no manual cleanup required.

---

## 8. OpenTelemetry: Distributed Tracing

### 8.1 Portal API Auto-Instrumentation (FastAPI)

The Developer Portal backend (`portal-api`) is a FastAPI application. It is instrumented using the `opentelemetry-instrumentation-fastapi` package, which auto-instruments all HTTP routes without requiring manual span creation in application code.

Instrumentation is initialized at application startup:

```python
# portal/backend/app/telemetry.py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

def configure_tracing(app):
    resource = Resource.create({
        "service.name": "forge-portal-api",
        "service.version": os.environ["APP_VERSION"],
        "deployment.environment": os.environ["ENVIRONMENT"],
    })
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(
        endpoint="http://otel-collector.monitoring.svc.cluster.local:4317",
        insecure=True,
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()   # traces outbound calls to Airflow, Purview APIs
    SQLAlchemyInstrumentor().instrument()    # traces PostgreSQL queries (if any)
```

This produces a trace for every API call that includes:
- The portal-api HTTP span (route, method, status code, duration)
- Child spans for each outbound HTTP call (to Airflow REST API, Purview Data Map API, Trino)
- The `trace_id` is injected into the structured log as a field, enabling Azure Managed Grafana exemplar linking

### 8.2 Trace Context Propagation

The portal frontend sends an `X-Request-ID` header with each API call. The portal-api reads this and uses it as the trace parent if no W3C `traceparent` header is present. All downstream HTTP calls from portal-api to Airflow, Purview, and Trino carry the W3C `traceparent` and `tracestate` headers automatically via `HTTPXClientInstrumentor`.

This means a full portal user interaction — from browser click through portal-api → Airflow → Purview — is captured as a single trace in Azure Monitor / Application Insights.

### 8.3 OpenTelemetry Collector

The OTel Collector runs as a Deployment (not DaemonSet) in the `monitoring` namespace. It receives OTLP traces from portal-api and exports them to Azure Monitor / Application Insights:

```yaml
# otel-collector ConfigMap
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024
  memory_limiter:
    limit_mib: 512
    spike_limit_mib: 128
    check_interval: 5s

exporters:
  azuremonitor:
    connection_string: "${APPLICATIONINSIGHTS_CONNECTION_STRING}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [azuremonitor]
```

The Application Insights connection string is injected from Key Vault via the CSI Secrets Store driver.

### 8.4 Azure Monitor / Application Insights Storage and Retention

Application Insights stores traces in the Log Analytics Workspace backend. Retention is configurable on the workspace (default 30 days for the `AppDependencies` and `AppRequests` tables). Traces are primarily used for active debugging and are accessible via Azure Managed Grafana's Application Insights data source or directly in the Azure portal.

### 8.5 Spark Traces (Optional)

For deep performance profiling of Spark jobs, the OpenTelemetry Java agent can be attached to the Spark driver and executors. This is **not enabled by default** (it adds overhead and significant trace volume) but can be enabled per-job via the `SparkApplication` CRD:

```yaml
spec:
  driver:
    javaOptions: >-
      -javaagent:/opt/otel/opentelemetry-javaagent.jar
      -Dotel.service.name=spark-driver-${PIPELINE_ID}
      -Dotel.exporter.otlp.endpoint=http://otel-collector.monitoring.svc.cluster.local:4317
      -Dotel.traces.sampler=traceidratio
      -Dotel.traces.sampler.arg=0.01
```

The `traceidratio` sampler at 1% prevents trace volume from overwhelming the Tempo backend during large shuffle operations. Even at 1% sampling, Spark task scheduling, shuffle read/write, and GC pauses are captured.

---

## 9. SLO Framework

### 9.1 Error Budget Model

Forge uses the Google SRE error budget model. Each SLO defines:

- **SLI (Service Level Indicator):** The metric being measured (e.g., fraction of pipeline runs that succeed)
- **SLO target:** The threshold (e.g., 99.5% success rate over 30 days)
- **Error budget:** `1 - SLO_target` of the measurement period (e.g., 0.5% of 30 days = 3.6 hours of allowed failures per month)
- **Burn rate:** How fast the error budget is being consumed. A burn rate of 1 means consuming budget at exactly the sustainable pace. A burn rate of 14.4 means the entire monthly budget will be consumed in 2 hours.

### 9.2 Platform SLOs

| SLO | SLI | Target | Error Budget (30d) |
|-----|-----|--------|--------------------|
| Pipeline Success Rate | % of DAG runs completing successfully | 99.0% | 7.2 hours |
| Dataset Freshness | % of serving datasets within their SLA at measurement time | 99.5% | 3.6 hours |
| DQ Pass Rate | % of DQ runs passing without CRITICAL failures | 98.0% | 14.4 hours |
| Trino Query Availability | % of Trino queries completing (not returning infrastructure error) | 99.5% | 3.6 hours |
| Portal API Availability | % of portal-api requests returning 2xx or 4xx (not 5xx or timeout) | 99.9% | 43 minutes |

### 9.3 Burn Rate Alerts

Each SLO has two burn rate alerts: a fast-burn (immediate page) and a slow-burn (ticket/warning):

| Alert | Burn Rate | Window | Severity | Action |
|-------|-----------|--------|----------|--------|
| Fast burn | > 14.4× | 1h | Critical | Page on-call immediately |
| Slow burn | > 3× | 6h | Warning | Create incident ticket, notify team channel |

At 14.4× burn rate over 1 hour, the SLO will exhaust its 30-day error budget in 2 hours if not addressed. This is the threshold for waking someone up.

At 3× burn rate over 6 hours, 6% of the monthly budget has already been consumed without recovery — needs investigation before it escalates.

Azure Monitor Scheduled Query Alert rule for Pipeline Success Rate SLO:

```bicep
// Bicep: Fast burn alert (>14.4x for 1h window)
resource pipelineSloFastBurnAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name                = "PipelineSuccessRateFastBurn"
  resource_group_name = azurerm_resource_group.platform.name
  location            = var.location
  scopes              = [azurerm_log_analytics_workspace.forge.id]
  severity            = 0   # Critical
  evaluation_frequency = "PT1M"
  window_duration      = "PT1H"

  criteria {
    query = <<-KQL
      InsightsMetrics
      | where Name == "airflow_dagrun_duration_seconds_count"
      | summarize
          success = sumif(Val, Tags contains "status=success"),
          total   = sum(Val)
        by bin(TimeGenerated, 1h)
      | extend ratio1h = todouble(success) / todouble(total)
      | where ratio1h < (1 - 14.4 * (1 - 0.99))
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"
    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 2
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.platform_critical.id]
  }
}

# Slow burn alert (>3x for 6h window) — severity 2 (Warning)
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "pipeline_slo_slow_burn" {
  # ... same structure, ratio6h < (1 - 3 * (1 - 0.99)), severity = 2
}
```

### 9.4 SLO Dashboard Design

The SLO Dashboard in Azure Managed Grafana (`Forge/SLOs/SLO Dashboard`) contains:

**Row 1 — Error Budget Status (current month)**

| Panel | Type | Query |
|-------|------|-------|
| Pipeline Success Rate | Stat (green/red) | `job:pipeline_success_rate:ratio30d` |
| Budget Remaining | Gauge (0–100%) | `(job:pipeline_success_rate:ratio30d - 0.99) / 0.01` |
| Time Remaining This Month | Stat | Days until month reset |

**Row 2 — Burn Rate Trend**

| Panel | Type | Description |
|-------|------|-------------|
| Burn Rate (1h) | Time series | `1h error rate / target error rate` — annotated with fast-burn threshold |
| Burn Rate (6h) | Time series | `6h error rate / target error rate` — annotated with slow-burn threshold |

**Row 3 — SLI History**

| Panel | Type | Description |
|-------|------|-------------|
| Success Rate (30d rolling) | Time series | Shows drift above/below target |
| Error Events | Bar chart | Count of failed pipeline runs per day |

**Row 4 — Dataset Freshness SLO**

Same structure as above but for the Freshness SLO — current freshness status per dataset, burn rate, and history.

---

## 10. Per-Component Metric Catalog

### 10.1 Airflow

Exposed via statsd-exporter on `:9102`. Scraped by the Azure Monitor Agent (AMA) with the `job="airflow"` dimension.

| Metric | Labels | Type | Alert Threshold |
|--------|--------|------|-----------------|
| `airflow_scheduler_heartbeat_timestamp_seconds` | — | Gauge | Alert if `time() - value > 30s` |
| `airflow_dagrun_duration_seconds` | `dag_id`, `status={success,failed}` | Histogram | P95 > SLA for that DAG |
| `airflow_task_instance_duration_seconds` | `dag_id`, `task_id`, `operator` | Histogram | P95 > 2× historical baseline |
| `airflow_task_instance_created_total` | `dag_id`, `operator` | Counter | Rate drop > 50% vs previous hour |
| `airflow_dagrun_dependency_check_duration_seconds` | `dag_id` | Histogram | P99 > 30s (scheduler overloaded) |
| `airflow_pool_starving_tasks` | `pool_name` | Gauge | > 0 for more than 10 minutes |
| `airflow_pool_open_slots` | `pool_name` | Gauge | < 5 for critical pools |
| `airflow_sla_missed` | `dag_id`, `task_id` | Counter | Any increment → warning alert |
| `airflow_scheduler_tasks_killed_externally` | — | Counter | Any increment → critical alert |

**What to alert on for Airflow:**
- Scheduler heartbeat missing (critical — no tasks scheduled)
- `airflow_pool_starving_tasks` sustained > 0 (pool exhaustion blocking pipelines)
- SLA missed counter incrementing (warning per miss, critical if > 3 in 1 hour)
- Task kill counter (executor OOM or eviction — investigate immediately)

### 10.2 Spark

Exposed via PrometheusServlet on `:4040/metrics`. Scraped per-pod by the AMA with `pipeline_id` and `dag_id` dimensions added from pod annotations.

| Metric | Labels | Type | Alert Threshold |
|--------|--------|------|-----------------|
| `spark_executor_count` | `pipeline_id`, `state={running,dead,failed}` | Gauge | `state=failed > 0` for > 2 min |
| `spark_executor_task_running_tasks_count` | `pipeline_id`, `executor_id` | Gauge | Used for utilization dashboards |
| `spark_executor_memory_used_bytes` | `pipeline_id`, `executor_id` | Gauge | > 90% of executor memory limit |
| `spark_executor_gc_time_millis_total` | `pipeline_id`, `executor_id` | Counter | GC time > 20% of task time |
| `spark_stage_task_result_size_bytes` | `pipeline_id`, `stage_id` | Histogram | P99 > 500MB (shuffle spill risk) |
| `spark_streaming_batch_duration_ms` | `pipeline_id` | Histogram | P99 > micro-batch interval × 2 |
| `spark_app_submit_time_seconds` | `pipeline_id`, `dag_id` | Gauge | Used for job start-time monitoring |
| `spark_app_completion_time_seconds` | `pipeline_id`, `dag_id`, `status` | Gauge | Used for job duration monitoring |

From Container Insights (Spark Operator-managed pods):

| Metric | Labels | Alert |
|--------|--------|-------|
| `kube_pod_container_status_restarts_total` | `namespace=spark-jobs`, `container=driver` | Restart count > 2 in 10 min |
| `kube_pod_container_resource_requests` | `resource=memory`, `namespace=spark-jobs` | Used for capacity planning |
| `kube_sparkapp_info` | `pipeline_id`, `state` | `state=FAILING` → critical |

**What to alert on for Spark:**
- Executor failures sustained (not transient spot evictions, but consistent failures)
- GC time > 20% of total task time (memory pressure, needs tuning or more memory)
- Spark driver restarting more than twice (job will not recover; pipeline is stuck)
- SparkApplication in FAILING state (Spark Operator level — critical)

### 10.3 Trino

Exposed via Trino's built-in `/v1/info` and cluster endpoints with a Prometheus-compatible exporter. Scraped by the AMA as `job="trino"`.

| Metric | Labels | Type | Alert Threshold |
|--------|--------|------|-----------------|
| `trino_query_execution_time_seconds` | `state={running,completed,failed}` | Histogram | P95 > 30s (serving queries) |
| `trino_running_queries` | — | Gauge | > 80% of `query-manager.max-total-queries` |
| `trino_queued_queries` | — | Gauge | > 20 for > 5 minutes |
| `trino_failed_queries_total` | `error_type={USER_ERROR,INTERNAL_ERROR,INSUFFICIENT_RESOURCES}` | Counter | `INTERNAL_ERROR` rate > 1% |
| `trino_memory_pool_free_bytes` | `pool={general,reserved}` | Gauge | < 10% of pool size |
| `trino_blocked_queries` | — | Gauge | > 5 for > 2 minutes |
| `trino_active_nodes` | — | Gauge | < `min_nodes` threshold → critical |
| `trino_node_cpu_time_seconds_total` | `node_id` | Counter | Used for worker utilization |
| `trino_task_input_data_size_bytes_total` | — | Counter | Used for throughput dashboards |

**What to alert on for Trino:**
- Active node count below minimum (critical — coordinator cannot distribute work)
- Memory pool `INSUFFICIENT_RESOURCES` errors rising (critical — queries failing due to memory)
- Query queue depth sustained high (warning — cluster is undersized for load)
- Blocked queries sustained (warning — deadlock or resource leak scenario)

### 10.4 ~~Microsoft Purview~~ (removed)

> **Purview integration was retired in April 2026.** `purview_client.py`, the Purview private endpoint, and all OpenLineage-to-Purview transport config have been removed. This section is kept for historical reference only.
>
> Lineage is now derived from Airflow DAG `source:` and `output:` tags, surfaced via the portal `/lineage` page. There are no active Purview metrics, alerts, or monitoring signals to configure.

### 10.5 Portal API

Exposed at `/metrics` via `prometheus-fastapi-instrumentator`. Scraped as `job="portal-api"`.

| Metric | Labels | Type | Alert Threshold |
|--------|--------|------|-----------------|
| `http_requests_total` | `method`, `path`, `status_code` | Counter | 5xx rate > 0.1% (SLO: 99.9% availability) |
| `http_request_duration_seconds` | `method`, `path` | Histogram | P95 > 2s; P99 > 5s |
| `http_requests_in_progress` | `method`, `path` | Gauge | Used for concurrency monitoring |
| `forge_dq_checks_total` | `dataset`, `check_type` | Counter | Used for DQ volume dashboards |
| `forge_dq_checks_passed_total` | `dataset`, `check_type` | Counter | Used for DQ pass rate |
| `forge_dq_checks_failed_total` | `dataset`, `check_type`, `severity` | Counter | `severity=critical` rate > 0 |
| `forge_cost_fetch_duration_seconds` | `source={azure_cost_mgmt,facet}` | Histogram | P95 > 10s (cost API slow) |
| `forge_lineage_graph_fetch_duration_seconds` | `depth` | Histogram | P95 > 3s |

**What to alert on for Portal API:**
- HTTP 5xx rate above SLO threshold (critical — users cannot access platform)
- DQ critical failures counter incrementing (already alerted by Airflow, but portal confirms user-visible impact)
- Response latency P99 > 5s (warning — degraded user experience)

---

## 11. Cost Telemetry

### 11.1 Cost Reconstruction Architecture

Pipeline cost is not directly emitted by any component — it is reconstructed from two sources and joined in the Azure Managed Grafana Cost dashboard and the Developer Portal.

```
Source 1: Azure Cost Management API
┌─────────────────────────────────────────────┐
│ Azure Cost Management                        │
│ /subscriptions/{sub}/providers/             │
│   Microsoft.CostManagement/query            │
│                                             │
│ Returns: daily cost by resource, by tag     │
│ Tags used: pipeline_id, dag_id, env         │
└──────────────────────┬──────────────────────┘
                       │  polled hourly by portal-api
                       ▼
                 Cost API Cache
                 (in-memory, 1h TTL)

Source 2: OpenLineage Cost Facet
┌─────────────────────────────────────────────┐
│ Airflow Task (end of pipeline run)           │
│ emits OpenLineage COMPLETE with cost facet:  │
│                                             │
│ {                                           │
│   "_schemaURL": "...",                      │
│   "computeCostFacet": {                     │
│     "pipeline_id": "uuid",                  │
│     "dag_id": "ingest_orders",              │
│     "dag_run_id": "scheduled__...",         │
│     "cluster": "forge-compute",           │  
│     "executor_count_avg": 12,               │
│     "driver_duration_seconds": 1842,        │
│     "executor_duration_seconds_total": 8640,│
│     "node_sku": "Standard_E8s_v5",          │
│     "spot_fraction": 0.85,                  │
│     "estimated_compute_cost_usd": 2.34      │
│   }                                         │
│ }                                           │
└──────────────────────┬──────────────────────┘
                       │  stored in Purview
                       ▼
               Microsoft Purview lineage store
               (managed service — cost facets queryable via Data Map API)
```

**Cost facet calculation by Airflow:**

The Airflow task computes the estimated cost from:
- Node SKU price (looked up from a static price table in Key Vault, refreshed monthly)
- Executor count × duration (from Spark metrics polled during job execution)
- Spot discount (0.85 average for E-series on Azure, configurable per pool)
- Driver compute (single driver pod, on-demand pricing)

This produces an estimate accurate to within ±10% for planning purposes. Actual Azure spend by pipeline is available from the Cost Management API with a 24-hour delay.

### 11.2 Azure Cost Management Integration

The portal-api fetches cost data from the Azure Cost Management API on a 1-hour polling cycle and caches results. The query uses a tag-based grouping:

```python
# Cost Management query — spend by pipeline_id tag, last 30 days
query = {
    "type": "ActualCost",
    "timeframe": "Custom",
    "timePeriod": {
        "from": (datetime.utcnow() - timedelta(days=30)).isoformat() + "Z",
        "to": datetime.utcnow().isoformat() + "Z"
    },
    "dataset": {
        "granularity": "Daily",
        "aggregation": {
            "totalCost": {"name": "Cost", "function": "Sum"}
        },
        "grouping": [
            {"type": "TagKey", "name": "pipeline_id"},
            {"type": "TagKey", "name": "dag_id"},
        ],
        "filter": {
            "tags": {
                "name": "environment",
                "operator": "In",
                "values": [ENVIRONMENT]
            }
        }
    }
}
```

AKS nodes, ADLS Gen2, and networking resources are tagged with `pipeline_id` (where attributable) and `environment` during Bicep provisioning. Shared infrastructure costs (AKS system pools, networking) are allocated proportionally based on compute usage ratios.

### 11.3 Cost Anomaly Detection

The Azure Managed Grafana Cost Anomaly dashboard identifies pipelines whose cost has deviated significantly from their historical baseline. The detection uses a rolling z-score approach over the last 14 days of Azure Monitor-tracked cost metrics:

```
forge_pipeline_cost_usd_estimate (gauge, updated at pipeline completion)
  labels: dag_id, pipeline_id, dag_run_id
```

PromQL for anomaly detection:

```promql
# Pipeline cost deviation from 14-day mean
(
  forge_pipeline_cost_usd_estimate
  -
  avg_over_time(forge_pipeline_cost_usd_estimate[14d])
)
/
stddev_over_time(forge_pipeline_cost_usd_estimate[14d])
```

Any pipeline with a z-score > 2.0 (cost > 2 standard deviations above its 14-day baseline) triggers a warning alert and is flagged in the Cost Anomaly dashboard. Common causes:

- More data than expected (volume growth — verify with DQ volume check metrics)
- Spark configuration regression (too many executors, missing broadcast hint)
- New inefficient join or shuffle introduced in a code change
- Spot instance scarcity forcing on-demand fallback at higher cost

### 11.4 Cost Metrics Emitted by Platform

| Metric | Labels | Type | Description |
|--------|--------|------|-------------|
| `forge_pipeline_cost_usd_estimate` | `dag_id`, `dag_run_id` | Gauge | Estimated cost per pipeline run |
| `forge_pipeline_executor_hours_total` | `dag_id`, `node_sku` | Counter | Cumulative executor compute hours |
| `forge_pipeline_driver_hours_total` | `dag_id` | Counter | Cumulative driver hours |
| `forge_cluster_cost_usd_daily` | `cluster`, `node_pool` | Gauge | Actual daily Azure cost (from Cost API, 24h delayed) |
| `forge_storage_cost_usd_daily` | `zone={bronze,silver,gold}` | Gauge | ADLS storage cost per zone |
