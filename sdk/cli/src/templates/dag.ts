/**
 * Forge CLI — Airflow DAG Generator
 *
 * Renders an Airflow DAG Python file from a ForgeJobManifest, using the
 * SparkKubernetesOperator pattern matching the existing forge_demo_*_dag.py
 * and nyc_taxi_*_dag.py files in the Forge platform.
 *
 * The generated file is fully managed (no editable sentinel block) — all
 * customisation is done through the manifest.
 */
import type { ForgeJobManifest } from "../schema.js";
import { rulesAsYaml } from "./dq.js";
import cronstrue from "cronstrue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPascalCase(name: string): string {
  return name
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function cronDescription(schedule: string): string {
  try {
    return cronstrue.toString(schedule);
  } catch {
    return schedule;
  }
}

/** Determine DAG folder: "ingestion" for bronze, "transformation" for silver/gold */
function dagFolder(layer: ForgeJobManifest["layer"]): string {
  return layer === "bronze" ? "ingestion" : "transformation";
}

/** Render env var entries for each param (in the SparkApplication YAML). */
function renderEnvVars(
  params: ForgeJobManifest["params"],
  indent = "      "
): string {
  return Object.entries(params)
    .map(([name, p]) => {
      if (p.source === "configmap") {
        return [
          `${indent}- name: ${name}`,
          `${indent}  valueFrom:`,
          `${indent}    configMapKeyRef:`,
          `${indent}      name: forge-platform-config`,
          `${indent}      key: ${name.toLowerCase()}`,
        ].join("\n");
      }
      if (p.source === "airflow_var") {
        // Rendered as a Jinja template variable in the YAML
        return [
          `${indent}- name: ${name}`,
          `${indent}  value: "{{{{ var.value.get('${name.toLowerCase()}', '${p.default ?? ""}') }}}}"`,
        ].join("\n");
      }
      // PARTITION_DATE auto-injection: {{ ds }} = logical_date as YYYY-MM-DD.
      // Works for both scheduled and manual triggers.
      // Year/month/hour are derived from PARTITION_DATE in the Spark job itself.
      if (name === "PARTITION_DATE") {
        return [
          `${indent}- name: ${name}`,
          `${indent}  value: "{{{{ ds }}}}"`,
        ].join("\n");
      }
      if (p.default !== undefined) {
        return [
          `${indent}- name: ${name}`,
          `${indent}  value: "${p.default}"`,
        ].join("\n");
      }
      return [
        `${indent}- name: ${name}`,
        `${indent}  value: ""  # TODO: set value`,
      ].join("\n");
    })
    .join("\n");
}

/** Build effective params map, auto-injecting partition params if absent. */
function buildEffectiveParams(
  manifest: ForgeJobManifest
): ForgeJobManifest["params"] {
  const base = { ...manifest.params };
  if (!base["PARTITION_DATE"]) {
    base["PARTITION_DATE"] = {
      type: "string",
      default: "",
      description: "Partition date (yyyy-MM-dd) — set by Airflow data_interval_start",
    };
  }
  // PARTITION_HOUR always present — 0 when date column has no time component
  if (!base["PARTITION_HOUR"]) {
    base["PARTITION_HOUR"] = {
      type: "int",
      default: 0,
      description: "Partition hour (0–23) — 0 when date column has no time component",
    };
  }
  return base;
}

/** Render the SparkApplication YAML template string.
 *
 * @param manifest  The job manifest.
 * @param taskType  "ingest" (default) — main job; "dq" — DQ gate job.
 */
function renderSparkApp(
  manifest: ForgeJobManifest,
  taskType: "ingest" | "dq" = "ingest"
): string {
  const isDq = taskType === "dq";

  // DQ gate uses a smaller resource footprint
  const driverCores   = isDq ? 1  : (manifest.resources?.driver?.cores    ?? 2);
  const driverMemory  = isDq ? "2g" : (manifest.resources?.driver?.memory  ?? "4g");
  const executorCores = isDq ? 2  : (manifest.resources?.executor?.cores   ?? 4);
  const executorMemory = isDq ? "4g" : (manifest.resources?.executor?.memory ?? "8g");
  const executorInstances = isDq ? 2 : (manifest.resources?.executor?.instances ?? 2);

  const appName = isDq
    ? `${manifest.name.replace(/_/g, "-")}-dq-gate`
    : manifest.name.replace(/_/g, "-");

  const mainFile = isDq
    ? `"abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/forge_dq_gate.py"`
    : `"abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/${manifest.name}.py"`;

  // Derive table name for DQ gate env vars.
  // Prefer output.name (e.g. "NycTaxiTrips") which the Spark job uses to register the HMS table,
  // falling back to output.path.assetName for legacy manifests without an explicit output.name.
  const _outputSlug = (manifest.output.name ?? manifest.output.path.assetName)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const table = manifest.output.table ?? `${manifest.layer}.${_outputSlug}`;

  // Env vars differ by task type
  let envVarsStr: string;
  if (isDq) {
    // DQ gate: fixed env vars — LAYER, TABLE, PARTITION_DATE, RULES_YAML
    const yaml = rulesAsYaml(manifest);
    const rulesB64 = yaml ? Buffer.from(yaml).toString("base64") : "";
    envVarsStr = [
      `      - name: LAYER`,
      `        value: "${manifest.layer}"`,
      `      - name: TABLE`,
      `        value: "${table}"`,
      `      - name: PARTITION_DATE`,
      `        value: "{{{{ ds }}}}"`,
      `      - name: RULES_YAML`,
      `        value: "${rulesB64}"`,
      `      - name: FORGE_PORTAL_API_URL`,
      `        valueFrom:`,
      `          configMapKeyRef:`,
      `            name: forge-platform-config`,
      `            key: portal_api_url`,
      `            optional: true`,
    ].join("\n");
  } else {
    const effectiveParams = buildEffectiveParams(manifest);
    const envVars = renderEnvVars(effectiveParams);
    const platformEnv = `      - name: FORGE_ENV
        valueFrom:
          configMapKeyRef:
            name: forge-platform-config
            key: env
      - name: FORGE_STORAGE_ACCOUNT
        valueFrom:
          configMapKeyRef:
            name: forge-platform-config
            key: storage_account
      - name: FORGE_PORTAL_API_URL
        valueFrom:
          configMapKeyRef:
            name: forge-platform-config
            key: portal_api_url
            optional: true`;
    envVarsStr = envVars ? `${envVars}\n${platformEnv}` : platformEnv;
  }

  // Adaptive shuffle for silver/gold (ingest task only)
  const adaptiveConf =
    !isDq && manifest.layer !== "bronze"
      ? `    spark.sql.adaptive.enabled: "true"
    spark.sql.adaptive.coalescePartitions.enabled: "true"`
      : "";

  return `f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: ${appName}-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: ${mainFile}
  sparkVersion: "4.1.1"
  restartPolicy:
    type: OnFailure
    onFailureRetries: 1
    onFailureRetryInterval: 10
  driver:
    cores: ${driverCores}
    memory: "${driverMemory}"
    serviceAccount: spark
    tolerations:
      - key: workload
        operator: Equal
        value: spark
        effect: NoSchedule
    volumeMounts:
      - name: fixed-entrypoint
        mountPath: /opt/entrypoint.sh
        subPath: entrypoint.sh
    labels:
      app: ${appName}
      azure.workload.identity/use: "true"
    env:
${envVarsStr}
  executor:
    cores: ${executorCores}
    instances: ${executorInstances}
    memory: "${executorMemory}"
    tolerations:
      - key: workload
        operator: Equal
        value: spark
        effect: NoSchedule
    labels:
      app: ${appName}
      azure.workload.identity/use: "true"
  sparkConf:
    # ADLS Gen2 — workload identity OAuth (account-scoped; does not affect external accounts)
    spark.hadoop.fs.azure.account.auth.type.{_STORAGE_ACCOUNT}.dfs.core.windows.net: OAuth
    spark.hadoop.fs.azure.account.oauth.provider.type.{_STORAGE_ACCOUNT}.dfs.core.windows.net: org.apache.hadoop.fs.azurebfs.oauth2.WorkloadIdentityTokenProvider
    spark.hadoop.fs.azure.account.oauth2.msi.tenant.{_STORAGE_ACCOUNT}.dfs.core.windows.net: "{_TENANT_ID}"
    spark.hadoop.fs.azure.account.oauth2.client.id.{_STORAGE_ACCOUNT}.dfs.core.windows.net: "{_SPARK_MI_CLIENT}"
    spark.hadoop.fs.abfss.impl: org.apache.hadoop.fs.azurebfs.SecureAzureBlobFileSystem
    spark.hadoop.fs.abfs.impl: org.apache.hadoop.fs.azurebfs.AzureBlobFileSystem
    spark.hadoop.fs.azure.enable.hierarchical.namespace: "true"
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.hadoop.hive.metastore.uris: thrift://hive-metastore.metastore.svc.cluster.local:9083
    spark.sql.hive.metastore.version: "3.1.3"
    spark.sql.hive.metastore.jars: builtin
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "24"
${adaptiveConf}
  volumes:
    - name: fixed-entrypoint
      configMap:
        name: spark-fixed-entrypoint
        defaultMode: 0755
"""`;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate an Airflow DAG Python file from a manifest.
 *
 * Returns the file content and the target subfolder (ingestion | transformation).
 */
export function generateDag(manifest: ForgeJobManifest, ownerAlias?: string): {
  content: string;
  folder: string;
} {
  const folder = dagFolder(manifest.layer);
  const hasSchedule = !!manifest.schedule;
  const hasTriggeredBy = !!manifest.triggeredBy;

  const scheduleValue = hasSchedule
    ? `"${manifest.schedule}"`
    : "None";
  const scheduleDesc = hasSchedule
    ? cronDescription(manifest.schedule!)
    : "Triggered (no independent schedule)";

  const allTags = [
    manifest.layer,
    folder,
    ...manifest.name.split("_").slice(0, 2),
    ...(manifest.tags ?? []),
    `source:${manifest.source.name}`,   // portal: labels the source node in the task graph
    `output:${manifest.output.name ?? manifest.output.path.assetName}`,  // portal: derives display name for the output dataset
    `executors:${manifest.resources?.executor?.instances ?? 2}`,  // portal: executor count shown in pipeline activity card
    `exec_cores:${manifest.resources?.executor?.cores ?? 4}`,     // portal: cores per executor
    `exec_mem:${manifest.resources?.executor?.memory ?? "8g"}`,   // portal: memory per executor
  ];
  // Deduplicate
  const tags = [...new Set(allTags)];
  const tagsRepr = tags.map((t) => `"${t}"`).join(", ");

  const dagOwner = ownerAlias ?? "data-engineering";
  const retries = manifest.retries ?? 2;
  const retryDelayMins = manifest.retryDelayMinutes ?? (manifest.layer === "bronze" ? 5 : 10);
  const retryDelay = `timedelta(minutes=${retryDelayMins})`;
  const slaHours = manifest.slaHours ?? (manifest.layer === "bronze" ? 2 : manifest.layer === "silver" ? 3 : 4);
  const execHours = manifest.executionTimeoutHours ?? (manifest.layer === "bronze" ? 1 : 2);

  const sensorImport = hasTriggeredBy
    ? `from airflow.sensors.external_task import ExternalTaskSensor\n`
    : "";

  const ingestTaskId =
    manifest.layer === "bronze"
      ? `ingest_${manifest.name.replace(/^[^_]+_/, "")}`
      : `transform_${manifest.name.replace(/^[^_]+_[^_]+_/, "")}`;

  const dqTaskId = `dq_gate_${manifest.layer}`;

  const ingestTaskVar = `ingest_task`;
  const dqTaskVar = `dq_task`;

  const hasDq = !!(manifest.dq?.rules && manifest.dq.rules.length > 0);

  // ExternalTaskSensor task (when triggeredBy is set)
  const upstreamDagId = manifest.triggeredBy ?? "";
  const sensorTaskVar = hasTriggeredBy ? `wait_for_${upstreamDagId}` : "";
  const sensorTask = hasTriggeredBy
    ? `
    ${sensorTaskVar} = ExternalTaskSensor(
        task_id="wait_for_${upstreamDagId}",
        external_dag_id="${upstreamDagId}",
        external_task_id=None,
        mode="reschedule",
        timeout=timedelta(hours=8),
        poke_interval=120,
    )
`
    : "";

  // Build task dependency chain: sensor (if any) >> ingest >> dq_gate (if any)
  const taskDeps = hasTriggeredBy
    ? `\n    ${sensorTaskVar} >> ${ingestTaskVar}${hasDq ? ` >> ${dqTaskVar}` : ""}`
    : hasDq
    ? `\n    ${ingestTaskVar} >> ${dqTaskVar}`
    : "";

  const triggeredByNote = hasTriggeredBy
    ? `Triggered by: ${upstreamDagId} (ExternalTaskSensor — same logical date)\n`
    : "";

  const _outputSlug2 = (manifest.output.name ?? manifest.output.path.assetName)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const table = manifest.output.table ?? `${manifest.layer}.${_outputSlug2}`;

  // Parse startDate from manifest or default to 2024-01-01
  const startDateStr = manifest.startDate ?? "2024-01-01";
  const [sdYear, sdMonth, sdDay] = startDateStr.split("-").map(Number);
  const startDatePy = `datetime(${sdYear}, ${sdMonth}, ${sdDay})`;

  const endDatePy = manifest.endDate
    ? (() => {
        const [edYear, edMonth, edDay] = manifest.endDate.split("-").map(Number);
        return `datetime(${edYear}, ${edMonth}, ${edDay})`;
      })()
    : null;

  const catchup = manifest.catchup ?? false;
  const maxActiveRuns = manifest.maxActiveRuns ?? (manifest.schedule ? 3 : 1);

  // Build env_vars dict for ForgeSparkOperator (job params + PARTITION_DATE/HOUR, no RESTATE/platform vars)
  const effectiveParams = buildEffectiveParams(manifest);
  const envVarEntries = Object.entries(effectiveParams)
    .filter(([name]) => name !== "RESTATE") // RESTATE is manual only
    .map(([name, p]) => {
      if (name === "PARTITION_DATE") return `            "PARTITION_DATE": "{{ ds }}"`;
      if (name === "PARTITION_HOUR") return `            "PARTITION_HOUR": "${p.default ?? 0}"`;
      if (p.source === "airflow_var") return `            "${name}": "{{ var.value.get('${name.toLowerCase()}', '${p.default ?? ""}') }}"`;
      return `            "${name}": "${p.default ?? ""}"`;
    });
  const envVarsStr = envVarEntries.length > 0
    ? `{\n${envVarEntries.join(",\n")},\n        }`
    : "{}";


  const content = `"""
DAG: ${manifest.name}
${"=".repeat(manifest.name.length + 5)}
${manifest.description}

${triggeredByNote}Schedule:    ${scheduleDesc}
Start date:  ${startDateStr}${catchup ? `  (catchup enabled — backfills all missed slots since start date)` : ""}
${manifest.endDate ? `End date:    ${manifest.endDate}  (no runs scheduled after this date)\n` : ""}
Parallelism: max_active_runs=${maxActiveRuns}${catchup && maxActiveRuns > 1 ? ` — up to ${maxActiveRuns} slots run in parallel during backfill` : ""}
SLA:         ${slaHours} hours
Retries:     ${retries} × ${retryDelayMins}-minute back-off

Layer:   ${manifest.layer}
Table:   ${table}
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
${sensorImport}from forge_airflow import ForgeSparkOperator${hasDq ? ", ForgeDqGateOperator" : ""}

# ---------------------------------------------------------------------------
# Default task arguments
# ---------------------------------------------------------------------------
default_args = {
    "owner": "${dagOwner}",
    "depends_on_past": False,
    "retries": ${retries},
    "retry_delay": ${retryDelay},
    "execution_timeout": timedelta(hours=${execHours}),
    "sla": timedelta(hours=${slaHours}),
    "email_on_failure": True,
    "email_on_retry": False,
}

# ---------------------------------------------------------------------------
# DAG
# ---------------------------------------------------------------------------
with DAG(
    dag_id="${manifest.name}",
    description="${manifest.description.replace(/"/g, '\\"')}",
    schedule=${scheduleValue},
    start_date=${startDatePy},
    catchup=${catchup ? "True" : "False"},
    ${endDatePy ? `end_date=${endDatePy},\n    ` : ""}max_active_runs=${maxActiveRuns},
    is_paused_upon_creation=False,
    tags=[${tagsRepr}],
    default_args=default_args,
    doc_md=__doc__,
) as dag:
${sensorTask}
    ${ingestTaskVar} = ForgeSparkOperator(
        task_id="${ingestTaskId}",
        job="${manifest.name}",
        layer="${manifest.layer}",
        env_vars=${envVarsStr},
        driver={"cores": ${manifest.resources?.driver?.cores ?? 2}, "memory": "${manifest.resources?.driver?.memory ?? "4g"}"},
        executor={"cores": ${manifest.resources?.executor?.cores ?? 4}, "memory": "${manifest.resources?.executor?.memory ?? "8g"}", "instances": ${manifest.resources?.executor?.instances ?? 2}},
    )
${hasDq ? `
    ${dqTaskVar} = ForgeDqGateOperator(
        task_id="${dqTaskId}",
        job="${manifest.name}",
        layer="${manifest.layer}",
        table="${table}",
    )
` : ""}${taskDeps}
`;

  return { content, folder };
}

export { dagFolder };
