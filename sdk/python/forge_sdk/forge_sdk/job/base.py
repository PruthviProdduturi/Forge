"""
forge_sdk.job.base — Abstract base class for all Forge pipeline jobs.

Every Forge pipeline job extends :class:`ForgeJob` and implements
:meth:`~ForgeJob.run`.  The class provides:

* A managed :class:`~pyspark.sql.SparkSession` (injected by the operator or
  created via :func:`~forge_sdk.spark.session.forge_session` on first access)
* Convenience path helpers that delegate to the medallion layer functions
  in :mod:`forge_sdk.storage.paths`
* A three-phase lifecycle: :meth:`~ForgeJob.setup` → :meth:`~ForgeJob.run`
  → :meth:`~ForgeJob.teardown`, all invoked by :meth:`~ForgeJob.execute`
* Structured logging with the job class name as the logger name

Minimal usage::

    from forge_sdk import ForgeJob

    class MyJob(ForgeJob):
        def run(self) -> None:
            df = self.spark.read.format("delta").load(self.bronze("raw/dataset"))
            df.write.format("delta").mode("append").save(self.silver("dataset"))

    if __name__ == "__main__":
        MyJob().execute()
"""
from __future__ import annotations

import logging
import os
import time
from abc import ABC, abstractmethod

from pyspark.sql import SparkSession


class PartitionNotFound(RuntimeError):
    """
    Raised when the source partition has no data for the scheduled slot.

    The Spark job exits with a non-zero code so Airflow marks the task as
    failed and retries after the configured retry delay.  This is the correct
    behaviour when upstream data has not yet landed — do NOT catch this error
    in job code.
    """

from forge_sdk.config.platform import PlatformConfig
from forge_sdk.storage.paths import (
    bronze,
    checkpoint,
    gold,
    sandbox,
    silver,
)


class ForgeJob(ABC):
    """
    Abstract base class for all Forge pipeline jobs.

    Subclass this, implement :meth:`run`, and call :meth:`execute` from
    ``__main__`` or let the Spark Operator invoke it.

    Args:
        spark:  An existing :class:`~pyspark.sql.SparkSession`.  When
                ``None`` (the default) a session is created lazily via
                :func:`~forge_sdk.spark.session.forge_session` using the
                class name as the application name.
        config: :class:`~forge_sdk.config.platform.PlatformConfig`.
                Defaults to :meth:`~forge_sdk.config.platform.PlatformConfig.from_env`.
    """

    def __init__(
        self,
        spark: SparkSession | None = None,
        config: PlatformConfig | None = None,
    ) -> None:
        self.config: PlatformConfig = config or PlatformConfig.from_env()
        self._spark: SparkSession | None = spark
        self.log: logging.Logger = logging.getLogger(self.__class__.__name__)

    # ------------------------------------------------------------------
    # SparkSession property
    # ------------------------------------------------------------------

    @property
    def spark(self) -> SparkSession:
        """
        The active :class:`~pyspark.sql.SparkSession`.

        If the job was constructed without an explicit session a new one is
        created via :func:`~forge_sdk.spark.session.forge_session` using the
        job class name as the Spark application name.  In a Spark Operator
        deployment the operator creates the session before calling the job
        entrypoint, so ``getOrCreate()`` inside ``forge_session`` returns the
        existing session transparently.
        """
        if self._spark is None:
            from forge_sdk.spark.session import forge_session

            self._spark = forge_session(
                app_name=self.__class__.__name__,
                config=self.config,
            )
        return self._spark

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    @property
    def storage(self) -> str:
        """ADLS Gen2 account FQDN: ``<account>.dfs.core.windows.net``."""
        return f"{self.config.adls_account}.dfs.core.windows.net"

    def bronze(self, path: str = "") -> str:
        """Return an ABFS URI in the ``bronze`` container."""
        return bronze(path, self.config)

    def silver(self, path: str = "") -> str:
        """Return an ABFS URI in the ``silver`` container."""
        return silver(path, self.config)

    def gold(self, path: str = "") -> str:
        """Return an ABFS URI in the ``gold`` container."""
        return gold(path, self.config)

    def sandbox(self, path: str = "") -> str:
        """Return an ABFS URI in the ``sandbox`` container (dev only)."""
        return sandbox(path, self.config)

    def checkpoint(self, path: str = "") -> str:
        """Return an ABFS URI in the ``checkpoints`` container."""
        return checkpoint(path, self.config)

    # ------------------------------------------------------------------
    # Lifecycle hooks
    # ------------------------------------------------------------------

    def assert_not_empty(self, df, source_desc: str = "source") -> None:
        """
        Assert that the source DataFrame is not empty for this partition.

        Call this immediately after reading the source — before any transformation
        or write.  If the DataFrame has no rows, raises :exc:`PartitionNotFound`
        so Airflow fails the task and retries, waiting for upstream data to land.

        Args:
            df:          The source :class:`~pyspark.sql.DataFrame`.
            source_desc: Human-readable description for the log message (e.g. path or table name).

        Raises:
            PartitionNotFound: When the DataFrame is empty.

        Example::

            df = self.spark.read.format("parquet").load(source_path)
            self.assert_not_empty(df, source_desc=source_path)
        """
        partition_date = os.environ.get("PARTITION_DATE", "unknown")
        if df.rdd.isEmpty():
            msg = (
                f"PartitionNotFound: no data in '{source_desc}' for partition {partition_date}. "
                f"Upstream data not yet available — Airflow will retry."
            )
            self.log.error(msg)
            raise PartitionNotFound(msg)
        self.log.info("assert_not_empty OK source=%s partition=%s", source_desc, partition_date)

    def setup(self) -> None:
        """
        Pre-run setup hook.

        Override to: create Delta tables if they do not exist, validate
        upstream inputs, acquire locks, etc.  Called before :meth:`run`.
        The default implementation is a no-op.
        """

    @abstractmethod
    def run(self) -> None:
        """
        Core job logic.

        Implement all Spark transformations and writes here.  This method
        is required — the class cannot be instantiated without it.
        """

    def teardown(self) -> None:
        """
        Post-run cleanup hook.

        Override to: remove temp views, clean up staging paths, send
        notifications, etc.  Called after :meth:`run` regardless of whether
        it raised an exception.  The default implementation is a no-op.
        """

    # ------------------------------------------------------------------
    # Entrypoint
    # ------------------------------------------------------------------

    def execute(self) -> None:
        """
        Run the full job lifecycle: :meth:`setup` → :meth:`run` → :meth:`teardown`.

        This is the method called by the Spark Operator pod entrypoint.
        It handles timing, structured log emission, and exception propagation.

        Raises:
            Exception: Any exception raised inside :meth:`run` is re-raised
                       after logging so that the Spark Operator marks the
                       ``SparkApplication`` as failed.
        """
        job_name = self.__class__.__name__
        start = time.monotonic()
        self.log.info("Starting %s env=%s", job_name, self.config.env)
        try:
            self.setup()
            self.run()
            self.teardown()
            elapsed = round(time.monotonic() - start, 2)
            self.log.info("Completed %s elapsed_s=%s", job_name, elapsed)
        except Exception as exc:
            elapsed = round(time.monotonic() - start, 2)
            self.log.error(
                "Failed %s elapsed_s=%s error=%s",
                job_name,
                elapsed,
                str(exc),
            )
            raise
