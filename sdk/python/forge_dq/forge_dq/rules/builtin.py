"""
forge_dq.rules.builtin — Built-in DQ rule implementations.

All rules extend :class:`~forge_dq.rules.base.BaseRule` and accept
keyword arguments that match the YAML schema defined in the rules loader.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from forge_dq.rules.base import BaseRule, RuleResult, Severity

if TYPE_CHECKING:
    from pyspark.sql import DataFrame, SparkSession

logger = logging.getLogger(__name__)


class NotNullRule(BaseRule):
    """Asserts that no NULL values exist in the specified column(s).

    Accepts either ``column`` (single string) or ``columns`` (list of strings)
    so that YAML authors can use whichever form feels natural.

    Args:
        name: Rule identifier.
        column: Single column name to check (mutually exclusive with *columns*).
        columns: List of column names to check (mutually exclusive with *column*).
        severity: Rule severity (default CRITICAL).
    """

    def __init__(
        self,
        name: str,
        column: str | None = None,
        columns: list[str] | None = None,
        severity: Severity | str = Severity.CRITICAL,
    ) -> None:
        super().__init__(name, severity)
        if column is not None:
            self.columns = [column]
        elif columns is not None:
            self.columns = list(columns)
        else:
            raise ValueError(f"Rule '{name}': must specify 'column' or 'columns'.")

    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        from pyspark.sql import functions as F

        null_exprs = [F.sum(F.col(c).isNull().cast("long")).alias(c) for c in self.columns]
        row = df.agg(*null_exprs).collect()[0]
        total_nulls: int = sum(row[c] for c in self.columns)

        if total_nulls == 0:
            return RuleResult(
                rule_name=self.name,
                rule_type="not_null",
                severity=self.severity,
                status="PASS",
                message=f"No nulls found in columns: {self.columns}",
                actual_value="0",
                expected_value="0",
                affected_rows=0,
            )

        per_col = {c: row[c] for c in self.columns if row[c] > 0}
        return RuleResult(
            rule_name=self.name,
            rule_type="not_null",
            severity=self.severity,
            status="FAIL",
            message=f"Found {total_nulls} null(s) across columns {self.columns}. Per-column: {per_col}",
            actual_value=str(total_nulls),
            expected_value="0",
            affected_rows=total_nulls,
        )


class ValueRangeRule(BaseRule):
    """Asserts that numeric column values fall within [min, max].

    Args:
        name: Rule identifier.
        column: Column to check.
        min: Inclusive lower bound (optional).
        max: Inclusive upper bound (optional).
        severity: Rule severity (default CRITICAL).
    """

    def __init__(
        self,
        name: str,
        column: str,
        min: Any = None,
        max: Any = None,
        severity: Severity | str = Severity.CRITICAL,
    ) -> None:
        super().__init__(name, severity)
        self.column = column
        self.min = min
        self.max = max

    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        from pyspark.sql import functions as F

        col = F.col(self.column)
        conditions = []
        if self.min is not None:
            conditions.append(col < self.min)
        if self.max is not None:
            conditions.append(col > self.max)

        if not conditions:
            return RuleResult(
                rule_name=self.name,
                rule_type="value_range",
                severity=self.severity,
                status="PASS",
                message="No range bounds specified — trivially passes.",
                affected_rows=0,
            )

        out_of_range_expr = conditions[0]
        for c in conditions[1:]:
            out_of_range_expr = out_of_range_expr | c

        count = df.filter(out_of_range_expr).count()
        bounds = []
        if self.min is not None:
            bounds.append(f">={self.min}")
        if self.max is not None:
            bounds.append(f"<={self.max}")
        expected_desc = " and ".join(bounds)

        if count == 0:
            return RuleResult(
                rule_name=self.name,
                rule_type="value_range",
                severity=self.severity,
                status="PASS",
                message=f"All values in '{self.column}' are within range [{self.min}, {self.max}].",
                actual_value="0 out-of-range",
                expected_value=expected_desc,
                affected_rows=0,
            )

        return RuleResult(
            rule_name=self.name,
            rule_type="value_range",
            severity=self.severity,
            status="FAIL",
            message=f"{count} value(s) in '{self.column}' are outside range [{self.min}, {self.max}].",
            actual_value=f"{count} out-of-range",
            expected_value=expected_desc,
            affected_rows=count,
        )


class AcceptedValuesRule(BaseRule):
    """Asserts that all values in a column belong to an allowed set.

    Args:
        name: Rule identifier.
        column: Column to check.
        values: Allowed value list.
        severity: Rule severity (default CRITICAL).
    """

    def __init__(
        self,
        name: str,
        column: str,
        values: list[Any],
        severity: Severity | str = Severity.CRITICAL,
    ) -> None:
        super().__init__(name, severity)
        self.column = column
        self.values = values

    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        count = df.filter(~df[self.column].isin(self.values)).count()

        if count == 0:
            return RuleResult(
                rule_name=self.name,
                rule_type="accepted_values",
                severity=self.severity,
                status="PASS",
                message=f"All values in '{self.column}' are within accepted set.",
                actual_value="0 invalid",
                expected_value=str(self.values),
                affected_rows=0,
            )

        return RuleResult(
            rule_name=self.name,
            rule_type="accepted_values",
            severity=self.severity,
            status="FAIL",
            message=f"{count} row(s) in '{self.column}' contain values not in {self.values}.",
            actual_value=f"{count} invalid",
            expected_value=str(self.values),
            affected_rows=count,
        )


class RowCountRule(BaseRule):
    """Asserts that the DataFrame row count is within [min, max].

    Use this for absolute row count checks (e.g. at least 1 row).
    For percentage-drop checks relative to prior runs, use :class:`RowCountDeltaRule`.

    Args:
        name: Rule identifier.
        min: Minimum acceptable row count (inclusive, optional).
        max: Maximum acceptable row count (inclusive, optional).
        severity: Rule severity (default CRITICAL).
    """

    def __init__(
        self,
        name: str,
        min: int | None = None,
        max: int | None = None,
        severity: Severity | str = Severity.CRITICAL,
    ) -> None:
        super().__init__(name, severity)
        self.min = min
        self.max = max

    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        count = df.count()
        violations = []
        if self.min is not None and count < self.min:
            violations.append(f"count {count} < min {self.min}")
        if self.max is not None and count > self.max:
            violations.append(f"count {count} > max {self.max}")

        if not violations:
            return RuleResult(
                rule_name=self.name,
                rule_type="row_count",
                severity=self.severity,
                status="PASS",
                message=f"Row count {count} is within bounds [min={self.min}, max={self.max}].",
                actual_value=str(count),
                expected_value=f"[{self.min}, {self.max}]",
                affected_rows=0,
            )

        return RuleResult(
            rule_name=self.name,
            rule_type="row_count",
            severity=self.severity,
            status="FAIL",
            message=f"Row count violation: {'; '.join(violations)}.",
            actual_value=str(count),
            expected_value=f"[{self.min}, {self.max}]",
            affected_rows=count,
        )


class RowCountDeltaRule(BaseRule):
    """Asserts that the current row count has not dropped more than *max_drop_pct*
    compared with the rolling average of recent runs.

    If no prior history exists (first run), the rule always passes.

    Args:
        name: Rule identifier.
        max_drop_pct: Maximum allowed percentage drop (0–100).
        lookback_runs: Number of recent runs to compare against (default 7).
        severity: Rule severity (default CRITICAL).

    Note:
        Requires ``metrics_path`` to be set on the instance before calling
        :meth:`evaluate`.  The :class:`~forge_dq.runner.DQRunner` sets this
        automatically.
    """

    def __init__(
        self,
        name: str,
        max_drop_pct: float,
        lookback_runs: int = 7,
        severity: Severity | str = Severity.CRITICAL,
    ) -> None:
        super().__init__(name, severity)
        self.max_drop_pct = max_drop_pct
        self.lookback_runs = lookback_runs
        # Set by DQRunner before evaluate() is called.
        self.metrics_path: str | None = None

    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        current_count = df.count()

        if not self.metrics_path:
            logger.warning(
                "RowCountDeltaRule '%s': metrics_path not set — skipping historical comparison.",
                self.name,
            )
            return RuleResult(
                rule_name=self.name,
                rule_type="row_count_delta",
                severity=self.severity,
                status="PASS",
                message="No metrics_path configured — skipping historical comparison.",
                actual_value=str(current_count),
                affected_rows=0,
            )

        try:
            history_df = (
                spark.read.format("delta")
                .load(self.metrics_path)
                .orderBy("run_timestamp", ascending=False)
                .limit(self.lookback_runs)
                .select("rows_written")
            )
            history_count = history_df.count()
        except Exception as exc:
            logger.warning(
                "RowCountDeltaRule '%s': could not read prior metrics from '%s': %s. Treating as first run.",
                self.name,
                self.metrics_path,
                exc,
            )
            history_count = 0

        if history_count == 0:
            return RuleResult(
                rule_name=self.name,
                rule_type="row_count_delta",
                severity=self.severity,
                status="PASS",
                message="No prior run history found — first run, always PASS.",
                actual_value=str(current_count),
                affected_rows=0,
            )

        from pyspark.sql import functions as F

        avg_row = history_df.agg(F.avg("rows_written").alias("avg_rows")).collect()[0]
        avg_rows = float(avg_row["avg_rows"])

        if avg_rows == 0:
            return RuleResult(
                rule_name=self.name,
                rule_type="row_count_delta",
                severity=self.severity,
                status="PASS",
                message="Historical average row count is 0 — cannot compute delta.",
                actual_value=str(current_count),
                affected_rows=0,
            )

        drop_pct = max(0.0, (avg_rows - current_count) / avg_rows * 100)

        if drop_pct <= self.max_drop_pct:
            return RuleResult(
                rule_name=self.name,
                rule_type="row_count_delta",
                severity=self.severity,
                status="PASS",
                message=(
                    f"Row count {current_count} (avg {avg_rows:.0f}). "
                    f"Drop {drop_pct:.1f}% <= threshold {self.max_drop_pct}%."
                ),
                actual_value=f"{drop_pct:.1f}%",
                expected_value=f"<={self.max_drop_pct}%",
                affected_rows=0,
            )

        return RuleResult(
            rule_name=self.name,
            rule_type="row_count_delta",
            severity=self.severity,
            status="FAIL",
            message=(
                f"Row count dropped {drop_pct:.1f}% (current={current_count}, "
                f"avg={avg_rows:.0f}) which exceeds threshold {self.max_drop_pct}%."
            ),
            actual_value=f"{drop_pct:.1f}%",
            expected_value=f"<={self.max_drop_pct}%",
            affected_rows=max(0, int(avg_rows - current_count)),
        )


class UniqueKeyRule(BaseRule):
    """Asserts that the combination of *columns* forms a unique key (no duplicates).

    Args:
        name: Rule identifier.
        columns: Key column(s) that must be unique together.
        severity: Rule severity (default CRITICAL).
    """

    def __init__(
        self,
        name: str,
        columns: list[str],
        severity: Severity | str = Severity.CRITICAL,
    ) -> None:
        super().__init__(name, severity)
        self.columns = columns

    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        from pyspark.sql import functions as F

        total = df.count()
        distinct = df.select(*self.columns).distinct().count()
        duplicates = total - distinct

        if duplicates == 0:
            return RuleResult(
                rule_name=self.name,
                rule_type="unique_key",
                severity=self.severity,
                status="PASS",
                message=f"No duplicate key values found for columns {self.columns}.",
                actual_value="0 duplicates",
                expected_value="0 duplicates",
                affected_rows=0,
            )

        return RuleResult(
            rule_name=self.name,
            rule_type="unique_key",
            severity=self.severity,
            status="FAIL",
            message=(
                f"{duplicates} duplicate key value(s) found for columns {self.columns}. "
                f"({total} rows, {distinct} distinct keys)"
            ),
            actual_value=f"{duplicates} duplicates",
            expected_value="0 duplicates",
            affected_rows=duplicates,
        )


class CustomSQLRule(BaseRule):
    """Runs an arbitrary SQL query and asserts the scalar result equals *expected*.

    The SQL string may contain ``{table}`` which is replaced with a temp view
    name before execution.

    Args:
        name: Rule identifier.
        sql: SQL query returning a single scalar integer value.
        expected: Expected integer result.
        severity: Rule severity (default WARNING).
    """

    def __init__(
        self,
        name: str,
        sql: str,
        expected: int,
        severity: Severity | str = Severity.WARNING,
    ) -> None:
        super().__init__(name, severity)
        self.sql = sql
        self.expected = expected

    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        import uuid

        view_name = f"_forge_dq_custom_{uuid.uuid4().hex[:8]}"
        df.createOrReplaceTempView(view_name)

        try:
            rendered_sql = self.sql.replace("{table}", view_name)
            result_row = spark.sql(rendered_sql).collect()

            if not result_row:
                actual = None
            else:
                # Take the first column of the first row as the scalar result
                actual = result_row[0][0]

            actual_int = int(actual) if actual is not None else None

            if actual_int == self.expected:
                return RuleResult(
                    rule_name=self.name,
                    rule_type="custom_sql",
                    severity=self.severity,
                    status="PASS",
                    message=f"Custom SQL returned {actual_int}, matching expected {self.expected}.",
                    actual_value=str(actual_int),
                    expected_value=str(self.expected),
                    affected_rows=0,
                )

            return RuleResult(
                rule_name=self.name,
                rule_type="custom_sql",
                severity=self.severity,
                status="FAIL" if self.severity == Severity.CRITICAL else "WARN",
                message=(
                    f"Custom SQL returned {actual_int}, expected {self.expected}. "
                    f"SQL: {rendered_sql}"
                ),
                actual_value=str(actual_int),
                expected_value=str(self.expected),
                affected_rows=abs(actual_int - self.expected) if actual_int is not None else 0,
            )
        finally:
            spark.catalog.dropTempView(view_name)
