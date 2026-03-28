# Forge — Compute Architecture

> **Version:** 1.0
> **Status:** Current
> **Audience:** Platform engineers, data engineers, architects

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Delta Lake](https://img.shields.io/badge/Delta%20Lake-003366?style=flat-square&logo=delta&logoColor=white)](https://delta.io)

---

## Table of Contents

1. [Spark Operator](#1-spark-operator)
2. [Spark Connect Server](#2-spark-connect-server)
3. [Spark ADLS Access](#3-spark-adls-access)
4. [Spark Configuration Hierarchy](#4-spark-configuration-hierarchy)
5. [Node Pool Assignment](#5-node-pool-assignment)
6. [Trino Cluster](#6-trino-cluster)
7. [Trino ADLS Access](#7-trino-adls-access)
8. [Trino Authentication](#8-trino-authentication)
9. [Trino Autoscaling](#9-trino-autoscaling)
10. [Hive Metastore](#10-hive-metastore)
11. [Compute Cost Tracking](#11-compute-cost-tracking)
12. [Full Compute Cluster Topology](#12-full-compute-cluster-topology)

---

## 1. Spark Operator

### Overview

The Spark Operator (version 2.5.0, deployed to namespace `spark-system` on the `forge-compute` AKS cluster) implements the Kubernetes operator pattern for Apache Spark. It introduces a Custom Resource Definition (CRD) called `SparkApplication` into the `sparkoperator.k8s.io/v1beta2` API group. Instead of using `spark-submit` directly, every Spark job in Forge is described as a `SparkApplication` manifest and applied to the cluster. The operator handles the entire lifecycle from that point: launching pods, monitoring progress, handling retries, and cleaning up.

### SparkApplication CRD

A `SparkApplication` is a Kubernetes custom resource. The operator's controller loop watches the `spark-jobs` namespace for new and updated `SparkApplication` objects and acts on them. A representative manifest for a curated transform job looks like this:

```yaml
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: transform-orders-20260324
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "forgeacr-prod.azurecr.io/spark:4.1.0"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@forgeprodadls.dfs.core.windows.net/jobs/transform_orders.py"
  arguments:
    - "--run-date=2026-03-24"
    - "--env=prod"
  sparkVersion: "4.1.0"
  restartPolicy:
    type: OnFailure
    onFailureRetries: 1
    onFailureRetryInterval: 10
    onSubmissionFailureRetries: 3
    onSubmissionFailureRetryInterval: 20
  driver:
    cores: 2
    memory: "4g"
    serviceAccount: spark
    labels:
      workload: spark-driver
    annotations:
      azure.workload.identity/use: "true"
    nodeSelector:
      agentpool: spark
    tolerations:
      - key: "workload"
        operator: "Equal"
        value: "spark"
        effect: "NoSchedule"
  executor:
    cores: 4
    instances: 2
    memory: "8g"
    labels:
      workload: spark-executor
    nodeSelector:
      agentpool: spark
    tolerations:
      - key: "workload"
        operator: "Equal"
        value: "spark"
        effect: "NoSchedule"
      - key: "kubernetes.azure.com/scalesetpriority"
        operator: "Equal"
        value: "spot"
        effect: "NoSchedule"
  dynamicAllocation:
    enabled: true
    initialExecutors: 2
    minExecutors: 2
    maxExecutors: 50
    shuffleTrackingEnabled: false
  sparkConf:
    "spark.shuffle.service.enabled": "true"
    "spark.shuffle.service.port": "7337"
    "spark.dynamicAllocation.shuffleTracking.enabled": "false"
    "spark.sql.extensions": "io.delta.sql.DeltaSparkSessionExtension"
    "spark.sql.catalog.spark_catalog": "org.apache.spark.sql.delta.catalog.DeltaCatalog"
```

### Driver and Executor Pod Lifecycle

The lifecycle of a single `SparkApplication` run proceeds through these states:

```
SparkApplication created (kubectl apply / Airflow SparkKubernetesOperator)
        │
        ▼
SUBMITTED — Operator validates the spec, constructs driver pod spec
        │
        ▼
RUNNING (driver phase)
  • Operator creates Driver Pod in spark-jobs namespace
  • Driver pod starts JVM, initialises SparkContext
  • Driver connects to Kubernetes API to request executor pods
  • Spark Operator admission webhook mutates driver pod spec
        │
        ▼
RUNNING (executor phase)
  • Kubernetes scheduler places executor pods on spark node pool nodes
  • Executors register with driver via driver service (ClusterIP)
  • External Shuffle Service (daemonset) on each node registers with executors
  • Dynamic allocation: executor count grows from initialExecutors toward maxExecutors
        │
        ▼  (on completion)
COMPLETED or FAILED
  • Driver pod terminates
  • Executor pods terminate
  • Operator writes final status to SparkApplication .status field
  • Airflow SparkKubernetesOperator sensor reads status and marks task done
  • After ttlSecondsAfterFinished (default: 600), operator deletes pods
```

**Driver pod** runs one per job. It hosts the SparkContext, the DAGScheduler, the TaskScheduler, and the BlockManagerMaster. The driver is not spot-eligible — it runs on on-demand capacity within the `spark` node pool to avoid preemption interrupting job coordination.

**Executor pods** are ephemeral compute workers. Each executor hosts one BlockManager and multiple task threads (one per core). Executors run on spot capacity within the `spark` node pool. If a spot node is preempted, the executor pods on that node are lost; the External Shuffle Service (described below) allows in-flight shuffle data to survive executor loss.

**Driver Service**: The operator automatically creates a `ClusterIP` Service named `<app-name>-driver-svc` that exposes the driver's SparkBlockManager port (7079) and driver port (4040) to executors within the cluster. Executors use this service to register with the driver at startup.

### Resource Management

Resource requests and limits are set per the `SparkApplication` spec and are enforced by the Kubernetes scheduler. The Spark Operator translates driver/executor memory specs into pod `resources.requests` and `resources.limits`:

- `driver.memory: "4g"` becomes `requests.memory: 4096Mi` and `limits.memory: 4608Mi` (Spark adds a 15% JVM overhead margin by default, configurable via `spark.driver.memoryOverheadFactor`)
- `executor.memory: "8g"` becomes `requests.memory: 8192Mi` with overhead

CPU requests are set to `executor.cores` and limits are left unset (Spark executors are CPU-burstable by default). This can be tightened per job via `sparkConf` overrides.

Resource Quotas are enforced at the `spark-jobs` namespace level:
- Max total executor pods: 200
- Max total executor CPU: 800 cores
- Max total executor memory: 3200Gi

### Webhook Admission Control

The Spark Operator deploys a **MutatingWebhookConfiguration** named `spark-operator-webhook`. This webhook intercepts pod creation requests in the `spark-jobs` namespace (matching the label `spark-role: driver` or `spark-role: executor`) before the pod is admitted by the API server.

The webhook performs the following mutations:

1. **Workload identity injection**: Adds the `azure.workload.identity/use: "true"` annotation and the projected service account token volume mount so that the pod can acquire Azure AD tokens without any code change.
2. **Node affinity injection**: Appends a `requiredDuringSchedulingIgnoredDuringExecution` affinity rule ensuring the pod lands on the `spark` node pool (matching `agentpool: spark`).
3. **Spot toleration injection** (executors only): Adds `kubernetes.azure.com/scalesetpriority=spot:NoSchedule` toleration so executor pods can be scheduled on spot nodes.
4. **ConfigMap volume injection**: Mounts `spark-defaults-cm` as a volume at `/opt/spark/conf/`, providing cluster-wide `spark-defaults.conf`.
5. **Environment variable injection**: Injects `SPARK_CONF_DIR=/opt/spark/conf/` so the Spark JVM picks up the mounted defaults.

This means job authors do not need to repeat these configurations in every `SparkApplication` manifest — the webhook guarantees they are always applied.

### Batch Scheduler

The Spark Operator supports integration with gang-scheduling batch schedulers (e.g., Volcano, YuniKorn). In Forge, this integration is **intentionally disabled**. The reasoning:

- Gang scheduling requires all driver + executor pods to be scheduled atomically, which can starve smaller jobs when large jobs are queued
- Dynamic allocation (see below) makes gang scheduling unnecessary — jobs start with a small initial executor count and grow as tasks demand
- Volcano or YuniKorn add operational complexity (additional CRDs, controllers, scheduling policies) that is not warranted at current job concurrency levels

The `batchScheduler` field is left unset in all `SparkApplication` specs and the Spark Operator is deployed with `--enable-batch-scheduler=false`.

### Dynamic Allocation with External Shuffle Service

Spark dynamic allocation allows the number of executors to grow and shrink during a job's execution, rather than holding a fixed executor count for the job's entire duration. This is critical for cost efficiency on long-running transform jobs where data volume varies by pipeline stage.

**Configuration:**

```
spark.dynamicAllocation.enabled              = true
spark.dynamicAllocation.initialExecutors     = 2
spark.dynamicAllocation.minExecutors         = 2
spark.dynamicAllocation.maxExecutors         = 50
spark.dynamicAllocation.executorIdleTimeout  = 60s
spark.dynamicAllocation.schedulerBacklogTimeout = 1s
```

Dynamic allocation on Kubernetes normally requires `spark.dynamicAllocation.shuffleTracking.enabled = true` (shuffle-tracking mode), which uses Spark's internal tracking of which executors hold live shuffle data to prevent premature decommissioning. However, Forge uses **External Shuffle Service (ESS)** instead, which is the preferred approach for spot-tolerant deployments:

**External Shuffle Service:**

ESS is a long-running daemon (separate from executors) that serves shuffle blocks independently of executor lifetime. It runs as a **DaemonSet** (`spark-shuffle-service`) on every node in the `spark` node pool, listening on port 7337.

```
Node (spark pool)
├── spark-shuffle-service pod (DaemonSet, always running on node)
│   └── serves shuffle blocks from local disk to remote executors
│
├── executor-A pod (may be killed by spot preemption)
│   └── writes shuffle output to local disk
│       └── registered with ESS on same node
│
└── executor-B pod (replacement, on same node)
    └── reads shuffle blocks from ESS (not from executor-A directly)
```

When a spot node is preempted:
1. The executor pods on that node are killed
2. The shuffle blocks those executors wrote are lost with the node disk
3. The Spark driver detects the lost executors via heartbeat timeout
4. The driver reschedules the affected map tasks on surviving executors
5. New executors are started on replacement nodes

This is a controlled retry — map tasks re-execute, not the entire job. The ESS's role is specifically to allow shuffle reads to continue even when the writing executor has been deallocated (via idle timeout, not spot preemption). This prevents healthy scale-down from blocking shuffle reads.

`spark.dynamicAllocation.shuffleTracking.enabled` is explicitly set to `false` because ESS and shuffle tracking are mutually exclusive — ESS is the mechanism that makes decommissioning safe.

---

## 2. Spark Connect Server

> **Hands-on connection guide:** For VS Code setup, getting the Spark Connect endpoint, connecting a notebook, and debugging slow queries see the [Developer Experience Guide §2 — Spark Connect Development](../guides/developer-experience.md#2-spark-connect-development). This section covers the server-side architecture, auth model, and session management.

### What Spark Connect Is

Spark Connect, introduced in Apache Spark 3.4, separates the Spark client (DataFrame API) from the Spark server (plan execution). The client sends an **unresolved logical plan** expressed in the Connect protocol (protobuf over gRPC) to the server. The server resolves the plan, optimizes it, and executes it against the cluster. Results are streamed back to the client in Apache Arrow format.

This means a developer running PySpark on their laptop is not running a Spark JVM locally — they are constructing a plan locally and shipping it to a real Spark cluster for execution.

### Server Process Architecture

The Spark Connect server in Forge runs as a single Kubernetes `Deployment` in the `spark-system` namespace:

```
spark-connect Deployment (1 replica)
├── spark-connect-server container
│   ├── JVM process: SparkConnectServer
│   │   ├── gRPC server (port 15002) — receives Connect protocol requests
│   │   ├── SparkContext — single context shared across all sessions
│   │   ├── SessionManager — maintains per-developer session state
│   │   └── Planner — translates Connect proto to Spark catalyst plan
│   └── Sidecar: azure-workload-identity token refresh
│
└── Service: spark-connect-lb (LoadBalancer, internal only)
    └── port 15002/TCP → spark-connect pod
```

**How the server translates Connect protocol to a Spark plan:**

1. Client sends a `ExecutePlanRequest` protobuf message containing a `Relation` (logical plan tree built by the DataFrame API)
2. The `SparkConnectPlanner` on the server walks the `Relation` tree and converts each Connect node (e.g., `Filter`, `Project`, `Join`, `Read`) into its Catalyst equivalent (Spark's internal IR)
3. The resulting unresolved logical plan is handed to the Spark analyzer, which resolves column references and function names against the catalog (Hive Metastore for Delta tables)
4. The optimizer applies transformation rules (predicate pushdown, projection pruning, etc.)
5. The physical planner selects an execution strategy and produces a `SparkPlan`
6. The plan executes across driver + executors against ADLS Gen2
7. Results are materialized as Arrow record batches and streamed back via gRPC to the client

### Network Path from VS Code to Spark Connect Server

```
Developer Workstation (corporate network / VPN)
        │
        │  sc://spark-connect.internal.forge.corp:15002
        │  gRPC over TCP
        ▼
Azure Application Gateway (does NOT terminate Spark Connect traffic)
        │
        │  This traffic does NOT go through App Gateway.
        │  Spark Connect uses an Internal Load Balancer.
        ▼
Internal Load Balancer (Azure ILB, private IP 10.1.200.10)
        │  Annotation: service.beta.kubernetes.io/azure-load-balancer-internal: "true"
        │  Annotation: service.beta.kubernetes.io/azure-load-balancer-internal-subnet: "compute-cluster-subnet"
        │
        ▼
spark-connect pod (spark-system namespace, forge-compute AKS cluster)
        │
        │  gRPC session established
        │  SparkConnectServer receives ExecutePlanRequest
        ▼
Spark execution against ADLS Gen2
```

Developers must be on the corporate network or connected via VPN to reach the ILB's private IP. The private DNS entry `spark-connect.internal.forge.corp` resolves to the ILB's private IP via Azure Private DNS linked to the forge VNet.

gRPC connections to the Spark Connect server are protected by TLS 1.2+. The server presents a certificate issued by the internal corporate CA, mounted as a Kubernetes Secret.

### Authentication

Developer authentication to Spark Connect is via **OIDC (Azure AD)**. The flow:

```
1. Developer authenticates to Azure AD (interactive browser flow or device code)
   └── Receives an OIDC ID token (JWT) for the Forge application registration

2. Developer's SparkSession is configured with the token:
   spark = SparkSession.builder \
       .remote("sc://spark-connect.internal.forge.corp:15002") \
       .config("spark.connect.grpc.binding.port", "15002") \
       .config("spark.connect.authenticate", "true") \
       .config("spark.connect.token", id_token) \
       .getOrCreate()

3. SparkSession sends the token in the gRPC Authorization header:
   Authorization: Bearer <id_token>

4. Spark Connect server gRPC interceptor extracts the Bearer token

5. Server validates the token against Azure AD:
   - Fetches Azure AD JWKS endpoint (cached, refreshed periodically)
   - Verifies JWT signature using the appropriate public key
   - Validates: issuer (iss == Azure AD tenant), audience (aud == Forge app ID),
     expiry (exp > now), and not-before (nbf <= now)
   - Extracts user identity (UPN / object ID) from token claims

6. Server checks the extracted identity against Forge RBAC:
   - Data Engineers: full read/write Spark Connect access
   - Analysts: read-only (write operations blocked at server interceptor level)
   - Unauthenticated: connection rejected with UNAUTHENTICATED gRPC status

7. Identity is propagated into SparkSession user context for audit logging
```

The Forge Spark Connect interceptor is implemented as a custom gRPC `ServerInterceptor` compiled into the server startup configuration. Token validation uses the `com.nimbusds.jose` JWT library already present in the Spark classpath.

### Session Management

The Spark Connect server maintains a `SessionManager` that maps session IDs to `SparkSession` instances. Session behaviour is as follows:

**Shared SparkContext, isolated SparkSessions:**

All developer sessions share a single `SparkContext` (and therefore a single connection to the Kubernetes API for executor management). However, each connecting client receives a logically isolated `SparkSession` with its own:
- Catalog state (temporary views are per-session)
- Configuration overrides (session-level `spark.conf.set(...)` calls do not affect other sessions)
- Active query tracking (a `df.show()` in one session does not interfere with another)

This is identical to how multiple users can share a Spark ThriftServer for SQL — they share resources but are isolated in their session-level state.

**Executor sharing:**

Because there is one SparkContext, all interactive sessions share the same executor pool. Dynamic allocation governs the pool size. If developer A runs a heavy query, executors are acquired from the pool; developer B's concurrent query may experience resource contention. This is a known trade-off of the shared server model and is acceptable for interactive development workloads (which are not production SLA-bound).

For production batch jobs, the Spark Operator creates separate SparkApplications, each with their own independent SparkContext and executor pool. There is no executor sharing between batch jobs and the interactive Spark Connect server.

**Session lifecycle:**
- Sessions are created on first client connection
- Sessions are retained for 30 minutes of inactivity (configurable via `spark.connect.session.timeout`)
- On session expiry, temporary views and cached DataFrames in that session are released
- Clients reconnecting after timeout receive a new session (they can re-run setup code; persisted Delta data is unaffected)
- A maximum of 20 concurrent sessions is enforced (configurable); beyond this, new connections receive `RESOURCE_EXHAUSTED`

---

## 3. Spark ADLS Access

### ABFS Driver

Spark accesses ADLS Gen2 via the **Azure Blob FileSystem (ABFS)** driver, implemented in `hadoop-azure-3.3.6.jar`. ABFS is the production-grade Hadoop FileSystem implementation for ADLS Gen2 with hierarchical namespace. It uses the native ADLS Gen2 REST API (DFS endpoint), not the Blob Storage API, which gives it:

- True directory rename and delete semantics (O(1) rename via HNS)
- ACL support at directory and file level
- Consistent directory listing for partition discovery

Paths use the `abfss://` scheme (SSL-enabled):

```
abfss://<container>@<storage-account>.dfs.core.windows.net/<path>
```

For example:
```
abfss://silver@forgeprodadls.dfs.core.windows.net/sales/orders/
```

### Workload Identity Token Injection

Forge uses **Azure Workload Identity** — no storage account keys, no SAS tokens, no service principal secrets. The flow for a Spark job pod acquiring access to ADLS:

```
1. The Spark driver pod is annotated:
   azure.workload.identity/use: "true"
   azure.workload.identity/client-id: "<id-forge-compute-{env} client ID>"

2. The Azure Workload Identity webhook (MutatingWebhookConfiguration) intercepts
   the pod creation request and injects:
   - A projected ServiceAccount token volume:
     volumes:
       - name: azure-identity-token
         projected:
           sources:
             - serviceAccountToken:
                 audience: api://AzureADTokenExchange
                 expirationSeconds: 3600
                 path: azure-identity-token
   - Environment variables:
       AZURE_CLIENT_ID: <managed identity client ID>
       AZURE_TENANT_ID: <Azure AD tenant ID>
       AZURE_FEDERATED_TOKEN_FILE: /var/run/secrets/azure/tokens/azure-identity-token

3. The Spark JVM starts. The Azure Identity SDK (azure-identity-1.x.jar, bundled
   in the Spark image) detects the AZURE_FEDERATED_TOKEN_FILE environment variable
   and activates the WorkloadIdentityCredential provider.

4. When the ABFS driver needs an ADLS token (on first filesystem operation):
   a. The WorkloadIdentityCredential reads the projected SA token from disk
   b. It calls Azure AD token exchange endpoint:
      POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
      with the projected token as the assertion and
      scope = https://storage.azure.com/.default
   c. Azure AD validates the OIDC assertion against the registered federated
      credential for id-forge-compute-{env}
   d. Azure AD returns a short-lived (1 hour) OAuth2 access token for ADLS Gen2

5. The ABFS driver presents this access token in the Authorization header of
   every ADLS REST API request:
   Authorization: Bearer <access_token>

6. The Azure Identity SDK automatically refreshes the token before expiry.
   The projected SA token on disk is also refreshed by the kubelet automatically
   before its expiration.
```

**Hadoop configuration** for ABFS is set via `spark-defaults.conf` (see Section 4):

```
fs.azure.account.auth.type.forgeprodadls.dfs.core.windows.net = OAuth
fs.azure.account.oauth.provider.type.forgeprodadls.dfs.core.windows.net = org.apache.hadoop.fs.azurebfs.oauth2.WorkloadIdentityTokenProvider
```

No storage account key configuration is present anywhere in the cluster.

### No Storage Keys

The `id-forge-compute-{env}` managed identity has Azure RBAC role assignments:
- `Storage Blob Data Contributor` on `bronze/` container
- `Storage Blob Data Contributor` on `silver/` container
- `Storage Blob Data Reader` on `code/` container
- `Storage Blob Data Contributor` on `checkpoints/` container

It has **no access** to `serving/` — production serving data is read by consumers (Trino, Portal) via `id-forge-read-{env}`.

### Path Conventions

| Zone | ABFS Path Pattern | Notes |
|------|-------------------|-------|
| Raw | `abfss://bronze@<account>.dfs.core.windows.net/<source>/<entity>/<yyyy-mm-dd>/` | Partitioned by ingestion date |
| Curated | `abfss://silver@<account>.dfs.core.windows.net/<domain>/<entity>/` | Delta table root |
| Serving | `abfss://gold@<account>.dfs.core.windows.net/<domain>/<entity>/` | Delta table root, consumer-optimized |
| Code/Jars | `abfss://code@<account>.dfs.core.windows.net/jobs/` | Job Python files and wheels |
| Checkpoints | `abfss://checkpoints@<account>.dfs.core.windows.net/<pipeline_id>/` | Structured Streaming checkpoints |
| DQ Results | `abfss://silver@<account>.dfs.core.windows.net/_platform/dq_results/` | Platform internal |

---

## 4. Spark Configuration Hierarchy

Spark configuration in Forge is applied in three layers. Each layer overrides the one below it. The hierarchy from lowest to highest precedence:

```
Layer 1: spark-defaults.conf (cluster-wide defaults)
    ↓ overridden by
Layer 2: SparkApplication spec sparkConf (job-level overrides)
    ↓ overridden by
Layer 3: Session-level overrides (spark.conf.set() in interactive sessions)
```

### Layer 1: spark-defaults.conf (Cluster Defaults)

`spark-defaults.conf` is stored in a Kubernetes `ConfigMap` named `spark-defaults-cm` in the `spark-system` namespace. It is mounted into every Spark driver and executor pod at `/opt/spark/conf/spark-defaults.conf` by the admission webhook (see Section 1).

Contents of `spark-defaults.conf`:

```properties
# ── Kubernetes Cluster Manager ──────────────────────────────────────────────
spark.master                                          k8s://https://forge-compute-apiserver:443
spark.submit.deployMode                               cluster
spark.kubernetes.namespace                            spark-jobs
spark.kubernetes.container.image                      forgeacr-prod.azurecr.io/spark:4.1.0
spark.kubernetes.container.image.pullPolicy           Always

# ── ADLS Gen2 / ABFS ────────────────────────────────────────────────────────
spark.hadoop.fs.azure.account.auth.type.forgeprodadls.dfs.core.windows.net      OAuth
spark.hadoop.fs.azure.account.oauth.provider.type.forgeprodadls.dfs.core.windows.net \
    org.apache.hadoop.fs.azurebfs.oauth2.WorkloadIdentityTokenProvider
spark.hadoop.fs.azure.account.oauth2.msi.tenant.forgeprodadls.dfs.core.windows.net \
    <tenant-id>

# ── Delta Lake ───────────────────────────────────────────────────────────────
spark.sql.extensions                                  io.delta.sql.DeltaSparkSessionExtension
spark.sql.catalog.spark_catalog                       org.apache.spark.sql.delta.catalog.DeltaCatalog
spark.databricks.delta.schema.autoMerge.enabled       false
spark.databricks.delta.retentionDurationCheck.enabled true

# ── Dynamic Allocation ───────────────────────────────────────────────────────
spark.dynamicAllocation.enabled                       true
spark.dynamicAllocation.minExecutors                  2
spark.dynamicAllocation.maxExecutors                  50
spark.dynamicAllocation.executorIdleTimeout           60s
spark.dynamicAllocation.schedulerBacklogTimeout       1s
spark.shuffle.service.enabled                         true
spark.shuffle.service.port                            7337
spark.dynamicAllocation.shuffleTracking.enabled       false

# ── OpenLineage ──────────────────────────────────────────────────────────────
spark.extraListeners                                  io.openlineage.spark.agent.OpenLineageSparkListener
spark.openlineage.transport.type                      http
spark.openlineage.transport.url                       https://purview-forge-${FORGE_ENV}.purview.azure.com/dataMap/openlineage/namespaces/forge-${FORGE_ENV}/events
spark.openlineage.transport.auth.type                 azure_identity
spark.openlineage.transport.timeoutInMillis           10000
spark.openlineage.namespace                           forge-${FORGE_ENV}

# ── History Server ───────────────────────────────────────────────────────────
spark.eventLog.enabled                                true
spark.eventLog.dir                                    abfss://code@forgeprodadls.dfs.core.windows.net/spark-history/
spark.history.fs.logDirectory                         abfss://code@forgeprodadls.dfs.core.windows.net/spark-history/

# ── JVM / GC ─────────────────────────────────────────────────────────────────
spark.driver.extraJavaOptions                         -XX:+UseG1GC -XX:InitiatingHeapOccupancyPercent=35
spark.executor.extraJavaOptions                       -XX:+UseG1GC -XX:InitiatingHeapOccupancyPercent=35
```

This ConfigMap is managed by the `spark-operator` Helm chart and updated via ADO Pipeline. Any change to the ConfigMap requires a Helm chart update and an ADO Pipeline run — there is no ad-hoc `kubectl edit`.

### Layer 2: SparkApplication spec sparkConf (Job-Level Overrides)

Each `SparkApplication` manifest can include a `sparkConf` block that overrides cluster defaults for that job only. Examples of common job-level overrides:

```yaml
sparkConf:
  # Increase shuffle partitions for a large join-heavy job
  "spark.sql.shuffle.partitions": "800"

  # Tighten executor count for a small housekeeping job
  "spark.dynamicAllocation.maxExecutors": "5"

  # Enable adaptive query execution for complex multi-stage jobs
  "spark.sql.adaptive.enabled": "true"
  "spark.sql.adaptive.coalescePartitions.enabled": "true"
  "spark.sql.adaptive.skewJoin.enabled": "true"

  # Disable speculative execution for idempotent jobs with side effects
  "spark.speculation": "false"

  # Job-specific OpenLineage job name
  "spark.openlineage.job.name": "transform_orders"
```

### Layer 3: Session-Level Overrides (Interactive Sessions)

Developers using Spark Connect can override configuration within their interactive session:

```python
spark.conf.set("spark.sql.shuffle.partitions", "200")
spark.conf.set("spark.sql.adaptive.enabled", "true")
```

Session-level overrides are scoped to that session's SparkSession object and do not affect other concurrent sessions or the underlying SparkContext configuration. Configuration affecting the SparkContext (e.g., `spark.executor.memory`) cannot be changed after context creation — these are fixed at server startup from the cluster defaults.

---

## 5. Node Pool Assignment

### Node Pool Architecture

The `forge-compute` AKS cluster has three node pools:

| Pool | VM SKU | Min/Max | OS Disk | Spot? | Taint |
|------|--------|---------|---------|-------|-------|
| `system` | Standard_D4s_v5 | 1/3 | 128 GiB | No | `CriticalAddonsOnly=true:NoSchedule` |
| `spark` | Standard_E8s_v5 | 0/20 | 256 GiB (ephemeral) | Mixed | `workload=spark:NoSchedule` |
| `trino` | Standard_E16s_v5 | 2/8 | 256 GiB | No | `workload=trino:NoSchedule` |

The `spark` node pool uses a **mixed priority** model: on-demand nodes for driver pods, spot nodes for executor pods. This is achieved via node labels applied by the cluster autoscaler and AKS:

- On-demand spark nodes: `kubernetes.azure.com/scalesetpriority: regular`
- Spot spark nodes: `kubernetes.azure.com/scalesetpriority: spot`

In practice, AKS implements this as two separate Virtual Machine Scale Sets within the `spark` pool configuration — a regular VMSS and a spot VMSS — both with the `agentpool: spark` label so that pod selectors work uniformly.

### Driver Pod Placement

Driver pods land on on-demand spark nodes. This is enforced by combining a `nodeSelector` with an affinity that excludes spot nodes:

```yaml
# In SparkApplication spec (or injected by webhook)
driver:
  nodeSelector:
    agentpool: spark
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: agentpool
                operator: In
                values:
                  - spark
              - key: kubernetes.azure.com/scalesetpriority
                operator: NotIn
                values:
                  - spot
  tolerations:
    - key: "workload"
      operator: "Equal"
      value: "spark"
      effect: "NoSchedule"
```

This prevents driver pods from landing on spot nodes even when spot capacity is available, protecting job coordination from preemption.

### Executor Pod Placement (Spot Tolerance)

Executor pods are permitted on both on-demand and spot spark nodes, but they prefer spot nodes (lower cost). This is achieved by:

```yaml
executor:
  nodeSelector:
    agentpool: spark
  tolerations:
    - key: "workload"
      operator: "Equal"
      value: "spark"
      effect: "NoSchedule"
    # This toleration allows executors to land on spot nodes
    - key: "kubernetes.azure.com/scalesetpriority"
      operator: "Equal"
      value: "spot"
      effect: "NoSchedule"
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: kubernetes.azure.com/scalesetpriority
                operator: In
                values:
                  - spot
```

The `weight: 80` preference means the scheduler strongly prefers spot nodes but falls back to on-demand if spot capacity is exhausted. The External Shuffle Service handles the consequence of spot preemption (see Section 1).

### System and Trino Pod Placement

Platform components (Spark Operator controller, admission webhook, External Shuffle Service) run on the `system` node pool with appropriate tolerations for `CriticalAddonsOnly`.

Trino coordinator and worker pods run exclusively on the `trino` node pool using `nodeSelector: agentpool: trino` and `tolerations: workload=trino:NoSchedule`. Trino nodes are all on-demand — Trino does not tolerate node preemption mid-query without query failure.

---

## 6. Trino Cluster

### Coordinator vs Worker Architecture

Trino follows a master-worker architecture where the **coordinator** is the query brain and **workers** are pure execution nodes.

```
Client (portal, JDBC tool, Trino CLI)
        │
        │  HTTPS (port 8443, TLS)
        ▼
┌──────────────────────────────────────────────────────────────────┐
│  Trino Coordinator (Deployment, 2 replicas with shared state)    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Query Lifecycle                                          │   │
│  │  1. Receive SQL from client                              │    │
│  │  2. Parse → AST                                          │    │
│  │  3. Analyze (resolve names, types from Hive Metastore)   │    │
│  │  4. Plan (logical plan → optimized logical plan)         │    │
│  │  5. Schedule (distribute stages across workers)          │    │
│  │  6. Monitor execution, collect results                   │    │
│  │  7. Return results to client                             │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  JVM: 24 GB heap (-Xmx24g)                                       │
│  Node memory: 32 GB (Standard_E16s_v5 = 128 GB; shared pool)     │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                │  HTTP (internal, port 8080)
                                │  task distribution, data exchange
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  Trino Workers (Deployment, 2–8 replicas, autoscaled)            │
│                                                                  │
│  Each worker:                                                    │
│  • Receives task assignments from coordinator                    │
│  • Reads data directly from ADLS via ABFS (connector)            │
│  • Executes operators: scan, filter, aggregate, join, sort       │
│  • Exchanges intermediate data with other workers (shuffle)      │
│  • Returns result pages to coordinator                           │
│                                                                  │
│  JVM: 48 GB heap (-Xmx48g)                                       │
│  Node memory: 128 GB (Standard_E16s_v5)                          │
└──────────────────────────────────────────────────────────────────┘
```

**Coordinator replicas:** Two coordinator replicas run behind a Kubernetes Service (ClusterIP). However, unlike workers, coordinators do not share query state — each coordinator independently handles the queries routed to it. A load balancer at the Service level performs round-robin routing of incoming query connections across the two coordinators. There is no active-active coordination; each query is fully owned by one coordinator for its lifetime. Two coordinators provide availability (if one coordinator pod restarts, in-flight queries on it fail, but new queries route to the healthy coordinator).

### Query Routing

```
Client sends SQL → hits Trino coordinator Service (ClusterIP: trino-coordinator:8443)
        │
        │  Kubernetes Service performs round-robin across coordinator pods
        ▼
Coordinator pod A or B receives the connection
        │
        │  Coordinator parses SQL, splits into query stages
        │  Each stage is a DAG of tasks
        │
        │  Coordinator assigns tasks to available workers
        │  Task assignment considers: worker available memory, locality hints
        ▼
Worker pods execute tasks
        │  Workers read data from ADLS via Delta/Hive connectors
        │  Workers exchange shuffle data via HTTP between each other
        │  Workers return data pages to coordinator
        ▼
Coordinator assembles final result, returns to client
```

The coordinator never reads data from storage directly — all data access is delegated to workers. The coordinator only handles control plane: planning, scheduling, result aggregation, and client communication.

### Memory Management

Trino uses a three-pool memory model per node:

```
Worker Node Total Memory: 128 GiB (Standard_E16s_v5)
├── JVM Heap (configured: 48 GiB, -Xmx48g)
│   ├── General Pool: 38.4 GiB (80% of heap)
│   │   └── All query operator memory (hash tables, sort buffers, etc.)
│   └── Reserved Pool: 9.6 GiB (20% of heap)
│       └── Holds the single largest query when general pool is exhausted
│           This prevents deadlock when all workers are memory-constrained
│
└── OS and off-heap: 80 GiB
    └── OS page cache (benefits repeated ADLS reads), JVM metaspace, GC overhead
```

Trino `config.properties` relevant memory settings:

```properties
# Total memory Trino can use on this node
query.max-memory-per-node=10GB

# Soft limit before coordinator redistributes future tasks
query.soft-max-memory-per-node=9GB

# Cluster-wide limit per single query across all workers
query.max-memory=80GB

# Time before an idle query is killed
query.max-run-time=2h

# Memory for output buffers per query
task.max-partial-aggregation-memory=16MB
```

When a query exceeds `query.max-memory-per-node` on any worker, Trino kills that query with an `EXCEEDED_LOCAL_MEMORY_LIMIT` error. The reserved pool ensures that the current largest query always has enough memory to complete, preventing the entire cluster from deadlocking under memory pressure.

### Connector Architecture

Trino connectors are plugins that implement a set of Java SPIs (`ConnectorFactory`, `Connector`, `ConnectorSplitManager`, `ConnectorPageSource`, etc.) that Trino calls during query planning and execution.

Forge uses these connectors:

| Connector | Catalog Name | Data Source | Notes |
|-----------|--------------|-------------|-------|
| `delta` | `lakehouse` | silver/ and gold/ Delta tables | Built into Trino 479; reads Delta log |
| `hive` | `bronze` | bronze/ Delta files | Legacy Hive-compatible for Bronze layer |
| `tpch` | `tpch` | In-memory benchmark data | Benchmarking and query testing only |

### Catalog Discovery

Trino catalogs are defined in `*.properties` files in the `/etc/trino/catalog/` directory inside each coordinator and worker pod. These files are mounted from a Kubernetes `ConfigMap` (`trino-catalog-cm`). The `catalog-discovery` custom plugin bundled in the Forge Trino image watches for ConfigMap updates and triggers a soft reload of catalog definitions without requiring pod restarts. This allows new dataset namespaces or catalog entries to be added without a Trino deployment rollout.

Each catalog properties file specifies at minimum:

```properties
# /etc/trino/catalog/lakehouse.properties
connector.name=delta
hive.metastore.uri=thrift://hive-metastore.trino.svc.cluster.local:9083
hive.metastore.authentication.type=NONE
hive.azure.adl.oauth2.credential.provider=WorkloadIdentity
delta.native-snapshot-isolation.enabled=true
```

---

## 7. Trino ADLS Access

### Workload Identity Pattern

Trino uses the same Azure Workload Identity pattern as Spark. Trino pods are annotated with `azure.workload.identity/use: "true"` and the `id-forge-read-{env}` client ID. The projected service account token is injected by the workload identity webhook.

The Trino ABFS/Hadoop configuration is set in the catalog properties files and Trino node configuration, pointing to the WorkloadIdentity token provider:

```properties
# In /etc/trino/catalog/lakehouse.properties and raw.properties
hive.hadoop.config.resources=/etc/trino/hadoop/core-site.xml

# In /etc/trino/hadoop/core-site.xml (mounted ConfigMap)
fs.azure.account.auth.type.forgeprodadls.dfs.core.windows.net=OAuth
fs.azure.account.oauth.provider.type.forgeprodadls.dfs.core.windows.net=\
    org.apache.hadoop.fs.azurebfs.oauth2.WorkloadIdentityTokenProvider
fs.azure.account.oauth2.msi.tenant.forgeprodadls.dfs.core.windows.net=<tenant-id>
```

The `id-forge-read-{env}` managed identity has:
- `Storage Blob Data Reader` on `silver/` container
- `Storage Blob Data Reader` on `gold/` container
- **No access** to `bronze/` or `code/` containers

This enforces that Trino cannot read Bronze layer data (which may contain PII before masking), even if a user constructs an ABFS path manually.

### No Storage Keys

No storage account keys or SAS tokens appear anywhere in Trino configuration. The Hadoop `core-site.xml` contains only OAuth configuration referencing the WorkloadIdentity provider. If a storage key were accidentally added, OPA Gatekeeper policies would detect and block the ConfigMap update in CI.

---

## 8. Trino Authentication

### OIDC via Azure AD

Trino's built-in OIDC authenticator is configured to validate tokens issued by Azure AD. The flow from the Developer Portal to Trino:

```
1. User opens Developer Portal and authenticates via Azure AD (OIDC)
   └── Portal frontend receives ID token and access token

2. User triggers a dataset preview or ad-hoc query in the portal

3. Portal backend (FastAPI) calls the Trino REST API:
   POST https://trino-coordinator.trino.svc.cluster.local:8443/v1/statement
   Authorization: Bearer <access_token>
   X-Trino-User: user@corp.com
   X-Trino-Catalog: lakehouse
   X-Trino-Schema: sales

4. Trino coordinator's HTTPS listener receives the request

5. Trino OAuthAuthenticator extracts the Bearer token from the Authorization header

6. Trino validates the token:
   a. Fetches Azure AD OIDC discovery document (cached):
      https://login.microsoftonline.com/<tenant>/.well-known/openid-configuration
   b. Retrieves JWKS endpoint from discovery document
   c. Validates JWT: signature, issuer, audience (aud == Forge app ID), expiry
   d. Extracts user principal from preferred_username or email claim

7. Trino maps the principal to internal roles:
   - Azure AD group "forge-trino-admin"   → Trino ROLE admin
   - Azure AD group "forge-data-engineer" → Trino ROLE data_engineer (all schemas)
   - Azure AD group "forge-analyst"       → Trino ROLE analyst (serving schema only)

8. Trino enforces row/column access policies via OPA (optional, phase 2)

9. Query executes under the authenticated user identity
   All query logs include the user principal for audit
```

Trino `config.properties` OIDC configuration:

```properties
http-server.authentication.type=OAUTH2
http-server.https.enabled=true
http-server.https.port=8443
http-server.https.keystore.path=/etc/trino/tls/keystore.p12

web-ui.authentication.type=OAUTH2
http-server.authentication.oauth2.issuer=https://login.microsoftonline.com/<tenant>/v2.0
http-server.authentication.oauth2.client-id=<forge-app-client-id>
http-server.authentication.oauth2.client-secret=${ENV:OIDC_CLIENT_SECRET}
http-server.authentication.oauth2.scopes=openid,profile,email
```

Direct JDBC/CLI access from developer tools (DBeaver, Trino CLI) follows the same OIDC flow, typically via the device-code or browser-redirect flow built into the Trino JDBC driver.

---

## 9. Trino Autoscaling

### Horizontal Pod Autoscaler

Trino workers are scaled by a Kubernetes `HorizontalPodAutoscaler` targeting the `trino-worker` Deployment:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: trino-worker-hpa
  namespace: trino
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: trino-worker
  minReplicas: 0
  maxReplicas: 8
  metrics:
    - type: External
      external:
        metric:
          name: trino_active_queries
          selector:
            matchLabels:
              service: trino-coordinator
        target:
          type: AverageValue
          averageValue: "3"
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

**Scale-up trigger:** When the number of active queries divided by worker count exceeds 3 (i.e., more than 3 concurrent queries per worker), or when average worker memory utilization exceeds 70%, the HPA adds workers at a rate of 2 per minute.

**Scale-down trigger:** After 5 minutes of low load (stabilizationWindowSeconds: 300), the HPA removes workers one at a time with a 2-minute cooldown between removals. The slow scale-down prevents thrashing when query bursts arrive intermittently.

**Custom metric source:** The `trino_active_queries` external metric is exported by the `trino` scrape job (via the Azure Monitor Agent) and made available to the HPA via the Azure Monitor adapter for Kubernetes (`custom.metrics.k8s.io` API extension).

### Scale-to-Zero Workers

`minReplicas: 0` means the worker Deployment can scale down to zero pods during idle periods (nights, weekends). When zero workers are running:

- The coordinator(s) remain running (2 replicas, always-on)
- New queries arriving at the coordinator trigger scale-up
- Scale-up latency: ~90 seconds (pod scheduling + JVM startup + coordinator registration)
- During this 90-second window, queries are queued in the coordinator's pending queue

When workers scale to zero, the `trino` node pool in AKS also scales to zero (via the cluster autoscaler), since there are no pods requiring `trino` pool nodes. The coordinator pods run on the `system` node pool (with `nodeSelector: agentpool: system` and no `workload=trino` taint requirement), so the coordinator remains active even when the trino pool is empty.

This scale-to-zero behaviour saves approximately 65% of Trino infrastructure cost outside business hours, based on 10 hours/day active usage.

---

## 10. Hive Metastore

### Why Hive Metastore Is Needed

Delta Lake tables store their schema, partition list, and table properties in the Delta transaction log (`_delta_log/`) on ADLS. However, both Spark and Trino need a way to discover table locations by name (e.g., `SELECT * FROM curated.orders`) rather than by ABFS path.

The Hive Metastore (HMS) provides this: it is a relational catalog that maps `(database, table_name)` → `(ADLS location, SerDe, column schemas, partition keys)`. Both Spark's `DeltaCatalog` and Trino's `DeltaConnector` use HMS as their catalog backend via the Thrift protocol on port 9083.

Without HMS, every query would need to specify the full ABFS path. HMS is not a query engine — it only answers metadata questions ("where is this table?", "what are its columns?"). The actual data reading happens in Spark or Trino directly from ADLS.

### Schema and Storage

HMS metadata is stored in a PostgreSQL database (`hms_db` in the Forge PostgreSQL Flexible Server instance). The HMS schema is the standard Hive Metastore schema (Hive 3.1.3 compatible):

Key tables:
- `DBS` — databases (maps to Delta namespaces: `raw`, `curated`, `serving`)
- `TBLS` — tables (one row per registered Delta table)
- `COLUMNS_V2` — column definitions per table
- `SDS` (Storage Descriptors) — ADLS location, input format, SerDe library
- `PARTITION_KEYS` — partition column definitions
- `PARTITIONS` — registered partitions (for static partition registration; Delta auto-discovery reduces reliance on this)

For Delta Lake tables, the HMS entry stores only:
- The table's root ABFS path (e.g., `abfss://silver@...dfs.core.windows.net/sales/orders/`)
- The `DeltaInputFormat` and `DeltaOutputFormat` class names
- Column types from the latest Delta schema (HMS is eventually consistent with the Delta log)

The Delta connector in both Spark and Trino reads the actual current schema from the Delta log (`_delta_log/`) rather than trusting HMS column definitions, which may lag behind Delta schema evolution.

### Deployment

HMS runs as a Kubernetes `Deployment` in the `trino` namespace on the compute cluster (co-located with Trino to minimise latency on catalog operations):

```
hive-metastore Deployment (1 replica)
├── Container: hive-metastore
│   ├── Image: forgeacr-prod.azurecr.io/hive-metastore:3.1.3
│   ├── Command: /opt/hive/bin/hive --service metastore
│   ├── Port: 9083/TCP (Thrift)
│   └── Env:
│       HADOOP_CLASSPATH includes hadoop-azure jar for ABFS
│       DATABASE_HOST: postgres.private.forge.corp
│       DATABASE_NAME: hms_db
│       DATABASE_USER: hms_user
│       DATABASE_PASSWORD: (from Key Vault via CSI)
│
└── Service: hive-metastore (ClusterIP, port 9083)
```

HMS performs one important function on startup: `schemaInit` — it applies Hive Metastore schema DDL to the PostgreSQL database if the schema version is outdated. This is idempotent and safe to run on every pod restart.

### Relationship to Trino and Spark

```
Trino Coordinator / Spark Driver
        │
        │  Thrift protocol, port 9083
        │  e.g.: GetDatabase("curated")
        │        GetTable("curated", "orders")
        │        GetPartitions("curated", "orders", ...)
        ▼
Hive Metastore (HMS Thrift Server)
        │
        │  JDBC
        ▼
PostgreSQL (hms_db)
        │  Returns: ADLS path + schema for "curated.orders"
        ▼
Trino or Spark reads data directly from ADLS Gen2
        abfss://silver@forgeprodadls.dfs.core.windows.net/sales/orders/
        (reading Delta log for schema, then Parquet files for data)
```

**Spark catalog integration:** Spark is configured with `spark.sql.catalog.spark_catalog = org.apache.spark.sql.delta.catalog.DeltaCatalog` and `spark.hadoop.hive.metastore.uris = thrift://hive-metastore.trino.svc.cluster.local:9083`. This allows PySpark to reference tables as `spark.table("curated.orders")` or SQL `SELECT * FROM curated.orders`.

**Trino catalog integration:** The `lakehouse` and `raw` catalog properties files specify `hive.metastore.uri = thrift://hive-metastore.trino.svc.cluster.local:9083`. Trino uses HMS only for table discovery; all schema truth comes from the Delta log.

**Table registration:** When a new Delta table is created (by a Spark job's first write), the table is registered in HMS by the `DeltaCatalog` automatically. Airflow maintenance DAGs periodically sync HMS entries against the Delta tables on ADLS to detect and repair stale or missing entries.

---

## 11. Compute Cost Tracking

### Overview

Forge tracks the estimated cost of every compute job and attaches that estimate as a custom OpenLineage facet to the job's run event in Microsoft Purview. This enables per-pipeline cost trending in the Developer Portal without requiring Azure Cost Management API calls for individual job attribution.

### Cost Calculation

The cost estimate for a Spark job is calculated by the `CostFacetEmitter` class in the `forge-lineage` SDK, which runs at job completion inside the OpenLineage Spark listener.

**Formula:**

```
job_cost_estimate =
  (driver_node_count × driver_duration_hours × on_demand_sku_price_per_hour)
  +
  (executor_node_count × executor_duration_hours × spot_sku_price_per_hour)
```

**Inputs:**

| Input | Source |
|-------|--------|
| `driver_node_count` | Always 1 |
| `driver_duration_hours` | `SparkContext.statusTracker` — job start to completion timestamp |
| `on_demand_sku_price_per_hour` | Static config in `spark-defaults.conf`: `spark.forge.cost.driver.price_per_hour_usd = 0.504` (Standard_E8s_v5 on-demand) |
| `executor_node_count` | Average executor count over job duration (sampled from dynamic allocation events) |
| `executor_duration_hours` | Cumulative executor-seconds / 3600 (accounts for dynamic allocation ramp-up/down) |
| `spot_sku_price_per_hour` | Static config: `spark.forge.cost.executor.price_per_hour_usd = 0.101` (Standard_E8s_v5 spot, ~80% discount) |

Spot prices fluctuate. The static config is updated monthly by the platform team to the 30-day average spot price for the VM SKU in the deployment region, retrieved from the Azure Retail Prices API.

**Example calculation:**

```
Job: transform_orders_2026-03-24
Driver: 1 node × 0.5 hours × $0.504/hr = $0.252
Executors: avg 12 executors × 1.2 hours × $0.101/hr = $1.454
Total estimate: $1.706
```

### Cost Facet Schema

The cost estimate is attached to the OpenLineage job run event as a custom facet:

```json
{
  "run": {
    "facets": {
      "computeCost": {
        "_producer": "https://github.com/your-org/forge",
        "_schemaURL": "https://forge.internal/openlineage/facets/compute-cost/v1.json",
        "currency": "USD",
        "estimatedCostUsd": 1.706,
        "breakdown": {
          "driverCostUsd": 0.252,
          "executorCostUsd": 1.454
        },
        "computeDetails": {
          "driverSkuName": "Standard_E8s_v5",
          "executorSkuName": "Standard_E8s_v5",
          "executorPriority": "Spot",
          "avgExecutorCount": 12.3,
          "driverDurationSeconds": 1800,
          "executorCumulativeSeconds": 52956
        },
        "priceSource": "azure-retail-api",
        "priceAsOfDate": "2026-03-01"
      }
    }
  }
}
```

This facet is stored by Microsoft Purview alongside all other run facets in the lineage graph. The Developer Portal's Cost page queries the Purview Data Map API to retrieve `computeCost` facets, aggregates them by pipeline and time window, and displays cost trends.

**For Trino queries**, cost is estimated differently — using query execution time × coordinator/worker count × VM SKU price, retrieved from the Trino query completion event in the OpenLineage Trino plugin. Trino cost facets are less precise than Spark (no per-query executor allocation tracking), but provide order-of-magnitude cost attribution.

---

## 12. Full Compute Cluster Topology

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                    forge-compute  AKS Cluster  (10.1.0.0/16)                         ║
║                                                                                      ║
║  ┌─────────────────────────────┐  ┌─────────────────────────────────────────────┐    ║
║  │     system node pool        │  │          spark node pool                    │    ║
║  │  Standard_D4s_v5  (1–3)     │  │  Standard_E8s_v5  (0–20)                   │     ║
║  │                             │  │  Mixed: on-demand + spot VMSS               │    ║
║  │  ┌─────────────────────┐    │  │                                             │    ║
║  │  │  spark-operator     │    │  │  ┌──────────────────────────────────────┐   │    ║
║  │  │  (controller pod)   │    │  │  │  Spark Connect Server               │   │     ║
║  │  │  watches spark-jobs │    │  │  │  (Deployment, 1 replica)            │   │     ║
║  │  │  namespace for CRDs │    │  │  │  gRPC port 15002                    │   │     ║
║  │  └─────────────────────┘    │  │  │  SparkContext + SessionManager      │   │     ║
║  │                             │  │  └──────────────┬───────────────────────┘   │    ║
║  │  ┌─────────────────────┐    │  │                 │ spawns executors           │   ║
║  │  │  spark-operator     │    │  │                 ▼                           │    ║
║  │  │  webhook            │    │  │  ┌──────────────────────────────────────┐   │    ║
║  │  │  (admission ctrl)   │    │  │  │  Interactive Executor Pool           │   │    ║
║  │  │  mutates driver &   │    │  │  │  (dynamic, 0–20 pods, spot)         │   │     ║
║  │  │  executor pods      │    │  │  └──────────────────────────────────────┘   │    ║
║  │  └─────────────────────┘    │  │                                             │    ║
║  │                             │  │  ┌──────────────────────────────────────┐   │    ║
║  │  ┌─────────────────────┐    │  │  │  spark-jobs namespace               │   │     ║
║  │  │  hive-metastore     │    │  │  │                                     │   │     ║
║  │  │  (Thrift, port 9083)│    │  │  │  Driver Pod (on-demand node)        │   │     ║
║  │  │  backed by          │    │  │  │  ┌────────────────────────────┐     │   │     ║
║  │  │  PostgreSQL hms_db  │    │  │  │  │ SparkContext               │     │   │     ║
║  │  └─────────────────────┘    │  │  │  │ DAGScheduler               │     │   │     ║
║  │                             │  │  │  │ BlockManagerMaster          │     │   │    ║
║  └─────────────────────────────┘  │  │  └────────────────────────────┘     │   │     ║
║                                   │  │         │ requests executors         │   │    ║
║                                   │  │         ▼                           │   │     ║
║                                   │  │  Executor Pods (spot nodes)         │   │     ║
║                                   │  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐      │   │       ║
║                                   │  │  │ E1 │ │ E2 │ │ E3 │ │ EN │ ...  │   │       ║
║                                   │  │  └────┘ └────┘ └────┘ └────┘      │   │       ║
║                                   │  │  (2 initial → up to 50 via dynalloc)   │      ║
║                                   │  │                                     │   │     ║
║                                   │  │  External Shuffle Service (DaemonSet)  │      ║
║                                   │  │  ┌──────────────────────────────────┐   │     ║
║                                   │  │  │ spark-shuffle-service (each node)│   │     ║
║                                   │  │  │ port 7337                        │   │     ║
║                                   │  │  └──────────────────────────────────┘   │     ║
║                                   │  └─────────────────────────────────────────┘     ║
║                                   │                                                  ║
║                                   └─────────────────────────────────────────────┐    ║
║                                                                                  │   ║
║  ┌───────────────────────────────────────────────────────────────────────────┐   │   ║
║  │                        trino node pool                                    │   │   ║
║  │                  Standard_E16s_v5  (2–8, on-demand)                      │   │    ║
║  │                                                                           │   │   ║
║  │  ┌────────────────────────────────────┐                                   │   │   ║
║  │  │  Trino Coordinator  (2 replicas)   │                                   │   │   ║
║  │  │  JVM heap: 24 GB                  │◄──── client queries (HTTPS 8443)  │   │    ║
║  │  │  Plans + schedules queries        │                                   │   │    ║
║  │  │  OIDC auth via Azure AD           │                                   │   │    ║
║  │  └──────────────────┬─────────────────┘                                  │   │    ║
║  │                     │ distributes tasks (HTTP 8080)                       │   │   ║
║  │                     ▼                                                     │   │   ║
║  │  ┌────────────────────────────────────┐                                   │   │   ║
║  │  │  Trino Workers  (0–8 replicas)     │                                   │   │   ║
║  │  │  JVM heap: 48 GB                  │                                   │   │    ║
║  │  │  HPA: scale on active query count │                                   │   │    ║
║  │  │  Scale-to-zero when idle          │                                   │   │    ║
║  │  └────────────────────────────────────┘                                   │   │   ║
║  │                                                                           │   │   ║
║  └───────────────────────────────────────────────────────────────────────────┘   │   ║
║                                   ▲                                               │  ║
╚═══════════════════════════════════╪═══════════════════════════════════════════════╪══╝
                                    │                                               │
                    ┌───────────────┴───────────────┐               ┌──────────────┘
                    │                               │                              │
                    ▼                               ▼               ▼
     ┌──────────────────────────┐    ┌──────────────────────────┐  ILB
     │  ADLS Gen2 Lakehouse     │    │  Azure AD (OIDC)         │  15002
     │  (private endpoint)      │    │  Token validation for    │  Developer
     │  bronze/ silver/ gold/   │    │  Spark Connect + Trino   │  VS Code
     └──────────────────────────┘    └──────────────────────────┘

Cross-cluster communication (Orchestration → Compute):

  forge-orchestration cluster
                                                                                   │
        │  kubectl apply SparkApplication CRD
        │  (via compute cluster private API endpoint)
        │  kubeconfig from Key Vault
        ▼
  forge-compute AKS API Server
                                                                                   │
        ▼
  Spark Operator controller
                                                                                   │
        ▼
  Driver + Executor pods (spark-jobs namespace)
                                                                                   │
        │  OpenLineage events (HTTPS POST, azure_identity auth)
        ▼
  Microsoft Purview OpenLineage endpoint (via private endpoint)
```

**Key network paths:**

| Traffic | Protocol | Source | Destination |
|---------|----------|--------|-------------|
| Developer → Spark Connect | gRPC/TLS | Corporate network | ILB 10.1.200.10:15002 |
| Developer → Trino | HTTPS | Corporate network (via App Gateway) | Coordinator 8443 |
| Airflow → Compute API | HTTPS | Orchestration cluster | Compute AKS API server (private endpoint) |
| Spark → ADLS | HTTPS (ABFS) | Compute cluster | ADLS private endpoint 10.3.x.x |
| Trino → ADLS | HTTPS (ABFS) | Compute cluster | ADLS private endpoint 10.3.x.x |
| Spark/Trino → Purview | HTTPS | Compute cluster | Purview OpenLineage private endpoint (10.3.x.x) |
| Spark → HMS | Thrift | spark-jobs namespace | hive-metastore.trino.svc:9083 (in-cluster) |
| Trino → HMS | Thrift | trino namespace | hive-metastore.trino.svc:9083 (in-cluster) |
