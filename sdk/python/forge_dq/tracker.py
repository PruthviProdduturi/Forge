"""
forge_dq.tracker — @track decorator and ForgeTracker class for pipeline-native DQ.

Usage (decorator):
    from forge_dq import track

    @track(dataset="silver/orders_cleaned",
           rules="orchestration/dq/rules/orders_cleaned.yaml")
    def transform(spark: SparkSession) -> DataFrame:
        return result_df

Usage (imperative / ForgeTracker):
    from forge_dq import ForgeTracker

    tracker = ForgeTracker(spark, "silver/orders_cleaned",
                           rules_path="orchestration/dq/rules/orders_cleaned.yaml")
    report = tracker.run(result_df)
"""
from __future__ import annotations

import functools
import logging
import os
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from pyspark.sql import DataFrame, SparkSession
    from forge_dq.runner import DQRunReport

logger = logging.getLogger(__name__)


def track(
    dataset: str,
    rules: str | None = None,
    pipeline_name: str | None = None,
) -> Callable:
    """Decorator factory for Spark transform functions that return a DataFrame.

    Automatically profiles the output DataFrame, runs DQ rules, and writes
    metrics to the corresponding Delta tables on ADLS.

    Args:
        dataset: Dataset path relative to the layer
                 (e.g. ``"silver/orders_cleaned"``).
        rules: Path to the YAML rules file (repo-relative or absolute).
               If the path is relative it is resolved against the current
               working directory at decoration time (safe for local dev)
               and then at call time (safe for container environments).
        pipeline_name: Human-readable name for the pipeline.  Defaults to
                       the decorated function's ``__name__``.

    Returns:
        A decorator that wraps the transform function.

    Raises:
        :class:`~forge_dq.runner.DQCriticalFailureError`: If a CRITICAL rule
        fails and ``FORGE_DQ_FAIL_ON_CRITICAL=true`` (the default).

    Example::

        @track(dataset="silver/orders_cleaned",
               rules="orchestration/dq/rules/orders_cleaned.yaml")
        def transform(spark: SparkSession) -> DataFrame:
            return spark.table("bronze.orders").filter("amount > 0")
    """

    def decorator(fn: Callable) -> Callable:
        _pipeline_name = pipeline_name or fn.__name__

        @functools.wraps(fn)
        def wrapper(*args, **kwargs) -> "DataFrame":
            # Execute the underlying transform
            result_df: "DataFrame" = fn(*args, **kwargs)

            # Resolve SparkSession — first positional arg or from active session
            spark = _resolve_spark(args, kwargs, result_df)
            if spark is None:
                logger.warning(
                    "@track: could not resolve SparkSession for '%s' — DQ skipped.",
                    dataset,
                )
                return result_df

            # Resolve rules path
            resolved_rules = _resolve_path(rules)

            # Run DQ (errors are caught inside DQRunner; critical failures re-raise)
            from forge_dq.runner import DQRunner

            runner = DQRunner(
                spark=spark,
                dataset=dataset,
                rules_path=resolved_rules,
                pipeline_name=_pipeline_name,
            )
            try:
                runner.run(result_df)
            except Exception:
                # DQCriticalFailureError and infrastructure errors bubble up
                raise

            return result_df

        return wrapper

    return decorator


def _resolve_spark(args: tuple, kwargs: dict, df: "DataFrame") -> "SparkSession | None":
    """Try to find a SparkSession from args, kwargs, or the DataFrame itself."""
    from pyspark.sql import SparkSession, DataFrame as DF

    # Check positional args
    for arg in args:
        if isinstance(arg, SparkSession):
            return arg

    # Check keyword args
    for v in kwargs.values():
        if isinstance(v, SparkSession):
            return v

    # Fall back to the DataFrame's SparkSession
    try:
        return df.sparkSession
    except AttributeError:
        pass

    # Last resort: active SparkSession
    try:
        return SparkSession.getActiveSession()
    except Exception:
        return None


def _resolve_path(path: str | None) -> str | None:
    """Resolve a rules file path.  Returns None if path is None."""
    if path is None:
        return None
    if os.path.isabs(path):
        return path
    # Try relative to cwd
    candidate = os.path.join(os.getcwd(), path)
    if os.path.exists(candidate):
        return candidate
    return path  # return as-is; DQRunner will raise FileNotFoundError if missing


# ---------------------------------------------------------------------------
# ForgeTracker — imperative API
# ---------------------------------------------------------------------------


class ForgeTracker:
    """Imperative DQ tracking — use when the ``@track`` decorator is not suitable.

    Args:
        spark: Active SparkSession.
        dataset: Dataset path relative to the layer.
        rules_path: Optional path to YAML rules file.
        pipeline_name: Human-readable pipeline name.

    Example::

        tracker = ForgeTracker(spark, "silver/orders_cleaned",
                               rules_path="orchestration/dq/rules/orders_cleaned.yaml")
        report = tracker.run(result_df)
        print(report.overall_status)
    """

    def __init__(
        self,
        spark: "SparkSession",
        dataset: str,
        rules_path: str | None = None,
        pipeline_name: str = "unknown",
    ) -> None:
        self.spark = spark
        self.dataset = dataset
        self.rules_path = rules_path
        self.pipeline_name = pipeline_name

    def run(self, df: "DataFrame") -> "DQRunReport":
        """Run DQ checks on *df* and return a :class:`~forge_dq.runner.DQRunReport`."""
        from forge_dq.runner import DQRunner

        runner = DQRunner(
            spark=self.spark,
            dataset=self.dataset,
            rules_path=self.rules_path,
            pipeline_name=self.pipeline_name,
        )
        return runner.run(df)
