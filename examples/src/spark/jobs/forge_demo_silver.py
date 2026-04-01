"""
Forge Demo: Retail Orders Bronze → Silver

This job cleans and deduplciates the retail orders bronze partition for a given
date and writes the result to the silver layer, registering it in HMS.

Pipeline summary:
    Source:   bronze/retail/orders/              (Delta, partitioned by order_date)
    Output:   silver/retail/orders_cleaned/      (Delta, partition-overwrite per run)
    HMS:      lakehouse.silver.retail_orders_cleaned
    Schedule: Triggered by forge_demo_bronze (no independent schedule)
    Owner:    data-engineering

Transforms applied:
    1. Read the bronze partition for PARTITION_DATE
    2. dropDuplicates on order_id
    3. dropna on order_id, customer_id, unit_price, quantity
    4. Filter quantity > 0 AND unit_price > 0
    5. Add total_amount = round(quantity * unit_price, 2)
    6. Add _processed_at audit timestamp
    7. Drop _source staging column

DQ rules:
    orchestration/dq/rules/forge_demo_silver.yaml
    Applied via the @track decorator — job fails fast on critical rule violations.

Lineage:
    Emitted automatically to Microsoft Purview via the OpenLineage listener
    configured in forge_session().  No extra code required.
"""
from __future__ import annotations

import os

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


class ForgeDemoSilver(ForgeJob):
    """
    Reads retail orders from the bronze layer for a single date partition,
    applies cleaning transforms, and writes the result to the silver layer
    registered in HMS as lakehouse.silver.retail_orders_cleaned.

    Transforms applied:
    - Deduplicate on ``order_id``
    - Drop rows with NULL in ``order_id``, ``customer_id``, ``unit_price``,
      or ``quantity``
    - Filter out rows where ``quantity <= 0`` or ``unit_price <= 0``
    - Add ``total_amount`` = round(quantity * unit_price, 2)
    - Add ``_processed_at`` audit timestamp
    - Drop the ``_source`` staging column
    """

    @track(
        dataset="silver/retail/orders_cleaned",
        rules="orchestration/dq/rules/forge_demo_silver.yaml",
    )
    def run(self) -> None:
        partition_date: str = os.environ["PARTITION_DATE"]

        # -----------------------------------------------------------------
        # Read bronze partition for the given date
        # -----------------------------------------------------------------
        raw = (
            self.spark.read
            .format("delta")
            .load(self.bronze("retail/orders"))
            .filter(F.col("order_date") == partition_date)
        )

        raw_count: int = raw.count()
        self.log.info(
            "forge_demo_silver read partition=%s raw_rows=%d",
            partition_date,
            raw_count,
        )

        # -----------------------------------------------------------------
        # Clean and transform
        # -----------------------------------------------------------------
        cleaned = (
            raw
            .dropDuplicates(["order_id"])
            .dropna(subset=["order_id", "customer_id", "unit_price", "quantity"])
            .filter((F.col("quantity") > 0) & (F.col("unit_price") > 0))
            .withColumn("total_amount", F.round(F.col("quantity") * F.col("unit_price"), 2))
            .withColumn("_processed_at", F.current_timestamp())
            .drop("_source")
        )

        # -----------------------------------------------------------------
        # Write to silver — partition-scoped overwrite (idempotent)
        # -----------------------------------------------------------------
        (
            cleaned.write
            .format("delta")
            .mode("overwrite")
            .option("replaceWhere", f"order_date = '{partition_date}'")
            .partitionBy("order_date")
            .saveAsTable("lakehouse.silver.retail_orders_cleaned")
        )

        clean_count: int = cleaned.count()
        dropped: int = raw_count - clean_count
        self.log.info(
            "forge_demo_silver complete partition=%s clean_rows=%d dropped_rows=%d",
            partition_date,
            clean_count,
            dropped,
        )


if __name__ == "__main__":
    ForgeDemoSilver().execute()
