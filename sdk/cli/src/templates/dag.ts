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
      // Default: env — use partition param convention or data_interval_start
      const nameLower = name.toLowerCase();
      const isDateParam =
        nameLower.includes("date") ||
        nameLower.includes("year") ||
        nameLower.includes("month") ||
        nameLower.includes("hour");
      if (isDateParam) {
        const fmt =
          nameLower.includes("year")
            ? "%Y"
            : nameLower.includes("month")
            ? "%-m"
            : nameLower.includes("hour")
            ? "%-H"
            : "%Y-%m-%d";
        return [
          `${indent}- name: ${name}`,
          `${indent}  value: "{{{{ data_interval_start.strftime('${fmt}') }}}}"`,
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

/** Render the SparkApplication YAML template string. */
function renderSparkApp(manifest: ForgeJobManifest): string {
  const driverCores = manifest.resources?.driver?.cores ?? 2;
  const driverMemory = manifest.resources?.driver?.memory ?? "4g";
  const executorCores = manifest.resources?.executor?.cores ?? 4;
  const executorMemory = manifest.resources?.executor?.memory ?? "8g";
  const executorInstances = manifest.resources?.executor?.instances ?? 2;

  const effectiveParams = buildEffectiveParams(manifest);
  const envVars = renderEnvVars(effectiveParams);

  // Standard platform env vars appended to every job
  const platformEnv = `      - name: FORGE_ENV
        valueFrom:
          configMapKeyRef:
            name: forge-platform-config
            key: env
      - name: FORGE_STORAGE_ACCOUNT
        valueFrom:
          configMapKeyRef:
            name: forge-platform-config
            key: storage_account`;

  const allEnvVars = envVars ? `${envVars}\n${platformEnv}` : platformEnv;

  // Adaptive shuffle for silver/gold
  const adaptiveConf =
    manifest.layer !== "bronze"
      ? `    spark.sql.adaptive.enabled: "true"
    spark.sql.adaptive.coalescePartitions.enabled: "true"`
      : "";

  return `f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: ${manifest.name.replace(/_/g, "-")}-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/${manifest.name}.py"
  sparkVersion: "4.1.1"
  restartPolicy:
    type: OnFailure
    onFailureRetries: 1
    onFailureRetryInterval: 10
  driver:
    cores: ${driverCores}
    memory: "${driverMemory}"
    serviceAccount: spark
    labels:
      app: ${manifest.name.replace(/_/g, "-")}
    env:
${allEnvVars}
  executor:
    cores: ${executorCores}
    instances: ${executorInstances}
    memory: "${executorMemory}"
    labels:
      app: ${manifest.name.replace(/_/g, "-")}
  sparkConf:
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.hadoop.hive.metastore.uris: thrift://hive-metastore.metastore.svc.cluster.local:9083
    spark.sql.hive.metastore.version: "3.1.3"
    spark.sql.hive.metastore.jars: builtin
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "24"
    spark.submit.pyFiles: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/lib/forge_lib.zip"
${adaptiveConf}
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
export function generateDag(manifest: ForgeJobManifest): {
  content: string;
  folder: string;
} {
  const folder = dagFolder(manifest.layer);
  const hasSchedule = !!manifest.schedule;
  const hasTriggers = manifest.triggers && manifest.triggers.length > 0;

  const scheduleValue = hasSchedule
    ? `"${manifest.schedule}"`
    : "None  # triggered by upstream";
  const scheduleDesc = hasSchedule
    ? cronDescription(manifest.schedule!)
    : "Triggered (no independent schedule)";

  const allTags = [
    manifest.layer,
    folder,
    ...manifest.name.split("_").slice(0, 2),
    ...(manifest.tags ?? []),
  ];
  // Deduplicate
  const tags = [...new Set(allTags)];
  const tagsRepr = tags.map((t) => `"${t}"`).join(", ");

  const retryDelay =
    manifest.layer === "bronze" ? "timedelta(minutes=5)" : "timedelta(minutes=10)";
  const slaHours = manifest.layer === "bronze" ? 2 : manifest.layer === "silver" ? 3 : 4;
  const execHours = manifest.layer === "bronze" ? 1 : 2;

  const triggerImport =
    hasTriggers
      ? `from airflow.operators.trigger_dagrun import TriggerDagRunOperator\n`
      : "";

  const taskId =
    manifest.layer === "bronze"
      ? `ingest_${manifest.name.replace(/^[^_]+_/, "")}`
      : `transform_${manifest.name.replace(/^[^_]+_[^_]+_/, "")}`;

  const sparkTaskVar = `spark_task`;

  const triggerTasks = (manifest.triggers ?? [])
    .map(
      (dagId) => `
    trigger_${dagId} = TriggerDagRunOperator(
        task_id="trigger_${dagId}",
        trigger_dag_id="${dagId}",
        logical_date="{{ data_interval_start }}",
        wait_for_completion=False,
        reset_dag_run=True,
    )`
    )
    .join("\n");

  const taskDeps =
    hasTriggers
      ? `\n    ${sparkTaskVar} >> [${(manifest.triggers ?? [])
          .map((d) => `trigger_${d}`)
          .join(", ")}]`
      : "";

  const triggeredByNote = manifest.triggeredBy
    ? `Triggered by: ${manifest.triggeredBy} (via TriggerDagRunOperator)\n`
    : "";

  const triggersNote =
    hasTriggers
      ? `Triggers:    ${manifest.triggers!.join(", ")} on success\n`
      : "";

  const table = manifest.output.table ??
    `lakehouse.${manifest.layer}.${manifest.output.path.assetName.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

  const content = `"""
DAG: ${manifest.name}
${"=".repeat(manifest.name.length + 5)}
${manifest.description}

${triggeredByNote}${triggersNote}Schedule:   ${scheduleDesc}
SLA:        ${slaHours} hour${slaHours !== 1 ? "s" : ""}
Retries:    2 × ${manifest.layer === "bronze" ? "5" : "10"}-minute back-off

Layer:   ${manifest.layer}
Table:   ${table}
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
${triggerImport}from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

# ---------------------------------------------------------------------------
# Shared template values — resolved at render time via Airflow Variables so
# the same DAG file works across dev / staging / prod without edits.
# ---------------------------------------------------------------------------
_SPARK_IMAGE = "{{ var.value.get('spark_image', 'forgeacrprproddu.azurecr.io/spark:4.1.1') }}"
_STORAGE_ACCOUNT = "{{ var.value.get('storage_account', 'forgeadlsprproddudev') }}"

# ---------------------------------------------------------------------------
# SparkApplication YAML — Jinja-rendered per run.
# ---------------------------------------------------------------------------
_SPARK_APP = ${renderSparkApp(manifest)}

# ---------------------------------------------------------------------------
# Default task arguments
# ---------------------------------------------------------------------------
default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
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
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=3,
    tags=[${tagsRepr}],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    ${sparkTaskVar} = SparkKubernetesOperator(
        task_id="${taskId}",
        namespace="spark-jobs",
        application_file=_SPARK_APP,
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )
${triggerTasks}${taskDeps}
`;

  return { content, folder };
}

export { dagFolder };
