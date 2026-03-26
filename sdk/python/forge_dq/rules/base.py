"""
forge_dq.rules.base — Abstract base for all DQ rules.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pyspark.sql import DataFrame, SparkSession


class Severity(str, Enum):
    """Rule severity levels.

    CRITICAL — failures block the pipeline when fail_on_critical=True.
    WARNING  — failures are recorded but never block the pipeline.
    INFO     — informational checks; never block the pipeline.
    """

    CRITICAL = "critical"
    WARNING = "warning"
    INFO = "info"


@dataclass
class RuleResult:
    """The outcome of evaluating a single DQ rule against a DataFrame."""

    rule_name: str
    rule_type: str
    severity: Severity
    status: str  # PASS | FAIL | WARN | SKIPPED
    message: str
    actual_value: str | None = None
    expected_value: str | None = None
    affected_rows: int = 0


class BaseRule(ABC):
    """Abstract base class for all Forge DQ rules.

    Subclasses must implement :meth:`evaluate`.
    """

    def __init__(self, name: str, severity: Severity | str = Severity.CRITICAL) -> None:
        self.name = name
        self.severity = Severity(severity) if isinstance(severity, str) else severity

    @abstractmethod
    def evaluate(self, df: "DataFrame", spark: "SparkSession") -> RuleResult:
        """Evaluate the rule against *df* and return a :class:`RuleResult`."""
        ...
