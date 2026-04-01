"""
Forge Demo Gold Job: retail orders silver → gold aggregations

Reads the silver ``retail/orders_cleaned`` Delta table for the given date
partition and produces one of three gold tables depending on the ``GOLD_TABLE``
environment variable:

  daily_sales         — lakehouse.gold.retail_daily_sales
  product_performance — lakehouse.gold.retail_product_performance
  regional_metrics    — lakehouse.gold.retail_regional_metrics

Environment variables (injected by SparkApplication env / configmap):
  PARTITION_DATE        — ISO date string (``YYYY-MM-DD``)
  GOLD_TABLE            — one of: daily_sales, product_performance, regional_metrics
  FORGE_ENV             — platform environment (dev / staging / prod)
  FORGE_STORAGE_ACCOUNT — ADLS Gen2 storage account name

Deploy:
    Copy to compute/spark/jobs/forge_demo_gold.py and reference it via the
    forge_demo_gold_dag SparkKubernetesOperator manifest.

DQ rules:
    orchestration/dq/rules/forge_demo_gold.yaml

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


_RULES_PATH = "orchestration/dq/rules/forge_demo_gold.yaml"


class ForgeDemoGold(ForgeJob):
    """
    Reads a date partition of the silver retail orders table and writes one
    gold aggregation table, selected by the ``GOLD_TABLE`` environment variable.

    Dispatch:
        GOLD_TABLE=daily_sales         → :meth:`_daily_sales`
        GOLD_TABLE=product_performance → :meth:`_product_performance`
        GOLD_TABLE=regional_metrics    → :meth:`_regional_metrics`
    """

    def run(self) -> None:
        """Read env vars and dispatch to the correct gold aggregation method."""
        gold_table = os.environ["GOLD_TABLE"]
        partition_date = os.environ["PARTITION_DATE"]

        dispatch = {
            "daily_sales": self._daily_sales,
            "product_performance": self._product_performance,
            "regional_metrics": self._regional_metrics,
        }

        if gold_table not in dispatch:
            raise ValueError(
                f"Unknown GOLD_TABLE={gold_table!r}. "
                f"Expected one of: {sorted(dispatch)}"
            )

        self.log.info(
            "ForgeDemoGold starting gold_table=%s partition_date=%s",
            gold_table,
            partition_date,
        )
        dispatch[gold_table](partition_date)

    # ------------------------------------------------------------------
    # Private aggregation methods
    # ------------------------------------------------------------------

    @track(
        dataset="gold/retail/daily_sales",
        rules=_RULES_PATH,
    )
    def _daily_sales(self, partition_date: str) -> None:
        """
        Aggregate per order_date KPIs: order volume, revenue, avg order value,
        units sold, cancelled order count and cancellation rate.

        Output: lakehouse.gold.retail_daily_sales
        """
        silver_df = (
            self.spark.read
            .format("delta")
            .load(self.silver("retail/orders_cleaned"))
            .filter(F.col("order_date") == partition_date)
        )

        cancelled = F.when(F.col("status") == "cancelled", 1).otherwise(0)

        agg_df = (
            silver_df
            .groupBy("order_date")
            .agg(
                F.count("*").alias("total_orders"),
                F.sum("total_amount").alias("total_revenue"),
                F.avg("total_amount").alias("avg_order_value"),
                F.sum("quantity").alias("total_units_sold"),
                F.sum(cancelled).alias("cancelled_orders"),
            )
            .withColumn(
                "cancellation_rate",
                F.col("cancelled_orders") / F.col("total_orders"),
            )
        )

        (
            agg_df.write
            .format("delta")
            .mode("overwrite")
            .option("replaceWhere", f"order_date = '{partition_date}'")
            .saveAsTable("lakehouse.gold.retail_daily_sales")
        )

        self.log.info(
            "_daily_sales complete partition_date=%s rows=%d",
            partition_date,
            agg_df.count(),
        )

    @track(
        dataset="gold/retail/product_performance",
        rules=_RULES_PATH,
    )
    def _product_performance(self, partition_date: str) -> None:
        """
        Aggregate per product_id × product_category revenue, units sold,
        order count and avg unit price for the given date partition.

        Output: lakehouse.gold.retail_product_performance
        """
        silver_df = (
            self.spark.read
            .format("delta")
            .load(self.silver("retail/orders_cleaned"))
            .filter(F.col("order_date") == partition_date)
        )

        agg_df = (
            silver_df
            .groupBy("order_date", "product_id", "product_category")
            .agg(
                F.sum("total_amount").alias("total_revenue"),
                F.sum("quantity").alias("units_sold"),
                F.count("*").alias("order_count"),
                F.avg("unit_price").alias("avg_unit_price"),
            )
        )

        (
            agg_df.write
            .format("delta")
            .mode("overwrite")
            .option("replaceWhere", f"order_date = '{partition_date}'")
            .saveAsTable("lakehouse.gold.retail_product_performance")
        )

        self.log.info(
            "_product_performance complete partition_date=%s rows=%d",
            partition_date,
            agg_df.count(),
        )

    @track(
        dataset="gold/retail/regional_metrics",
        rules=_RULES_PATH,
    )
    def _regional_metrics(self, partition_date: str) -> None:
        """
        Aggregate per region × status order count, revenue and avg order value
        for the given date partition.

        Output: lakehouse.gold.retail_regional_metrics
        """
        silver_df = (
            self.spark.read
            .format("delta")
            .load(self.silver("retail/orders_cleaned"))
            .filter(F.col("order_date") == partition_date)
        )

        agg_df = (
            silver_df
            .groupBy("order_date", "region", "status")
            .agg(
                F.count("*").alias("order_count"),
                F.sum("total_amount").alias("total_revenue"),
                F.avg("total_amount").alias("avg_order_value"),
            )
        )

        (
            agg_df.write
            .format("delta")
            .mode("overwrite")
            .option("replaceWhere", f"order_date = '{partition_date}'")
            .saveAsTable("lakehouse.gold.retail_regional_metrics")
        )

        self.log.info(
            "_regional_metrics complete partition_date=%s rows=%d",
            partition_date,
            agg_df.count(),
        )


if __name__ == "__main__":
    ForgeDemoGold().execute()
