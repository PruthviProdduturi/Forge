"""
forge_dq.output.schema — PySpark StructType schemas for the three DQ Delta tables.

Tables are written to ADLS under the container that matches the dataset layer:
  _dq/auto/{safe_dataset_name}/metrics     — auto profiling (every write)
  _dq/rules/{safe_dataset_name}/results    — rule check results
  _dq/anomaly/{safe_dataset_name}/results  — SPC anomaly detection results
"""
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# ---------------------------------------------------------------------------
# Auto metrics schema
# Written once per Spark write operation; captures row-level profile summary.
# ---------------------------------------------------------------------------
AUTO_METRICS_SCHEMA = StructType(
    [
        StructField("run_id", StringType(), nullable=False),
        StructField("pipeline_name", StringType(), nullable=True),
        StructField("dataset_path", StringType(), nullable=False),
        StructField("environment", StringType(), nullable=True),
        StructField("run_timestamp", TimestampType(), nullable=False),
        StructField("rows_written", LongType(), nullable=False),
        StructField("schema_json", StringType(), nullable=True),
        StructField("column_profiles", StringType(), nullable=True),  # JSON array
        StructField("write_duration_ms", LongType(), nullable=True),
    ]
)

# ---------------------------------------------------------------------------
# Rule results schema
# One row per evaluated rule per run.
# ---------------------------------------------------------------------------
RULE_RESULTS_SCHEMA = StructType(
    [
        StructField("run_id", StringType(), nullable=False),
        StructField("pipeline_name", StringType(), nullable=True),
        StructField("dataset_path", StringType(), nullable=False),
        StructField("run_timestamp", TimestampType(), nullable=False),
        StructField("rule_name", StringType(), nullable=False),
        StructField("rule_type", StringType(), nullable=True),
        StructField("severity", StringType(), nullable=True),
        StructField("status", StringType(), nullable=False),  # PASS|FAIL|WARN|SKIPPED
        StructField("message", StringType(), nullable=True),
        StructField("actual_value", StringType(), nullable=True),
        StructField("expected_value", StringType(), nullable=True),
        StructField("affected_rows", LongType(), nullable=True),
    ]
)

# ---------------------------------------------------------------------------
# Anomaly results schema
# One row per flagged metric per run.
# ---------------------------------------------------------------------------
ANOMALY_RESULTS_SCHEMA = StructType(
    [
        StructField("run_id", StringType(), nullable=False),
        StructField("dataset_path", StringType(), nullable=False),
        StructField("run_timestamp", TimestampType(), nullable=False),
        StructField("metric_name", StringType(), nullable=False),
        StructField("current_value", DoubleType(), nullable=True),
        StructField("mean_30d", DoubleType(), nullable=True),
        StructField("stddev_30d", DoubleType(), nullable=True),
        StructField("z_score", DoubleType(), nullable=True),
        StructField("is_anomaly", BooleanType(), nullable=False),
        StructField("severity", StringType(), nullable=True),
        StructField("message", StringType(), nullable=True),
    ]
)
