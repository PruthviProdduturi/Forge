"""
forge-sdk: Forge Platform SDK for data engineers

Provides a SparkSession factory, ADLS Gen2 path helpers, a base job class,
and platform configuration — pre-wired for ADLS Gen2 workload identity,
Delta Lake 4.x, and OpenLineage/Purview lineage.

Quick start::

    from forge_sdk import ForgeJob, forge_session, bronze, silver, gold

    class OrdersIngest(ForgeJob):
        def run(self) -> None:
            df = self.spark.read.format("csv").load(self.bronze("crm/raw/orders"))
            df.write.format("delta").mode("append").save(self.silver("orders_cleaned"))

    if __name__ == "__main__":
        OrdersIngest().execute()

Public API:
    forge_session  — SparkSession factory (Delta + ADLS + OpenLineage) for batch jobs
    forge_connect  — Spark Connect session for VS Code / notebook interactive dev
    bronze         — Path helper: abfss://bronze@…
    silver         — Path helper: abfss://silver@…
    gold           — Path helper: abfss://gold@…
    sandbox        — Path helper: abfss://sandbox@… (dev only)
    checkpoint     — Path helper: abfss://code@…/checkpoints/ (no separate container)
    ForgeJob       — Abstract base class for pipeline jobs
    PlatformConfig — Environment-driven platform configuration dataclass
"""
from forge_sdk.config.platform import PlatformConfig
from forge_sdk.job.base import ForgeJob
from forge_sdk.spark.connect import forge_connect
from forge_sdk.spark.session import forge_session
from forge_sdk.storage.paths import bronze, checkpoint, gold, sandbox, silver

__version__ = "1.0.0"

__all__ = [
    "forge_session",
    "forge_connect",
    "bronze",
    "silver",
    "gold",
    "sandbox",
    "checkpoint",
    "ForgeJob",
    "PlatformConfig",
]
