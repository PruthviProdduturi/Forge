# Forge — Orchestration Architecture

> **Version:** 1.0
> **Status:** Production
> **Last updated:** 2026-03-24
> **Audience:** Platform engineers, data engineers

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org) [![Delta Lake](https://img.shields.io/badge/Delta%20Lake-003366?style=flat-square&logo=delta&logoColor=white)](https://delta.io)

---

## Table of Contents

1. [Overview](#1-overview)
2. [KubernetesExecutor — Design and Rationale](#2-kubernetesexecutor--design-and-rationale)
3. [Task Pod Lifecycle](#3-task-pod-lifecycle)
4. [Namespace Setup and RBAC](#4-namespace-setup-and-rbac)
5. [DAG Repository Structure and git-sync](#5-dag-repository-structure-and-git-sync)
6. [DAG Authoring Patterns](#6-dag-authoring-patterns)
7. [Operator Inventory](#7-operator-inventory)
8. [Connection Management — Azure Key Vault Secrets Backend](#8-connection-management--azure-key-vault-secrets-backend)
9. [Airflow Webserver — Authentication and RBAC](#9-airflow-webserver--authentication-and-rbac)
10. [Scheduler High Availability](#10-scheduler-high-availability)
11. [Triggerer — Deferred Operators](#11-triggerer--deferred-operators)
12. [PostgreSQL Metadata Database](#12-postgresql-metadata-database)
13. [Log Handling — Azure Log Analytics and ADLS](#13-log-handling--azure-log-analytics-and-adls)
14. [Architecture Diagram](#14-architecture-diagram)
15. [Upgrade Strategy](#15-upgrade-strategy)

---

## 1. Overview

Airflow is Forge's orchestration engine. It schedules and monitors all data pipelines — raw ingestion, curated transformation, DQ validation, and serving publication. It does not execute compute directly; instead it acts as a control plane that submits work to Spark (via SparkApplication CRDs on the compute cluster) and Trino (via SQL over the Trino coordinator REST API).

Airflow runs on the `forge-orchestration` AKS cluster in the `airflow` namespace. The deployment consists of:

- **Two schedulers** (HA active-active)
- **One triggerer** (deferred operator support)
- **Two webserver replicas** (behind an internal ingress)
- **No persistent worker pods** — every task runs as an ephemeral Kubernetes pod

All configuration is managed via Helm chart at `infra/helm/orchestration/airflow/`. All DAGs are Python files in Git, synced by a `git-sync` sidecar.

---

## 2. KubernetesExecutor — Design and Rationale

### What KubernetesExecutor Does

With KubernetesExecutor, the Airflow scheduler does not maintain a pool of long-running worker processes. Instead, for every task instance that is ready to run, the scheduler creates a Kubernetes Pod in the `airflow` namespace. When the task finishes (success, failure, or upstream skip), the pod terminates and its resources are released.

The pod runs the same Docker image as the scheduler — `forgeacr/airflow:3.1.0` — with the `airflow tasks run` command as its entrypoint. This means every task has an identical, isolated Python environment, the same installed packages, and the same access to secrets.

### Why KubernetesExecutor Over CeleryExecutor

CeleryExecutor was evaluated and rejected for the following reasons:

**Idle cost.** CeleryExecutor requires a minimum set of persistent worker pods — typically 2–4 — to be running at all times, consuming node resources even when no pipelines are scheduled. In Forge's workload, pipelines are batch-oriented and bursty: high activity during business hours, near-zero overnight. KubernetesExecutor costs nothing when no tasks are queued.

**Worker heterogeneity.** CeleryExecutor workers all share the same resource profile. If one pipeline task needs 8 GB of memory and another needs 512 MB, the worker pool must be sized for the worst case. KubernetesExecutor pods carry individual resource requests and limits per task, set in the DAG definition. Each task gets exactly what it needs.

**Task isolation.** A failing task in CeleryExecutor can affect other tasks sharing the same worker (shared process space, file descriptor exhaustion, zombie processes). KubernetesExecutor task pods are fully isolated: one task, one pod, one Linux namespace. A crash in one task cannot affect another.

**No broker dependency.** CeleryExecutor requires a message broker — typically Redis or RabbitMQ — as an additional stateful component to operate, monitor, and upgrade. KubernetesExecutor uses only the Kubernetes API server as its work queue. This eliminates an entire class of operational failure modes.

**Observability.** Each task pod is a first-class Kubernetes object. Pod logs flow to Azure Log Analytics Workspace via the Azure Monitor Agent (AMA). Pod resource usage appears in Azure Managed Grafana. Pod events are visible via `kubectl`. This gives far more visibility into task execution than inspecting a worker log file.

The trade-off is task startup latency. Pod scheduling typically adds 5–10 seconds compared to a pre-warmed Celery worker picking up a task from the queue. For Forge's batch-oriented pipelines, where individual task runtimes range from 30 seconds (DQ validation) to 30 minutes (large Spark jobs), this overhead is immaterial.

### Resource Requests and Limits

Resource requests and limits are set per task via the `executor_config` parameter on each operator. The Forge platform provides standard profiles:

```python
RESOURCE_PROFILES = {
    "small": {
        "pod_override": k8s.V1Pod(
            spec=k8s.V1PodSpec(
                containers=[k8s.V1Container(
                    name="base",
                    resources=k8s.V1ResourceRequirements(
                        requests={"cpu": "250m", "memory": "512Mi"},
                        limits={"cpu": "500m", "memory": "1Gi"},
                    ),
                )]
            )
        )
    },
    "medium": {
        "pod_override": k8s.V1Pod(
            spec=k8s.V1PodSpec(
                containers=[k8s.V1Container(
                    name="base",
                    resources=k8s.V1ResourceRequirements(
                        requests={"cpu": "500m", "memory": "2Gi"},
                        limits={"cpu": "1000m", "memory": "4Gi"},
                    ),
                )]
            )
        )
    },
    "large": {
        "pod_override": k8s.V1Pod(
            spec=k8s.V1PodSpec(
                containers=[k8s.V1Container(
                    name="base",
                    resources=k8s.V1ResourceRequirements(
                        requests={"cpu": "1000m", "memory": "4Gi"},
                        limits={"cpu": "2000m", "memory": "8Gi"},
                    ),
                )]
            )
        )
    },
}
```

Typical profile assignments:

| Operator | Profile | Rationale |
|----------|---------|-----------|
| `SparkKubernetesOperator` | `small` | The task pod only submits the CRD and polls for status; compute runs in Spark pods on the compute cluster |
| `TrinoOperator` | `small` | Issues SQL via HTTP; all compute is in Trino pods on the compute cluster |
| `DQRunnerOperator` (Python-only checks) | `medium` | Loads Delta metadata, runs Trino queries for content checks |
| `DQRunnerOperator` (Spark-backed checks) | `small` | Delegates actual computation to a Spark job |
| `PythonOperator` (catalog update) | `small` | Light metadata writes |
| `EmailOperator` | `small` | Sends HTTP request to mail relay |

---

## 3. Task Pod Lifecycle

The complete lifecycle of an Airflow task pod under KubernetesExecutor:

```
Scheduler marks task instance as QUEUED
          │
          │  [scheduler loop, ~5s cadence]
          ▼
Scheduler builds pod spec
  • Image: forgeacr/airflow:3.1.0
  • Command: airflow tasks run <dag_id> <task_id> <run_id>
  • Environment: AIRFLOW__* config vars from ConfigMap
  • Secrets: mounted from Key Vault via CSI driver
  • Labels: dag_id, task_id, run_id, try_number
  • Service account: airflow-worker (with workload identity annotation)
  • resource requests/limits: from executor_config
          │
          ▼
Scheduler calls Kubernetes API → creates Pod in airflow namespace
          │
          ▼
Kubernetes scheduler assigns pod to a node in the airflow node pool
          │
          ▼
Kubelet pulls image from ACR (cached after first pull)
          │
          ▼
CSI Secrets Store driver mounts secrets from Key Vault
          │
          ▼
Pod enters Running state
          │
          ▼
airflow tasks run executes:
  • Deserializes DAG from metadata DB (serialized DAG)
  • Resolves XCom inputs if required
  • Calls operator.execute()
  • Writes XCom outputs to metadata DB
  • Reports status back via metadata DB update
          │
     ┌────┴────┐
     ▼         ▼
 SUCCESS     FAILURE
     │         │
     └────┬────┘
          ▼
Task instance state updated in metadata DB
Pod enters Completed/Failed phase
Kubernetes garbage collects pod after TTL (1 hour, configurable)
Pod logs already shipped to Azure Log Analytics by Azure Monitor Agent before collection
```

**Pod naming convention:**

```
airflow-<dag_id>-<task_id>-<run_id_hash>-<try_number>
```

Example: `airflow-ingest-sales-orders-ingest-raw-2026032401-abcd1234-1`

Pod names are truncated to 63 characters (Kubernetes limit) and sanitized (underscores replaced with hyphens, special characters removed) by the Airflow KubernetesExecutor pod name generator.

---

## 4. Namespace Setup and RBAC

### Kubernetes Namespace

All Airflow components run in the `airflow` namespace on the `forge-orchestration` cluster.

Task pods are also created in the `airflow` namespace (not a separate namespace). This simplifies RBAC — the scheduler's service account only needs permissions within one namespace.

### Service Accounts

| Service Account | Used by | Key permissions |
|----------------|---------|----------------|
| `airflow-scheduler` | Scheduler pods | Create/get/watch/delete Pods in `airflow` namespace; read/write ConfigMaps |
| `airflow-webserver` | Webserver pods | Read-only access to Kubernetes API (pod status, logs) |
| `airflow-worker` | Task pods | Assumed by each task pod; Key Vault secrets access via workload identity |
| `airflow-triggerer` | Triggerer pod | Same as scheduler for pod watch |

The `airflow-worker` service account is annotated with the workload identity:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: airflow-worker
  namespace: airflow
  annotations:
    azure.workload.identity/client-id: "<managed-identity-client-id>"
```

This means every task pod automatically receives an OIDC token for the `id-forge-read-{env}` managed identity, giving it access to Key Vault secrets and the `code` ADLS container — the only Azure resources task pods need directly.

### RBAC Role

The scheduler needs to create and manage pods. A minimal ClusterRole scoped to the `airflow` namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: airflow
  name: airflow-scheduler
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "list", "watch", "delete", "patch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "create", "update", "delete"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["list"]
```

### Network Policies

Calico network policies restrict traffic within the `airflow` namespace:

- Task pods: egress allowed to the compute cluster AKS API server (for SparkKubernetesOperator), to the Purview OpenLineage endpoint (via private endpoint), to PostgreSQL (metadata DB), and to ADLS (via private endpoint). No other egress.
- Scheduler: egress to Kubernetes API server, PostgreSQL, and Key Vault only.
- Webserver: ingress from the ingress controller; egress to PostgreSQL and the scheduler's internal port.

---

## 5. DAG Repository Structure and git-sync

### Repository Layout

All DAGs live in the Forge monorepo under `orchestration/airflow/dags/`. The directory structure mirrors the pipeline domain:

```
orchestration/airflow/dags/
├── ingestion/
│   ├── __init__.py
│   ├── ingest_sales_orders.py
│   ├── ingest_crm_accounts.py
│   └── ingest_erp_inventory.py
├── transformation/
│   ├── __init__.py
│   ├── transform_orders.py
│   ├── transform_customer_ltv.py
│   └── transform_inventory_positions.py
├── validation/
│   ├── __init__.py
│   ├── validate_orders.py
│   └── validate_inventory.py
├── publishing/
│   ├── __init__.py
│   ├── publish_orders.py
│   └── publish_inventory.py
├── maintenance/
│   ├── __init__.py
│   ├── delta_optimize.py
│   └── dq_results_compact.py
└── common/
    ├── __init__.py
    ├── spark_defaults.py       ← shared SparkApplication spec defaults
    ├── resource_profiles.py    ← KubernetesExecutor resource profiles
    ├── callbacks.py            ← SLA miss and failure alert callbacks
    └── sensors.py              ← shared ExternalTaskSensor wrappers
```

DAGs are never uploaded manually to any Airflow webserver. They exist only in Git and are delivered to Airflow automatically via `git-sync`.

### git-sync Sidecar

The scheduler and webserver pods each run a `git-sync` sidecar container alongside the main Airflow container. `git-sync` continuously polls the Git repository for changes and writes the latest DAG files to a shared volume that the Airflow process reads.

Architecture:

```
Scheduler Pod
┌─────────────────────────────────────────────┐
│                                             │
│  ┌──────────────────────┐                   │
│  │  airflow-scheduler   │◀── reads from     │
│  │  (main container)    │    /opt/airflow/  │
│  └──────────────────────┘    dags/ (emptyDir)│
│                                             │
│  ┌──────────────────────┐                   │
│  │  git-sync            │── writes to ─────▶│
│  │  (sidecar container) │    /opt/airflow/  │
│  └──────────────────────┘    dags/          │
│           │                                 │
└───────────┼─────────────────────────────────┘
            │
            │  git clone / git pull (every 60s)
            ▼
    Git remote (Azure DevOps / GitHub)
    branch: main
    path: orchestration/airflow/dags/
```

Configuration in the Helm chart:

```yaml
gitSync:
  enabled: true
  repo: "https://dev.azure.com/org/Forge/_git/Forge"
  branch: "main"
  subPath: "orchestration/airflow/dags"
  syncPeriod: 60          # seconds between git pulls
  depth: 1                # shallow clone for speed
  sshKeySecret: ""        # not used — auth via Azure DevOps PAT in Key Vault
  httpSecret: "git-sync-credentials"  # Kubernetes Secret with PAT
```

The Git credentials (a read-only Azure DevOps PAT) are stored in Key Vault and projected into a Kubernetes Secret by the CSI Secrets Store Driver on pod startup.

### DAG Versioning

Airflow **serializes DAGs** to the PostgreSQL metadata database. When a DAG Python file changes on disk, the scheduler detects the new file hash and updates the serialized DAG in the metadata DB. The scheduler and webserver both read from the serialized DAG, not from the Python file directly — this means webserver replicas always see the same DAG definition regardless of which replica's git-sync has already pulled the latest commit.

Serialized DAGs are versioned in the `dag_version` table (Airflow 3.0+). The metadata DB retains the previous serialized version until the new one is confirmed parsed successfully.

### Safe Deployment — No Breaking Running DAGs

When a DAG file changes in Git and git-sync delivers it to the scheduler:

1. The scheduler parses the new file in a subprocess. If parsing fails (syntax error, import error), the error is recorded in `import_errors` and the old serialized DAG remains active. No running DAGs are disrupted.
2. If parsing succeeds, the new serialized DAG is written to the metadata DB.
3. **In-flight task instances continue to use the serialized DAG version that was active when the DAG run started.** They are not affected by the mid-run file change.
4. New DAG runs (next scheduled trigger or manual trigger) use the new serialized DAG.

This means a DAG can be safely updated at any time, including while a run is in progress. The convention is:

- **Additive changes** (new tasks, new parameters with defaults): always safe to deploy mid-run.
- **Breaking changes** (removing tasks that running instances depend on, changing task IDs): coordinate with any currently-running instances. The `airflow dags pause <dag_id>` command can prevent new runs from starting while a long-running instance completes.
- **Incompatible interface changes** to shared templates in `common/`: bump the import path or use a version suffix (`v2`) to avoid breaking imports in DAGs that haven't been updated yet.

---

## 6. DAG Authoring Patterns

> **Hands-on guide:** For step-by-step DAG writing, testing, and debugging examples see the [Developer Experience Guide §3 — Airflow DAG Development](../guides/developer-experience.md#3-airflow-dag-development). This section covers the architectural patterns and constraints that govern how DAGs are structured on Forge.

### TaskFlow API

All new DAGs in Forge use the **TaskFlow API** (`@task` decorator, available since Airflow 2.0). TaskFlow eliminates the need to explicitly create XCom pushes and pulls — return values from one `@task` function become the input to the next automatically.

Standard four-stage DAG pattern:

```python
from airflow.decorators import dag, task
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)
from datetime import datetime, timedelta
from common.callbacks import on_failure_callback, on_sla_miss
from common.resource_profiles import RESOURCE_PROFILES

@dag(
    dag_id="orders_pipeline",
    schedule="@daily",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    default_args={
        "retries": 2,
        "retry_delay": timedelta(minutes=5),
        "on_failure_callback": on_failure_callback,
    },
    sla_miss_callback=on_sla_miss,
)
def orders_pipeline():

    ingest = SparkKubernetesOperator(
        task_id="ingest_raw_orders",
        application="abfss://code@<account>.dfs.core.windows.net/jobs/ingest_orders.py",
        namespace="spark-jobs",
        kubernetes_conn_id="compute_cluster_k8s",
        executor_config=RESOURCE_PROFILES["small"],
    )

    transform = SparkKubernetesOperator(
        task_id="transform_curated_orders",
        application="abfss://code@<account>.dfs.core.windows.net/jobs/transform_orders.py",
        namespace="spark-jobs",
        kubernetes_conn_id="compute_cluster_k8s",
        executor_config=RESOURCE_PROFILES["small"],
    )

    @task(executor_config=RESOURCE_PROFILES["medium"])
    def validate_dq():
        from forge.dq.sdk import DQRunner, load_ruleset
        from forge.dq.reporters import StoreReporter, AlertReporter, LineageReporter
        ruleset = load_ruleset("orchestration/dq/rules/orders.yaml")
        runner = DQRunner(ruleset=ruleset)
        report = runner.run()
        for reporter in [StoreReporter(), AlertReporter(), LineageReporter()]:
            reporter.report(report)
        if report.has_critical_failures():
            raise ValueError(f"DQ critical failure: {report.critical_summary()}")

    publish = SparkKubernetesOperator(
        task_id="publish_serving_orders",
        application="abfss://code@<account>.dfs.core.windows.net/jobs/publish_orders.py",
        namespace="spark-jobs",
        kubernetes_conn_id="compute_cluster_k8s",
        executor_config=RESOURCE_PROFILES["small"],
    )

    ingest >> transform >> validate_dq() >> publish

orders_pipeline()
```

### Dynamic Task Mapping

For pipelines that process multiple entities of the same type, Airflow 3.x dynamic task mapping eliminates the need to write one DAG per entity:

```python
@dag(dag_id="multi_domain_ingest", schedule="@daily", ...)
def multi_domain_ingest():

    @task
    def get_entity_configs():
        # Returns list of entity configs from a catalog table or config file
        return [
            {"entity": "orders", "source_path": "abfss://bronze@.../crm/orders/"},
            {"entity": "accounts", "source_path": "abfss://bronze@.../crm/accounts/"},
            {"entity": "products", "source_path": "abfss://bronze@.../erp/products/"},
        ]

    @task
    def ingest_entity(config: dict):
        # Submits one SparkApplication per entity
        from forge.sdk.spark import submit_spark_job
        submit_spark_job(
            job_name=f"ingest-{config['entity']}",
            args={"source_path": config["source_path"]},
        )

    configs = get_entity_configs()
    ingest_entity.expand(config=configs)

multi_domain_ingest()
```

Each entity becomes an independent task instance in the DAG run. They run in parallel (subject to task concurrency limits), and one entity failing does not block others.

### Branching

`BranchPythonOperator` (and the `@task.branch` decorator equivalent) is used for conditional pipeline paths — for example, deciding whether to run a full backfill or an incremental load based on the state of the Delta table:

```python
@task.branch
def choose_load_strategy(dataset: str) -> str:
    from forge.sdk.delta import get_last_watermark
    watermark = get_last_watermark(dataset)
    if watermark is None:
        return "full_load"
    else:
        return "incremental_load"
```

The branch return value is the `task_id` (or list of `task_id`s) to execute next. Unselected branches are marked `SKIPPED`, and downstream tasks use `trigger_rule="none_failed_min_one_success"` to proceed after any branch completes.

### Sensors — ExternalTaskSensor for Cross-DAG Dependencies

Some pipelines have dependencies on other DAGs completing. For example, `transform_orders` should not start until `ingest_orders` has completed for the same logical date. When these DAGs are scheduled independently (different schedules, different owners), `ExternalTaskSensor` bridges them:

```python
from airflow.sensors.external_task import ExternalTaskSensor

wait_for_ingest = ExternalTaskSensor(
    task_id="wait_for_ingest_orders",
    external_dag_id="ingest_orders",
    external_task_id="ingest_raw_orders",
    # Match the same logical date
    execution_date_fn=lambda dt: dt,
    mode="reschedule",       # frees the task slot while waiting (essential with KubernetesExecutor)
    timeout=3600,            # fail after 1 hour if upstream never completes
    poke_interval=60,        # check every 60 seconds
    allowed_states=["success"],
    failed_states=["failed", "upstream_failed"],
)
```

`mode="reschedule"` is mandatory in KubernetesExecutor. In `poke` mode, the sensor task pod would be running (and consuming a node slot) for the entire wait duration. In `reschedule` mode, the pod terminates between checks and the Triggerer handles re-scheduling, consuming zero resources while waiting.

### SLA Definitions

SLAs are defined per task on the `sla` parameter (a `timedelta` from the DAG's logical date). If the task has not completed within the SLA window, Airflow calls the `sla_miss_callback` without failing the task:

```python
from datetime import timedelta
from common.callbacks import on_sla_miss

@dag(
    dag_id="orders_pipeline",
    schedule="@daily",          # runs at 00:00 UTC
    sla_miss_callback=on_sla_miss,
)
def orders_pipeline():
    publish = SparkKubernetesOperator(
        task_id="publish_serving_orders",
        sla=timedelta(hours=2),   # Gold layer must be refreshed by 02:00 UTC
        ...
    )
```

The `on_sla_miss` callback posts a structured alert to the Teams/Slack webhook and increments the `airflow_sla_miss_total` metric (scraped by the Azure Monitor Agent), which drives the SLO dashboard burn rate alert.

---

## 7. Operator Inventory

The following operators are used in Forge DAGs. Each is part of the `forgeacr/airflow:3.1.0` image.

### SparkKubernetesOperator

**Provider:** `apache-airflow-providers-cncf-kubernetes`

**Purpose in Forge:** Submits a `SparkApplication` CRD to the compute cluster (`forge-compute`) and waits for it to reach `Completed` or `Failed` state. This is the primary mechanism for running all batch Spark jobs — ingestion, transformation, and serving materialization.

**How it works:**

1. The operator serializes the `SparkApplication` manifest (passed as `application_file` or built from individual parameters) and posts it to the compute cluster's Kubernetes API via the `compute_cluster_k8s` connection.
2. It then polls the CRD status until the application reaches a terminal state (`COMPLETED`, `FAILED`, `SUBMISSION_FAILED`).
3. On `COMPLETED`, the task succeeds. On any failure state, the task fails, Airflow retries up to `retries` times, and on exhausting retries, the `on_failure_callback` fires.

The operator itself runs in a small task pod on the orchestration cluster. The actual Spark driver and executor pods run on the compute cluster, completely separate.

**Key configuration:**

```python
SparkKubernetesOperator(
    task_id="transform_curated_orders",
    namespace="spark-jobs",                          # namespace on compute cluster
    application_file="orchestration/spark/apps/transform_orders.yaml",
    kubernetes_conn_id="compute_cluster_k8s",        # connection to compute cluster API
    do_xcom_push=True,                               # pushes spark_app_name to XCom for log links
    poll_interval=30,                                # seconds between status polls
)
```

### TrinoOperator

**Provider:** `apache-airflow-providers-trino` (or custom `orchestration/airflow/plugins/operators/trino_operator.py`)

**Purpose in Forge:** Executes SQL statements against the Trino coordinator on the compute cluster. Used for:

- Refreshing Gold layer materializations (`CREATE OR REPLACE TABLE serving.orders AS SELECT ...`)
- Running `OPTIMIZE` on small-to-medium serving tables
- Running cross-domain aggregations that fit within Trino's memory limits
- Schema registration queries (updating Hive Metastore entries for new Delta tables)

**How it works:**

The operator issues HTTP requests to the Trino coordinator REST API at `https://trino.trino.svc:8443` (via private endpoint). Authentication uses a JWT bearer token minted by Airflow's Trino connection, which stores the client credentials in Key Vault.

For long-running Trino queries, the Forge TrinoOperator uses the Triggerer (deferred mode) — it submits the query, captures the query ID, and defers. The Triggerer polls the Trino query status endpoint asynchronously until the query completes, then resumes the task pod.

### PythonOperator / @task

**Purpose in Forge:** Used for all orchestration-layer logic that does not require Spark or Trino — that is, logic that operates on metadata, configuration, or small data:

- Loading DQ rulesets and running the `DQRunner` (which may internally issue Trino queries for content checks or read Delta metadata for volume/freshness checks — all via lightweight HTTP/ADLS calls, not Spark)
- Updating the metadata catalog table after a successful pipeline run (writing schema, row count, last-refreshed timestamp)
- Computing the incremental watermark from the DQ results store and writing it to XCom for the downstream transform task to consume
- Declaring upstream source datasets for ingest jobs using the `forge-lineage` SDK (see [Lineage Architecture](10-lineage.md) Section 4)

### EmailOperator

**Purpose in Forge:** Sends notification emails for specific pipeline events where the standard Teams/Slack webhook alert is insufficient — for example, SLA breach notifications to data domain owners who are not on the platform Teams channel, or executive summaries of weekly DQ pass rates.

The `EmailOperator` uses the `smtp_default` Airflow connection, which points to the corporate SMTP relay. Credentials are in Key Vault. The operator is used sparingly — most alerts go through the webhook callback, not email.

### BranchPythonOperator / @task.branch

**Purpose in Forge:** Controls conditional pipeline paths. The two primary branch conditions in Forge DAGs are:

1. **Full load vs incremental load:** On the first ever run of a pipeline (no watermark exists in the DQ results store), take the `full_load` branch which runs a Spark job with `mode="overwrite"`. On subsequent runs, take the `incremental_load` branch which runs a Spark job with a `since` argument and `MERGE` semantics.
2. **Streaming vs batch serving:** A pipeline that feeds both a streaming and a batch serving path branches based on whether the incoming dataset was produced by a streaming job (micro-batch) or a batch job. Each branch has different freshness SLA thresholds.

---

## 8. Connection Management — Azure Key Vault Secrets Backend

### Why Connections Cannot Be Stored in the Metadata DB

By default, Airflow stores connection URIs (including passwords) in the PostgreSQL metadata database, encrypted with the Fernet key. This is insufficient for Forge's security posture for two reasons:

1. The Fernet key must be stored somewhere accessible to all Airflow components. If the Fernet key leaks, all connection secrets are exposed.
2. Rotating a connection password requires a manual update in the Airflow UI or CLI — no integration with Key Vault rotation events.

### Azure Key Vault Secrets Backend

Forge configures Airflow with the **Azure Key Vault Secrets Backend**, which routes all `Connection` and `Variable` lookups to Key Vault. No connection passwords are stored in the metadata DB.

Configuration in `airflow.cfg` (via Helm values):

```ini
[secrets]
backend = airflow.providers.microsoft.azure.secrets.key_vault.AzureKeyVaultBackend
backend_kwargs = {
  "vault_url": "https://kv-forge-prod.vault.azure.net/",
  "connections_prefix": "airflow-connections",
  "variables_prefix": "airflow-variables",
  "sep": "--"
}
```

### How Connection Lookup Works

When an operator calls `BaseHook.get_connection("compute_cluster_k8s")`, Airflow:

1. Constructs the Key Vault secret name: `airflow-connections--compute-cluster-k8s`
2. Issues a GET request to the Key Vault REST API using the `airflow-worker` workload identity OIDC token
3. Receives the secret value — a URI-encoded connection string or a JSON blob
4. Parses it into an `Airflow Connection` object and returns it to the operator

The Key Vault request is authenticated via the pod's OIDC token (workload identity). No static credentials are involved. The `id-forge-read-{env}` managed identity has `Key Vault Secrets User` role on `kv-forge-{env}`.

### Secret Naming Convention

All connection secrets follow the pattern `airflow-connections--<conn_id>` where `<conn_id>` uses hyphens (not underscores, because Key Vault secret names cannot contain underscores).

| Connection ID | Key Vault secret name | Contents |
|-------------|----------------------|---------|
| `compute_cluster_k8s` | `airflow-connections--compute-cluster-k8s` | kubeconfig JSON for `forge-compute` AKS cluster |
| `trino_default` | `airflow-connections--trino-default` | Trino HTTPS endpoint, JWT auth |
| `smtp_default` | `airflow-connections--smtp-default` | SMTP relay host, port, credentials |
| `adls_default` (lineage via workload identity) | — | OpenLineage transport uses `azure_identity` auth; no explicit Airflow connection needed |
| `adls_default` | `airflow-connections--adls-default` | ADLS account URL (workload identity; no key) |
| `source_crm_db` | `airflow-connections--source-crm-db` | CRM database JDBC URL, credentials |

### Airflow Variables in Key Vault

Airflow Variables (non-secret configuration values) are also stored in Key Vault under the `airflow-variables` prefix. Example:

- `airflow-variables--adls-account-name` → `forgedevacc`
- `airflow-variables--openlineage-namespace` → `forge-prod`
- `airflow-variables--dq-results-table` → `abfss://silver@forgedevacc.dfs.core.windows.net/_platform/dq_results/`

---

## 9. Airflow Webserver — Authentication and RBAC

### OIDC via Azure AD

The Airflow webserver uses **Azure AD as the OIDC identity provider**. Users are not created in Airflow's local user database — every login goes through Azure AD, enforcing corporate MFA and conditional access policies automatically.

Configuration uses Flask-AppBuilder's OIDC integration via the `AUTH_TYPE = AUTH_OID` setting. The Azure AD app registration is stored in Key Vault as `airflow-connections--azure-ad-oidc`.

The OIDC flow:

```
User navigates to https://airflow.forge.internal
          │
          │  redirect to Azure AD login
          ▼
Azure AD authenticates user (MFA required)
          │
          │  ID token + access token returned
          ▼
Airflow webserver validates token against OIDC discovery document
          │
          │  maps user's Azure AD groups to Airflow RBAC roles (see below)
          ▼
User sees Airflow UI with permissions per their role
```

The OIDC callback URL is `https://airflow.forge.internal/oidc/callback`, served through the Application Gateway (WAF v2) which terminates TLS and forwards to the `airflow-webserver` service on the orchestration cluster.

### RBAC Roles

Airflow's built-in RBAC roles map to Azure AD group membership via a custom `AUTH_ROLES_MAPPING` in the webserver config:

| Azure AD Group | Airflow Role | Permissions |
|---------------|-------------|------------|
| `sg-forge-platform-admin` | `Admin` | Full access: all DAGs, connections, users, pools, configurations |
| `sg-forge-data-engineer` | `Op` | View and trigger all DAGs; view connections; no user/config management |
| `sg-forge-analyst` | `User` | View all DAGs and run history; trigger DAGs in assigned domains only |
| `sg-forge-readonly` | `Viewer` | View DAGs, run history, and task logs; no triggering |

Role mapping configuration (in `webserver_config.py`):

```python
AUTH_ROLES_MAPPING = {
    "sg-forge-platform-admin": ["Admin"],
    "sg-forge-data-engineer": ["Op"],
    "sg-forge-analyst": ["User"],
    "sg-forge-readonly": ["Viewer"],
}
AUTH_ROLES_SYNC_AT_LOGIN = True   # roles updated on every login, not just first
```

### Accessing the Webserver

The Airflow UI is accessible at `https://airflow.forge.internal` from the corporate network or VPN. It is not exposed to the public internet. Traffic path:

```
Corporate laptop (on VPN)
        │  HTTPS
        ▼
Azure Application Gateway (WAF v2)
        │  private routing (internal listener)
        ▼
Kubernetes Ingress (NGINX)
        │
        ▼
airflow-webserver Service (ClusterIP :8080)
        │
        ▼
Airflow webserver pod
```

TLS termination is at the Application Gateway. The internal path uses HTTP (the cluster is private; no external path exists). Certificate is issued by the corporate CA, not a public CA.

---

## 10. Scheduler High Availability

### Multiple Schedulers

Forge runs **two Airflow scheduler replicas** in HA mode. Both schedulers are active simultaneously — this is Airflow's native HA model since version 3.0, based on database-level row locking.

How it works:

- Both schedulers continuously parse DAG files and compute the set of task instances that should be queued
- When a scheduler decides to queue a task instance, it acquires a database-level lock on that row in the `task_instance` table
- The scheduler that wins the lock owns the task: it creates the Kubernetes pod and is responsible for monitoring it
- If that scheduler crashes mid-task, the task instance remains in `RUNNING` state until the `task_adoption_timeout` is reached (default: 600s). The surviving scheduler then "adopts" the orphaned task instance — it finds the corresponding pod (still running on Kubernetes) and resumes monitoring it

This means no task is lost when one scheduler crashes. The task pod continues running on Kubernetes regardless of which scheduler is watching it.

### Heartbeat Monitoring

Each scheduler updates a `last_heartbeat` timestamp in the `scheduler_job` table every 5 seconds. The `airflow_scheduler_heartbeat` metric is exported via the statsd exporter and scraped by the Azure Monitor Agent (AMA).

The Azure Managed Grafana "Airflow Health" dashboard plots this metric and the Azure Monitor Alert rule fires when the heartbeat gap exceeds 30 seconds:

```yaml
# alertmanager rule
- alert: AirflowSchedulerHeartbeatLost
  expr: time() - airflow_scheduler_heartbeat > 30
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Airflow scheduler heartbeat lost — no heartbeat for >30s"
```

### Failover

When a scheduler pod is killed (node failure, rolling restart, OOM), Kubernetes creates a replacement pod (due to the `Deployment` controller). The replacement pod starts, connects to PostgreSQL, and immediately begins the scheduler loop. It picks up any DAG runs that were in progress, adopts orphaned task instances, and resumes normal operation.

The failover time is: pod scheduling time (~10s) + Airflow scheduler startup time (~15s) = ~25 seconds. During this window, the surviving scheduler continues operating normally for the tasks it owned.

There is no split-brain risk because all state is in PostgreSQL, not in-memory in the scheduler process.

---

## 11. Triggerer — Deferred Operators

### What the Triggerer Does

The Triggerer is a separate Airflow process (running as its own pod) that manages **deferred operators** — operators that are waiting for an external condition and do not need an active task pod to poll.

Without the Triggerer (in classic sensor mode), a sensor task pod would run continuously (consuming a Kubernetes pod slot and CPU cycles) while waiting for the condition to be true. With the Triggerer, the sensor:

1. Starts in a task pod, submits whatever async operation it is waiting for, and registers a **Trigger** (a small Python coroutine) with the Triggerer
2. The task pod **terminates** — releasing its Kubernetes pod slot
3. The Triggerer runs all registered Triggers as async coroutines in a single process (using `asyncio`), polling their conditions concurrently
4. When a trigger's condition is met, the Triggerer re-queues the task instance — the scheduler creates a new task pod which resumes from where it paused

This means 100 concurrent sensors consume one Triggerer process, not 100 task pods.

### Operators Using the Triggerer in Forge

| Operator | Condition waited for | Trigger used |
|----------|---------------------|-------------|
| `ExternalTaskSensor` (mode=reschedule) | Upstream task instance success | `TaskStateTrigger` |
| `SparkKubernetesOperator` (deferrable=True) | SparkApplication terminal state | `SparkKubernetesTrigger` |
| `TrinoOperator` (deferrable=True) | Trino query completion | Custom `TrinoQueryTrigger` |
| `DateTimeSensor` | Wall clock time reached | `DateTimeTrigger` |

The deferrable version of `SparkKubernetesOperator` is particularly valuable: the operator submits the SparkApplication CRD, defers immediately (pod terminates), and the Triggerer polls the SparkApplication status every 30 seconds. This means a 45-minute Spark job does not hold a task pod for 45 minutes — it holds it for ~5 seconds (submit) and ~5 seconds (on completion). Node slots are freed for other tasks during the job.

### Triggerer Sizing

The Triggerer is a single pod running on the `airflow` node pool. A single Triggerer can handle hundreds of concurrent triggers (limited by async task concurrency, not memory). The default configuration uses 1 replica with a liveness probe on the trigger heartbeat endpoint. If the Triggerer pod is killed, Kubernetes replaces it in ~20 seconds; during this window, deferred tasks remain suspended and are resumed when the new Triggerer starts and reloads the trigger state from the metadata DB.

---

## 12. PostgreSQL Metadata Database

### Why PostgreSQL

Airflow's metadata database is the single source of truth for all DAG definitions (serialized), DAG run states, task instance states, XCom values, connections (when not using Key Vault backend), variables, SLA misses, and job heartbeats.

SQLite (Airflow's embedded option) is unsuitable for production because:
- No concurrent write support: multiple schedulers cannot operate simultaneously
- No network access: every Airflow component (scheduler, webserver, triggerer, task pods) must be on the same host
- No replication, backup, or HA

PostgreSQL is the Airflow-recommended production database. Forge uses **Azure Database for PostgreSQL Flexible Server** with:

- Private endpoint (no public internet access)
- Zone-redundant HA (primary + standby in separate availability zones, automatic failover in ~60 seconds)
- Point-in-time restore (35-day retention)
- Storage auto-grow enabled
- SSL required for all connections (`sslmode=require`)

### Schema Overview

The Airflow metadata DB schema (managed by Alembic migrations, run automatically on pod startup) contains the following key tables:

| Table | Contents |
|-------|---------|
| `dag` | One row per DAG: `dag_id`, schedule, `is_active`, `is_paused`, fileloc, `last_parsed_time` |
| `serialized_dag` | Serialized (JSON) DAG definition per `dag_id`. Read by scheduler and webserver. Updated on every DAG file change. |
| `dag_run` | One row per DAG run: `run_id`, `dag_id`, `logical_date`, `state`, `start_date`, `end_date` |
| `task_instance` | One row per task per DAG run: state, `start_date`, `end_date`, `hostname`, `unixname`, `pool`, `queue` |
| `xcom` | XCom values: `dag_id`, `run_id`, `task_id`, `key`, `value` (pickled bytes) |
| `connection` | Connection entries (used only for non-secret metadata when Key Vault backend is active) |
| `variable` | Variable entries (used only for non-secret values when Key Vault backend is active) |
| `sla_miss` | SLA miss events: `dag_id`, `task_id`, `execution_date`, `email_sent`, `notification_sent` |
| `scheduler_job` | Scheduler heartbeat rows: one per scheduler replica, `last_heartbeat`, `state` |
| `trigger` | Deferred trigger state: `trigger_id`, `classpath`, `kwargs`, `created_date`, `triggerer_id` |
| `import_error` | DAG parsing errors: `dag_id`, `filename`, `stacktrace`, `timestamp` |

The metadata DB is **not** used to store pipeline results, DQ reports, or any data payload. It stores only Airflow's control plane state. Data results go to ADLS Delta tables.

### Maintenance

- `airflow db clean` runs weekly (via a maintenance DAG) to purge task instances and DAG runs older than 90 days. This keeps the `task_instance` and `dag_run` tables from growing unboundedly.
- PostgreSQL VACUUM runs automatically (autovacuum enabled).
- The Flexible Server is backed up continuously; point-in-time restore is available for 35 days.

---

## 13. Log Handling — Azure Log Analytics and ADLS

### Log Sources

Airflow task logs are the primary diagnostic tool when a task fails. In Forge, logs are handled at two levels:

1. **Pod logs (stdout/stderr):** Every task pod writes its log output to stdout. The Azure Monitor Agent (AMA), running as a DaemonSet on every node, collects pod logs and ships them to the Azure Log Analytics Workspace. Logs are indexed with pod metadata fields (`dag_id`, `task_id`, `run_id`).

2. **Remote log storage (ADLS):** Airflow is configured to write task logs to ADLS as well as to stdout. This provides longer retention (30 days in ADLS vs the Log Analytics default) and allows the Airflow webserver's "Log" tab to fetch logs for completed tasks whose pods have been garbage-collected.

### Remote Log Configuration

```ini
[logging]
remote_logging = True
remote_base_log_folder = abfss://code@<account>.dfs.core.windows.net/airflow-logs
remote_log_conn_id = adls_default
```

Log path in ADLS:

```
airflow-logs/
└── dag_id={dag_id}/
    └── run_id={run_id}/
        └── task_id={task_id}/
            └── attempt={try_number}.log
```

### Querying Logs in Azure Log Analytics

From Azure Managed Grafana, task logs are queryable with KQL:

```kql
ContainerLogV2
| where Namespace == "airflow" and TimeGenerated > ago(24h)
| extend parsed = parse_json(LogMessage)
| where parsed.dag_id == "orders_pipeline" and parsed.task_id == "validate_dq"
| where parsed.level == "ERROR"
| project TimeGenerated, tostring(parsed.ts), tostring(parsed.level), tostring(parsed.message)
```

The Azure Managed Grafana "Airflow Health" dashboard includes a pre-built log panel that filters by DAG and task ID. Data engineers can also drill directly from a failed task in the Airflow UI to the corresponding Log Analytics query via a configured external log link.

### Log Retention

| Log destination | Retention | Access method |
|----------------|-----------|---------------|
| Azure Log Analytics Workspace | 30 days (default; configurable) | Azure Managed Grafana KQL, Airflow webserver log tab |
| ADLS (`airflow-logs/`) | 30 days (lifecycle policy) | Airflow webserver log tab (remote log fetch), direct ADLS access |

---

## 14. Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                    forge-orchestration AKS Cluster                             ║
║                                                                                  ║
║  ┌──────────────────────────────────────────────────────────────────────────┐   ║
║  │  airflow namespace                                                        │   ║
║  │                                                                           │   ║
║  │  ┌───────────────┐   ┌───────────────┐   ┌───────────────────────────┐  │   ║
║  │  │  Scheduler A  │   │  Scheduler B  │   │  Webserver (x2)           │  │   ║
║  │  │  (active)     │   │  (active)     │   │  OIDC → Azure AD          │  │   ║
║  │  │  + git-sync   │   │  + git-sync   │   │  + git-sync sidecar       │  │   ║
║  │  └──────┬────────┘   └───────┬───────┘   └───────────────────────────┘  │   ║
║  │         │                    │                          │                 │   ║
║  │         │  heartbeat         │  heartbeat               │ reads           │   ║
║  │         └────────────────────┴──────────────────────────┼────────────┐   │   ║
║  │                                                          │            │   │   ║
║  │                                                          ▼            ▼   │   ║
║  │                                               ┌──────────────────────────┐│  ║
║  │                                               │  PostgreSQL (ADPG)       ││  ║
║  │                                               │  metadata DB             ││  ║
║  │                                               │  • dag / dag_run         ││  ║
║  │                                               │  • task_instance         ││  ║
║  │                                               │  • xcom / trigger        ││  ║
║  │                                               │  private endpoint        ││  ║
║  │                                               └──────────────────────────┘│  ║
║  │                                                                            │  ║
║  │  ┌───────────────┐                                                         │  ║
║  │  │  Triggerer    │  ← manages deferred triggers (async polling)            │  ║
║  │  └───────┬───────┘                                                         │  ║
║  │          │  re-queues tasks when trigger fires                             │  ║
║  │          ▼                                                                  │  ║
║  │  ┌──────────────────────────────────────────────────────────────────────┐ │  ║
║  │  │  Task Pods (ephemeral, one per task instance)                        │ │  ║
║  │  │                                                                      │ │  ║
║  │  │  ┌─────────────────────┐  ┌─────────────────────┐                   │ │  ║
║  │  │  │ SparkKubernetes     │  │ @task (Python)       │                   │ │  ║
║  │  │  │ Operator task pod   │  │ DQRunner, catalog,   │                   │ │  ║
║  │  │  │ • submits CRD       │  │ watermark, lineage   │                   │ │  ║
║  │  │  │ • polls status      │  │ calls                │                   │ │  ║
║  │  │  └──────────┬──────────┘  └──────────┬──────────┘                   │ │  ║
║  │  │             │                         │                               │ │  ║
║  │  └─────────────┼─────────────────────────┼───────────────────────────── ┘ │  ║
║  └────────────────┼─────────────────────────┼────────────────────────────────┘  ║
║                   │                         │                                    ║
╚═══════════════════╪═════════════════════════╪════════════════════════════════════╝
                    │                         │
    kubectl apply   │              ┌───────────┘
    SparkApp CRD    │              │  Trino SQL (HTTP)
                    │              │  Purview OpenLineage endpoint (HTTPS, workload identity)
                    │              │  ADLS (HTTPS, workload identity)
                    ▼              ▼
╔══════════════════════════════════════════════════════════════════════════════════╗
║                    forge-compute AKS Cluster                                   ║
║                                                                                  ║
║  ┌───────────────────────────────────────────────────┐                          ║
║  │  spark-jobs namespace                              │                          ║
║  │                                                    │                          ║
║  │  ┌──────────────────────────────────────────────┐ │                          ║
║  │  │  Spark Operator (watches spark-jobs ns)       │ │                          ║
║  │  │  • creates Driver Pod on CRD apply            │ │                          ║
║  │  │  • creates Executor Pods (dynamic alloc)      │ │                          ║
║  │  │  • monitors until Completed/Failed            │ │                          ║
║  │  └──────────────────────────────────────────────┘ │                          ║
║  │                                                    │                          ║
║  │  ┌──────────────┐    ┌──────────────────────────┐ │                          ║
║  │  │ Driver Pod   │───▶│ Executor Pods (2–50)      │ │                          ║
║  │  │ (1 per job)  │    │ (spot node pool)          │ │                          ║
║  │  └──────────────┘    └──────────────────────────┘ │                          ║
║  └───────────────────────────────────────────────────┘                          ║
║                                                                                  ║
║  ┌──────────────────────────────┐                                                ║
║  │  trino namespace             │                                                 ║
║  │  Coordinator (x2) + Workers  │                                                 ║
║  └──────────────────────────────┘                                                ║
╚══════════════════════════════════════════════════════════════════════════════════╝
                    │
                    ▼
╔══════════════════════════════════════════════════════════════════════════════════╗
║                    Shared Azure Resources                                        ║
║                                                                                  ║
║  ┌──────────────────────────┐   ┌──────────────────────────┐                   ║
║  │  Azure Key Vault          │   │  ADLS Gen2               │                   ║
║  │  kv-forge-{env}         │   │  bronze/ silver/ gold/   │                   ║
║  │  • airflow connections    │   │  _platform/dq_results/   │                   ║
║  │  • airflow variables      │   │  airflow-logs/           │                   ║
║  │  • kubeconfig             │   └──────────────────────────┘                   ║
║  │  • OIDC secrets           │                                                   ║
║  └──────────────────────────┘   ┌──────────────────────────┐                   ║
║                                  │  Azure Log Analytics      │                   ║
║  ┌──────────────────────────┐   │  pod log aggregation      │                   ║
║  │  Microsoft Purview        │   │  configurable retention   │                   ║
║  │  (managed service)        │   └──────────────────────────┘                   ║
║  │  OpenLineage endpoint     │                                                   ║
║  └──────────────────────────┘                                                   ║
╚══════════════════════════════════════════════════════════════════════════════════╝


DATA FLOW THROUGH THE ORCHESTRATION LAYER
─────────────────────────────────────────

Git commit to orchestration/airflow/dags/
          │
          │  git-sync pulls within 60s
          ▼
Scheduler parses DAG → serializes to PostgreSQL
          │
          │  logical_date reached / manual trigger
          ▼
Scheduler creates DAG run in task_instance table
          │
          │  task ready (dependencies met)
          ▼
Scheduler creates Task Pod via Kubernetes API
          │
          ├─► SparkKubernetesOperator task pod
          │       │  submits SparkApplication CRD to compute cluster
          │       │  defers to Triggerer (SparkKubernetesTrigger)
          │       │  [pod terminates]
          │       │  Triggerer polls SparkApp status every 30s
          │       │  SparkApp reaches Completed
          │       │  Triggerer re-queues task
          │       │  new task pod starts, marks task SUCCESS
          │       │  OpenLineage COMPLETE event → Purview
          │       ▼
          │   Task state: SUCCESS in PostgreSQL
          │
          ├─► @task (DQRunner) task pod
          │       │  loads YAML ruleset from ADLS
          │       │  runs checks (Trino SQL + Delta metadata)
          │       │  writes DQRunReport to _platform/dq_results/ Delta table
          │       │  emits DQ facet to Purview (via OpenLineage)
          │       │  if CRITICAL failure → raises exception → task FAILED
          │       │  Airflow marks downstream tasks UPSTREAM_FAILED
          │       │  AlertReporter posts webhook to Teams
          │       ▼
          │   Task state: SUCCESS or FAILED in PostgreSQL
          │
          └─► TrinoOperator task pod (deferrable)
                  │  submits SQL to Trino coordinator
                  │  defers to Triggerer (TrinoQueryTrigger)
                  │  [pod terminates]
                  │  Triggerer polls Trino query status endpoint
                  │  Query completes
                  │  Triggerer re-queues task
                  │  new task pod marks task SUCCESS
                  ▼
              Task state: SUCCESS in PostgreSQL
```

---

## 15. Upgrade Strategy

### Principles

Airflow upgrades in Forge follow these constraints:
1. No DAG downtime — in-progress DAG runs must complete uninterrupted
2. No metadata DB data loss
3. Rollback must be possible if the new version is found defective within 24 hours
4. The upgrade must be testable in the dev environment before touching staging or production

### Pre-Upgrade Checklist

Before upgrading to a new Airflow minor version (`3.0 → 3.1`, for example):

1. **Read the migration guide.** Check the Airflow release notes for deprecated providers, config changes, and metadata DB migration steps.
2. **Test all DAGs in dev.** Deploy the new image to `forge-orchestration-dev`. Run every DAG. Check for import errors (`airflow dags list-import-errors`), behavior changes, and provider compatibility.
3. **Check provider versions.** The `apache-airflow-providers-cncf-kubernetes`, `apache-airflow-providers-microsoft-azure`, and `openlineage-airflow` packages must be compatible with the new Airflow version. Update `infra/docker/airflow/Dockerfile` accordingly.
4. **Validate the metadata DB migration.** Run `airflow db migrate --dry-run` on a copy of the production DB to verify the Alembic migrations apply cleanly.
5. **Build and scan the new image.** Push `forgeacr/airflow:<new-version>` through the import pipeline (including Microsoft Defender for Containers scan).

### Upgrade Execution

The upgrade is a Helm chart update changing the image tag. The rollout strategy for the Airflow Deployment is `RollingUpdate` with `maxUnavailable: 0` and `maxSurge: 1`.

```
Step 1: Pause all DAGs (prevents new runs from starting)
        airflow dags pause --all

Step 2: Wait for in-flight task instances to complete
        Monitor: airflow tasks states-for-dag-run [running dag runs]
        Timeout: 60 minutes (any task running > 60 min is considered stuck)

Step 3: Deploy new Helm chart (new image tag)
        helm upgrade airflow infra/helm/orchestration/airflow \
          --set image.tag=2.10.0 \
          -n airflow

Step 4: Kubernetes performs rolling restart of scheduler and webserver pods
        • New scheduler pod starts, runs: airflow db migrate
        • Alembic applies any schema migrations to PostgreSQL
        • New scheduler becomes active
        • Old scheduler pod is terminated

Step 5: Validate
        • airflow scheduler: check heartbeat metric in Azure Managed Grafana
        • airflow dags list-import-errors: must return zero rows
        • airflow dags list: all expected DAGs present and active

Step 6: Unpause all DAGs
        airflow dags unpause --all

Step 7: Trigger a test DAG run on each domain
        Verify task execution, log capture, DQ run, lineage emission
```

### Rollback

If a defect is found within 24 hours of the upgrade:

```
Step 1: Pause all DAGs again
Step 2: Wait for in-flight tasks to complete
Step 3: Helm rollback
        helm rollback airflow -n airflow
        # This re-deploys the previous image tag
Step 4: airflow db downgrade --to <previous-revision>
        # Reverses any Alembic migrations (only possible if migrations are reversible)
Step 5: Validate and unpause DAGs
```

If the Alembic migration is not reversible (some Airflow versions add non-reversible schema changes), the rollback requires restoring the PostgreSQL Flexible Server from point-in-time backup to the snapshot taken immediately before the upgrade. This is documented in the runbook at `docs/runbooks/airflow-upgrade-rollback.md`.

### DAG Compatibility During Upgrade

DAG Python files themselves do not need to be updated for a minor Airflow version upgrade unless deprecated APIs are removed. The strategy is:

- **Minor version (3.0 → 3.1):** DAGs using the TaskFlow API and standard providers require no changes. Any use of deprecated operators is caught in the dev environment test.
- **Major version (2.x → 3.x):** A compatibility sweep of all DAGs is required. Run `airflow upgrade-check` (included in the Airflow CLI) to enumerate all deprecated API usages.

The `git-sync` sidecar means DAG files do not need redeployment separately from the image upgrade — they are always the latest Git commit.

---

## 16. Dev Environment Guardrails

Dev is a shared, cost-controlled environment. The following rules are enforced automatically by the **`forge_dev_policy`** Airflow plugin, which runs at DAG parse time. They cannot be overridden by individual DAG authors — they are platform-level controls.

### Per-User DAG Limit

Each engineer may have **at most 5 active DAGs** in dev at any time. Attempting to register a 6th DAG causes a parse-time error:

```
[forge-dev-policy] User 'alias' already has 5 active DAG(s) in dev (limit: 5).
Delete an existing DAG before registering a new one.
```

To add a new DAG: delete or deactivate an existing one via the Airflow UI or `airflow dags delete <dag_id>`.

### Auto-Expire After 5 Days

Every DAG in dev has its `end_date` capped to `start_date + 5 days`. After that window, no new runs are triggered. The DAG stays visible in the UI but becomes inactive.

To extend a DAG: update its `start_date` and re-sync. This is intentional — it forces engineers to be explicit about what is actively running in dev.

### No Catchup

`catchup = False` is enforced on all DAGs in dev regardless of what the DAG file specifies. Missed schedule intervals are never backfilled.

### Start Date Ceiling

DAGs with a `start_date` older than 30 days are rejected at parse time. This prevents accidental large backfill windows if catchup is somehow re-enabled.

### Concurrency Caps

Set at the Airflow config level (not per-DAG):

| Setting | Dev Value | Prod Value |
|---------|-----------|------------|
| `parallelism` (total concurrent tasks) | 20 | 200 |
| `max_active_runs_per_dag` | 2 | 5 |
| `max_active_tasks_per_dag` | 5 | unlimited |

### None of These Apply in Prod

The policy checks `FORGE_ENV` at startup. In prod, the function returns immediately — no restrictions are applied.

---

## 17. Production Sizing — 150+ Scheduled Jobs

### Executor

Prod uses **KubernetesExecutor**: each task gets a dedicated pod. No shared scheduler process, no single point of failure, horizontal scaling with cluster autoscaler.

### Orchestration Cluster Node Pools

| Pool | VM Size | Nodes | Runs |
|------|---------|-------|------|
| System | Standard_D8s_v5 (8c/32g) | 3 fixed | K8s system pods |
| Airflow | Standard_D8s_v5 (8c/32g) | 3–5 autoscale | Scheduler, webserver, triggerer, DAG processor, portal |
| Task | Standard_D4s_v5 (4c/16g) | 2–8 autoscale | KubernetesExecutor task pods (non-Spark) |

Spark tasks submit SparkApplication CRDs to the **compute cluster** — they do not consume orchestration node capacity.

### Airflow Component Replicas (Prod)

| Component | Replicas | CPU | RAM |
|-----------|----------|-----|-----|
| Scheduler | 2 | 4 vCPU | 8 GB |
| DAG Processor | 2 | 4 vCPU | 8 GB |
| Webserver | 2 | 2 vCPU | 4 GB |
| Triggerer | 2 | 2 vCPU | 4 GB |

### PostgreSQL (Prod)

| Setting | Value |
|---------|-------|
| SKU | General Purpose, 8 vCores |
| RAM | 64 GB |
| Storage | 256 GB |
| Connection pooling | PgBouncer required |

At 150+ concurrent tasks, each KubernetesExecutor task pod holds a Postgres connection. PgBouncer pools these into a smaller set of real server connections — without it, Postgres runs out of connections under peak load.

### Key Airflow Config Differences (Dev vs Prod)

| Setting | Dev | Prod |
|---------|-----|------|
| Executor | LocalExecutor | KubernetesExecutor |
| `parallelism` | 20 | 200 |
| Scheduler replicas | 1 | 2 |
| DAG Processor replicas | 1 | 2 |
| Per-user DAG limit | 5 | None |
| Auto-expire | 5 days | None |
| PgBouncer | No | Yes |
