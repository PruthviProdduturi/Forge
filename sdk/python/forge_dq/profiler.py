"""
forge_dq.profiler — Automatic dataset profiling via a single-pass Spark aggregation.

Computes row count, schema, per-column null rates, distinct counts, and
basic statistics (min, max, mean, stddev for numeric columns).
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pyspark.sql import DataFrame, SparkSession

logger = logging.getLogger(__name__)

# PySpark type strings that are considered numeric for mean/stddev computation.
_NUMERIC_TYPES = {
    "LongType",
    "IntegerType",
    "ShortType",
    "ByteType",
    "DoubleType",
    "FloatType",
    "DecimalType",
}


def _is_numeric(field_type: Any) -> bool:
    """Return True if the given PySpark DataType is numeric."""
    return type(field_type).__name__ in _NUMERIC_TYPES


class AutoProfiler:
    """Computes automatic DQ metrics for a DataFrame in a single aggregation pass."""

    def profile(self, df: "DataFrame", spark: "SparkSession") -> dict:
        """Profile *df* and return a metrics dictionary.

        The aggregation is done in a single Spark action to avoid multiple
        full scans of the data.

        Returns:
            dict with keys:
                ``rows_written``, ``schema_json``, ``columns``
        """
        from pyspark.sql import functions as F

        schema = df.schema
        total_rows: int = df.count()

        if total_rows == 0:
            logger.warning("AutoProfiler: DataFrame is empty — profiling with zero rows.")

        # ------------------------------------------------------------------
        # Build a single-pass aggregation for all columns.
        # For each column compute:
        #   - null_count
        #   - approx distinct count (HyperLogLog)
        #   - min / max
        #   - mean / stddev (numeric only)
        # ------------------------------------------------------------------
        agg_exprs = []
        for field in schema.fields:
            cname = field.name
            col = F.col(f"`{cname}`")

            agg_exprs.append(
                F.sum(col.isNull().cast("long")).alias(f"{cname}__null_count")
            )
            agg_exprs.append(
                F.approx_count_distinct(col).alias(f"{cname}__distinct_count")
            )
            agg_exprs.append(
                F.min(col).cast("string").alias(f"{cname}__min")
            )
            agg_exprs.append(
                F.max(col).cast("string").alias(f"{cname}__max")
            )
            if _is_numeric(field.dataType):
                agg_exprs.append(
                    F.avg(col.cast("double")).alias(f"{cname}__mean")
                )
                agg_exprs.append(
                    F.stddev(col.cast("double")).alias(f"{cname}__stddev")
                )

        if agg_exprs:
            agg_row = df.agg(*agg_exprs).collect()[0]
        else:
            agg_row = {}

        # ------------------------------------------------------------------
        # Assemble per-column profile dicts
        # ------------------------------------------------------------------
        columns: list[dict] = []
        for field in schema.fields:
            cname = field.name
            null_count = int(agg_row[f"{cname}__null_count"] or 0)
            null_rate = (null_count / total_rows) if total_rows > 0 else 0.0
            distinct_count = int(agg_row[f"{cname}__distinct_count"] or 0)
            min_value = agg_row[f"{cname}__min"]
            max_value = agg_row[f"{cname}__max"]

            col_profile: dict = {
                "name": cname,
                "type": str(field.dataType),
                "nullable": field.nullable,
                "null_count": null_count,
                "null_rate": round(null_rate, 6),
                "distinct_count": distinct_count,
                "min_value": str(min_value) if min_value is not None else None,
                "max_value": str(max_value) if max_value is not None else None,
                "mean": None,
                "stddev": None,
            }

            if _is_numeric(field.dataType):
                mean_val = agg_row[f"{cname}__mean"]
                stddev_val = agg_row[f"{cname}__stddev"]
                col_profile["mean"] = float(mean_val) if mean_val is not None else None
                col_profile["stddev"] = float(stddev_val) if stddev_val is not None else None

            columns.append(col_profile)

        return {
            "rows_written": total_rows,
            "schema_json": schema.json(),
            "columns": columns,
        }
