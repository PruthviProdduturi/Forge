"""
Forge Demo — Bronze: Synthetic Retail Orders Ingestion
======================================================
Generates ~1 000 synthetic retail order records for a given partition date
and writes them to the bronze Delta table ``lakehouse.bronze.retail_orders``
registered in the Hive Metastore.

This job is the first stage of the Forge platform end-to-end demo pipeline.
It produces deterministic, reproducible data — the same PARTITION_DATE always
yields the same rows — so the demo can be re-run safely and compared across
environments without any external data dependency.

Dataset schema (retail_orders):
  order_id          string       — "ORD-" + zero-padded row index (8 digits)
  customer_id       string       — "CUST-" + (id % 200 + 1), 200 distinct customers
  product_id        string       — "PROD-" + (id % 50 + 1), 50 distinct products
  product_category  string       — Electronics | Clothing | Food | Home | Sports
  quantity          int          — 1–10 units
  unit_price        double       — $1.99–$500.99 (rounded to 2 dp)
  order_timestamp   timestamp    — spread across the partition date (86 s intervals)
  status            string       — pending | confirmed | shipped | delivered | cancelled
  region            string       — North | South | East | West | Central
  order_date        string       — partition column, equals PARTITION_DATE (yyyy-MM-dd)
  _source           string       — always "synthetic-generator"
  _ingested_at      timestamp    — wall-clock time of the Spark write

Environment variables:
  PARTITION_DATE        — Target date (yyyy-MM-dd).  Defaults to today (UTC).
  FORGE_ENV             — Injected by Airflow via forge-platform-config ConfigMap.
  FORGE_STORAGE_ACCOUNT — Injected by Airflow via forge-platform-config ConfigMap.

Write strategy:
  Delta replaceWhere on ``order_date = '<partition_date>'`` so the job is
  fully idempotent — re-running for the same date replaces that partition only.
  The table is registered in HMS as ``lakehouse.bronze.retail_orders`` so
  Trino, Spark SQL, and the Forge portal can all query it by name.

DQ:
  No DQ gate on bronze — raw data is written as-is.  Quality checks run on
  the silver layer (forge_demo_silver.py via forge_dq @track).

Lineage:
  Emitted automatically to Microsoft Purview via the OpenLineage listener
  configured in forge_session().  No extra code required.

Next stage:
  Triggers forge_demo_silver via TriggerDagRunOperator in
  forge_demo_bronze_dag.py once this job completes successfully.
"""
from __future__ import annotations

import os
from datetime import date

from pyspark.sql import functions as F

from forge_sdk import ForgeJob

# forge_dq is available in the Spark image but the @track decorator is not
# used on bronze (raw ingest, no DQ gate).  The import with fallback is kept
# here for consistency with the ForgeJob pattern and to allow future use.
try:
    from forge_dq import track  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    import functools

    def track(**kwargs):  # type: ignore[misc]  # noqa: ANN202
        """No-op fallback when forge_dq is not installed."""
        def decorator(fn):  # noqa: ANN202
            @functools.wraps(fn)
            def wrapper(*args, **kw):  # noqa: ANN202
                return fn(*args, **kw)
            return wrapper
        return decorator


class ForgeDemoBronze(ForgeJob):
    """
    Generates ~1 000 synthetic retail orders for PARTITION_DATE and writes
    them to the bronze Delta table ``lakehouse.bronze.retail_orders``.
    """

    def run(self) -> None:
        # -----------------------------------------------------------------
        # Resolve partition date from environment (set by Airflow SparkApp)
        # -----------------------------------------------------------------
        partition_date: str = os.environ.get(
            "PARTITION_DATE", date.today().isoformat()
        )
        self.log.info("forge_demo_bronze starting partition_date=%s", partition_date)

        # -----------------------------------------------------------------
        # Generate synthetic retail orders using spark.range — no external
        # data source required, fully deterministic for a given date.
        # -----------------------------------------------------------------
        df = (
            self.spark.range(1000)  # id: 0..999

            # Identifiers
            .withColumn(
                "order_id",
                F.concat(F.lit("ORD-"), F.lpad(F.col("id").cast("string"), 8, "0")),
            )
            .withColumn(
                "customer_id",
                F.concat(F.lit("CUST-"), (F.col("id") % 200 + 1).cast("string")),
            )
            .withColumn(
                "product_id",
                F.concat(F.lit("PROD-"), (F.col("id") % 50 + 1).cast("string")),
            )

            # Category — cycles across 5 values
            .withColumn(
                "product_category",
                F.element_at(
                    F.array(*[F.lit(c) for c in ["Electronics", "Clothing", "Food", "Home", "Sports"]]),
                    (F.col("id") % 5 + 1).cast("int"),
                ),
            )

            # Numeric fields
            .withColumn("quantity", (F.col("id") % 10 + 1).cast("int"))
            .withColumn(
                "unit_price",
                F.round((F.col("id") % 500 + 1).cast("double") + F.lit(0.99), 2),
            )

            # Timestamp — spread evenly across the partition date (86 s steps)
            .withColumn(
                "order_timestamp",
                F.from_unixtime(
                    F.unix_timestamp(
                        F.lit(partition_date + " 00:00:00"), "yyyy-MM-dd HH:mm:ss"
                    ) + F.col("id") * 86
                ).cast("timestamp"),
            )

            # Status and region — cycle across 5 values each
            .withColumn(
                "status",
                F.element_at(
                    F.array(*[F.lit(s) for s in ["pending", "confirmed", "shipped", "delivered", "cancelled"]]),
                    (F.col("id") % 5 + 1).cast("int"),
                ),
            )
            .withColumn(
                "region",
                F.element_at(
                    F.array(*[F.lit(r) for r in ["North", "South", "East", "West", "Central"]]),
                    (F.col("id") % 5 + 1).cast("int"),
                ),
            )

            # Partition column
            .withColumn("order_date", F.lit(partition_date))

            # Audit columns
            .withColumn("_source", F.lit("synthetic-generator"))
            .withColumn("_ingested_at", F.current_timestamp())

            # Drop the range index — not part of the target schema
            .drop("id")
        )

        # -----------------------------------------------------------------
        # Write to bronze — idempotent replaceWhere on the partition date.
        # saveAsTable registers the table in HMS so Trino and Spark SQL can
        # query it by name without needing the ABFS path.
        # -----------------------------------------------------------------
        (
            df.write
            .format("delta")
            .mode("overwrite")
            .option("replaceWhere", f"order_date = '{partition_date}'")
            .partitionBy("order_date")
            .saveAsTable("lakehouse.bronze.retail_orders")
        )

        row_count: int = df.count()
        self.log.info(
            "forge_demo_bronze complete partition_date=%s rows=%d",
            partition_date,
            row_count,
        )


if __name__ == "__main__":
    ForgeDemoBronze().execute()
