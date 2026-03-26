"""
forge_dq.lineage.facets — OpenLineage custom facet for Forge DQ results.

The facet is attached to the OpenLineage run event emitted by the
openlineage-spark integration so that Purview / Marquez receives DQ
metadata alongside lineage for every dataset write.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from forge_dq.rules.base import Severity

if TYPE_CHECKING:
    from forge_dq.rules.base import RuleResult

_PRODUCER_URL = "https://github.com/your-org/DSEngCoreInfra"
_SCHEMA_URL = "https://openlineage.io/spec/facets/1-0-0/forge_dq.json"


def build_dq_facet(results: list["RuleResult"], profile: dict) -> dict:
    """Build an OpenLineage-compatible custom facet dict for DQ results.

    The returned dict should be merged into the ``run.facets`` or
    ``outputs[].facets`` of an OpenLineage ``RunEvent``.

    Args:
        results: List of :class:`~forge_dq.rules.base.RuleResult` objects.
        profile: Profile dict returned by :class:`~forge_dq.profiler.AutoProfiler`.

    Returns:
        A dict with a single key ``"forge_dq"`` whose value is the facet payload.
    """
    rules_passed = sum(1 for r in results if r.status == "PASS")
    rules_failed = sum(1 for r in results if r.status == "FAIL")
    rules_warned = sum(1 for r in results if r.status == "WARN")

    critical_failures = [
        r.rule_name
        for r in results
        if r.status == "FAIL" and r.severity == Severity.CRITICAL
    ]

    overall_status = (
        "FAIL"
        if any(r.status == "FAIL" and r.severity == Severity.CRITICAL for r in results)
        else "PASS"
    )

    return {
        "forge_dq": {
            "_producer": _PRODUCER_URL,
            "_schemaURL": _SCHEMA_URL,
            "rows_written": profile.get("rows_written", 0),
            "rules_total": len(results),
            "rules_passed": rules_passed,
            "rules_failed": rules_failed,
            "rules_warned": rules_warned,
            "critical_failures": critical_failures,
            "overall_status": overall_status,
        }
    }
