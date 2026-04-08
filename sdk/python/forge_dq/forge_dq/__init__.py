"""
forge-dq: Forge Data Quality framework

Automatic profiling, rule-based pipeline gates, and SPC anomaly detection
for every dataset written in the Forge medallion lakehouse.

Quick start:
    from forge_dq import track

    @track(dataset="silver/orders_cleaned", rules="orchestration/dq/rules/orders_cleaned.yaml")
    def transform(spark: SparkSession) -> DataFrame:
        return result_df
"""

from forge_dq.tracker import track, ForgeTracker
from forge_dq.runner import DQRunner, DQRunReport, DQCriticalFailureError
from forge_dq.rules.base import Severity, RuleResult

__version__ = "0.1.0"
__all__ = [
    "track",
    "ForgeTracker",
    "DQRunner",
    "DQRunReport",
    "DQCriticalFailureError",
    "Severity",
    "RuleResult",
]
