"""
forge_airflow.operators — Platform Spark operators for Forge DAGs.

ForgeSparkOperator:
  Wraps SparkKubernetesOperator and builds the full SparkApplication YAML from
  Airflow Variables + manifest-level settings.  DAG authors never see the YAML.

ForgeDqGateOperator:
  Submits forge_dq_gate.py to the compute cluster after an ingest task.
  Inherits the same platform defaults as ForgeSparkOperator.

Platform config is read from Airflow Variables at DAG parse time:
  spark_image        — ACR image (e.g. forgeacrDSEng.azurecr.io/spark:4.1.1)
  storage_account    — ADLS account name (e.g. forgeadlsdsengdev)
  aad_tenant_id      — AAD tenant ID for workload identity OAuth
  spark_mi_client_id — Managed Identity client ID for ADLS OAuth

None of these have hardcoded defaults — they MUST be set as Airflow Variables.
Missing variables raise at DAG parse time with a clear error.
"""
from __future__ import annotations

from typing import Any

from airflow.models import Variable as _V
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)


def _require(var: str) -> str:
    """Fetch an Airflow Variable, raising at parse time if missing."""
    val = _V.get(var, default_var=None)
    if not val:
        raise RuntimeError(
            f"[Forge] Airflow Variable '{var}' is not set. "
            f"Set it in Admin → Variables before using ForgeSparkOperator."
        )
    return val


def _platform_vars() -> dict[str, str]:
    """Resolve all required platform Variables once."""
    return {
        "spark_image":     _require("spark_image"),
        "storage_account": _require("storage_account"),
        "tenant_id":       _require("aad_tenant_id"),
        "mi_client_id":    _require("spark_mi_client_id"),
    }


def _build_spark_app(
    *,
    job_name: str,
    platform: dict[str, str],
    env_vars: dict[str, Any],
    driver: dict[str, Any],
    executor: dict[str, Any],
    layer: str,
    main_file: str | None = None,
    adaptive_shuffle: bool = False,
) -> str:
    """Build a SparkApplication YAML string for the given job."""
    spark_image     = platform["spark_image"]
    storage_account = platform["storage_account"]
    tenant_id       = platform["tenant_id"]
    mi_client_id    = platform["mi_client_id"]

    app_name  = job_name.replace("_", "-")
    main_file = main_file or f"abfss://code@{storage_account}.dfs.core.windows.net/spark/jobs/{job_name}.py"

    driver_cores   = driver.get("cores", 2)
    driver_memory  = driver.get("memory", "4g")
    executor_cores = executor.get("cores", 4)
    executor_mem   = executor.get("memory", "8g")
    executor_inst  = executor.get("instances", 2)

    # Render env var entries
    env_lines: list[str] = []
    for name, value in env_vars.items():
        if isinstance(value, dict) and "configMapKeyRef" in value:
            key = value["configMapKeyRef"]
            env_lines += [
                f"      - name: {name}",
                f"        valueFrom:",
                f"          configMapKeyRef:",
                f"            name: forge-platform-config",
                f"            key: {key}",
            ]
        else:
            env_lines += [
                f"      - name: {name}",
                f'        value: "{value}"',
            ]

    # Always append platform env vars (FORGE_ENV, FORGE_STORAGE_ACCOUNT)
    env_lines += [
        "      - name: FORGE_ENV",
        "        valueFrom:",
        "          configMapKeyRef:",
        "            name: forge-platform-config",
        "            key: env",
        "      - name: FORGE_STORAGE_ACCOUNT",
        "        valueFrom:",
        "          configMapKeyRef:",
        "            name: forge-platform-config",
        "            key: storage_account",
    ]
    env_block = "\n".join(env_lines)

    adaptive_conf = ""
    if adaptive_shuffle:
        adaptive_conf = (
            f'    spark.sql.adaptive.enabled: "true"\n'
            f'    spark.sql.adaptive.coalescePartitions.enabled: "true"'
        )

    return f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: {app_name}-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  timeToLiveSeconds: 3600
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{spark_image}"
  imagePullPolicy: Always
  mainApplicationFile: "{main_file}"
  sparkVersion: "4.1.1"
  restartPolicy:
    type: OnFailure
    onFailureRetries: 1
    onFailureRetryInterval: 10
  driver:
    cores: {driver_cores}
    memory: "{driver_memory}"
    serviceAccount: spark
    javaOptions: "-Dhive.metastore.warehouse.dir=file:///opt/hive/data/warehouse"
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
      app: {app_name}
      azure.workload.identity/use: "true"
    env:
{env_block}
  executor:
    cores: {executor_cores}
    instances: {executor_inst}
    memory: "{executor_mem}"
    tolerations:
      - key: workload
        operator: Equal
        value: spark
        effect: NoSchedule
    labels:
      app: {app_name}
      azure.workload.identity/use: "true"
  sparkConf:
    spark.hadoop.fs.azure.account.auth.type.{storage_account}.dfs.core.windows.net: OAuth
    spark.hadoop.fs.azure.account.oauth.provider.type.{storage_account}.dfs.core.windows.net: org.apache.hadoop.fs.azurebfs.oauth2.WorkloadIdentityTokenProvider
    spark.hadoop.fs.azure.account.oauth2.msi.tenant.{storage_account}.dfs.core.windows.net: "{tenant_id}"
    spark.hadoop.fs.azure.account.oauth2.client.id.{storage_account}.dfs.core.windows.net: "{mi_client_id}"
    spark.hadoop.fs.abfss.impl: org.apache.hadoop.fs.azurebfs.SecureAzureBlobFileSystem
    spark.hadoop.fs.abfs.impl: org.apache.hadoop.fs.azurebfs.AzureBlobFileSystem
    spark.hadoop.fs.azure.enable.hierarchical.namespace: "true"
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.hadoop.hive.metastore.uris: thrift://hive-metastore.hive-metastore.svc.cluster.local:9083
    spark.sql.warehouse.dir: "file:///opt/hive/data/warehouse"
    spark.hadoop.hive.metastore.warehouse.dir: "file:///opt/hive/data/warehouse"
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "24"
{adaptive_conf}
  volumes:
    - name: fixed-entrypoint
      configMap:
        name: spark-fixed-entrypoint
        defaultMode: 0755
"""


class ForgeSparkOperator(SparkKubernetesOperator):
    """Submit a Forge Spark job to the compute cluster.

    Reads all platform configuration from Airflow Variables at parse time.
    DAG authors only provide job-specific settings.

    Args:
        job:            Job name — matches the .py file uploaded to ADLS code/spark/jobs/.
        layer:          Medallion layer: bronze | silver | gold.
        env_vars:       Job-specific environment variables (PARTITION_DATE, params, etc.).
        driver:         Driver resource overrides (cores, memory).
        executor:       Executor resource overrides (cores, memory, instances).
        adaptive:       Enable adaptive query execution (default True for silver/gold).
        **kwargs:       Passed through to SparkKubernetesOperator.
    """

    def __init__(
        self,
        *,
        job: str,
        layer: str = "bronze",
        env_vars: dict[str, Any] | None = None,
        driver: dict[str, Any] | None = None,
        executor: dict[str, Any] | None = None,
        adaptive: bool | None = None,
        **kwargs: Any,
    ) -> None:
        platform = _platform_vars()
        _adaptive = adaptive if adaptive is not None else (layer != "bronze")
        app_yaml = _build_spark_app(
            job_name=job,
            platform=platform,
            env_vars=env_vars or {},
            driver=driver or {},
            executor=executor or {},
            layer=layer,
            adaptive_shuffle=_adaptive,
        )
        super().__init__(
            namespace="spark-jobs",
            application_file=app_yaml,
            kubernetes_conn_id="kubernetes_compute_cluster",
            do_xcom_push=False,
            poll_interval=30,
            **kwargs,
        )


class ForgeDqGateOperator(SparkKubernetesOperator):
    """Submit the platform DQ gate job after an ingest/transform task.

    DQ rules are read from ADLS at ``code/dq/rules/{job}.yaml`` — uploaded
    by sync-jobs.sh.  No base64 blobs in the DAG.

    Args:
        job:        Job name (e.g. nyc_taxi_bronze) — used to locate rules file.
        layer:      Medallion layer (bronze | silver | gold).
        table:      Hive table name (e.g. bronze.nyctaxi).
        **kwargs:   Passed through to SparkKubernetesOperator.
    """

    def __init__(
        self,
        *,
        job: str,
        layer: str,
        table: str,
        **kwargs: Any,
    ) -> None:
        platform = _platform_vars()
        storage  = platform["storage_account"]
        rules_path = f"abfss://code@{storage}.dfs.core.windows.net/dq/rules/{job}.yaml"
        app_yaml = _build_spark_app(
            job_name=f"{job}-dq-gate",
            platform=platform,
            env_vars={
                "LAYER":          layer,
                "TABLE":          table,
                "PARTITION_DATE": "{{ ds }}",
                "RULES_PATH":     rules_path,
            },
            driver={"cores": 1, "memory": "2g"},
            executor={"cores": 2, "memory": "4g", "instances": 2},
            layer=layer,
            main_file=f"abfss://code@{storage}.dfs.core.windows.net/spark/jobs/forge_dq_gate.py",
            adaptive_shuffle=False,
        )
        super().__init__(
            namespace="spark-jobs",
            application_file=app_yaml,
            kubernetes_conn_id="kubernetes_compute_cluster",
            do_xcom_push=False,
            poll_interval=30,
            **kwargs,
        )
