"""
Example Forge job: CRM Orders Bronze → Silver

This file shows the complete pattern for writing a Forge pipeline job.
Copy this file as a starting point for new jobs and adapt as needed.

Pipeline summary:
    Source:   bronze/crm/orders/           (Delta, appended daily)
    Output:   silver/crm/orders_cleaned/   (Delta, overwritten each run)
    Schedule: Daily at 06:00 UTC
    Owner:    data-engineering

Deploy:
    1. Copy to compute/spark/jobs/crm_orders_silver.py
    2. Add to the Airflow DAG via SparkKubernetesOperator
       (see orchestration/airflow/dags/crm_orders_silver_dag.py)

DQ rules:
    orchestration/dq/rules/crm_orders_cleaned.yaml

Lineage:
    Emitted automatically to Microsoft Purview via the OpenLineage listener
    configured in forge_session().  No extra code required.
"""
from __future__ import annotations

from pyspark.sql import functions as F

from forge_sdk import ForgeJob

# forge_dq is a separate package installed alongside forge_sdk in the Spark
# image.  The @track decorator is optional — remove it if forge_dq is not
# available in your environment.
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


class CrmOrdersSilver(ForgeJob):
    """
    Reads raw CRM orders from the bronze layer, applies cleaning transforms,
    and writes the result to the silver layer.

    Transforms applied:
    - Deduplicate on ``order_id``
    - Drop rows with NULL in ``order_id``, ``customer_id``, or ``amount``
    - Cast ``amount`` to ``double``
    - Parse ``order_date_str`` → ``order_date`` (``yyyy-MM-dd``)
    - Add ``_ingested_at`` audit column
    - Drop the raw ``order_date_str`` column
    """

    @track(
        dataset="silver/crm/orders_cleaned",
        rules="orchestration/dq/rules/crm_orders_cleaned.yaml",
    )
    def run(self) -> None:
        # -----------------------------------------------------------------
        # Read raw orders from bronze
        # -----------------------------------------------------------------
        df = (
            self.spark.read
            .format("delta")
            .load(self.bronze("crm/orders"))
        )

        # -----------------------------------------------------------------
        # Clean and transform
        # -----------------------------------------------------------------
        cleaned = (
            df
            .dropDuplicates(["order_id"])
            .dropna(subset=["order_id", "customer_id", "amount"])
            .withColumn("amount", F.col("amount").cast("double"))
            .withColumn(
                "order_date",
                F.to_date(F.col("order_date_str"), "yyyy-MM-dd"),
            )
            .withColumn("_ingested_at", F.current_timestamp())
            .drop("order_date_str")
        )

        # -----------------------------------------------------------------
        # Write to silver — full overwrite each run (idempotent)
        # -----------------------------------------------------------------
        (
            cleaned.write
            .format("delta")
            .mode("overwrite")
            .option("overwriteSchema", "true")
            .save(self.silver("crm/orders_cleaned"))
        )

        row_count: int = cleaned.count()
        self.log.info("crm_orders_silver complete rows=%d", row_count)


if __name__ == "__main__":
    CrmOrdersSilver().execute()
