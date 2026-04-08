"""
forge_dq.rules.loader — Load DQ rules from a YAML file.

YAML schema
-----------
version: "1"
dataset: silver/orders_cleaned
description: "..."
owner: "..."
primary_key: [col1, col2]

rules:
  - name: my_rule
    type: not_null          # not_null | value_range | accepted_values |
                            # row_count_delta | unique_key | custom_sql
    # ... type-specific kwargs ...
    severity: critical      # critical | warning | info

anomaly_detection:
  enabled: true
  lookback_days: 30
  z_score_threshold: 3.0
"""
from __future__ import annotations

import logging
from typing import Any

import yaml

from forge_dq.rules.base import BaseRule, Severity
from forge_dq.rules.builtin import (
    AcceptedValuesRule,
    CustomSQLRule,
    NotNullRule,
    RowCountDeltaRule,
    UniqueKeyRule,
    ValueRangeRule,
)

logger = logging.getLogger(__name__)

_RULE_REGISTRY: dict[str, type[BaseRule]] = {
    "not_null": NotNullRule,
    "value_range": ValueRangeRule,
    "accepted_values": AcceptedValuesRule,
    "row_count_delta": RowCountDeltaRule,
    "unique_key": UniqueKeyRule,
    "custom_sql": CustomSQLRule,
}

# Keys consumed at the top level of each rule entry that are NOT passed to
# the rule constructor as kwargs.
_RESERVED_KEYS = {"name", "type"}


def load_rules(yaml_path: str) -> tuple[list[BaseRule], dict[str, Any] | None]:
    """Load DQ rules and anomaly config from a YAML file.

    Args:
        yaml_path: Absolute or relative path to the rules YAML file.

    Returns:
        A tuple of ``(rules, anomaly_config)`` where *anomaly_config* is the
        contents of the ``anomaly_detection:`` YAML section (or ``None``).

    Raises:
        FileNotFoundError: If the YAML file does not exist.
        ValueError: If a rule entry has an unknown ``type``.
    """
    with open(yaml_path, "r", encoding="utf-8") as fh:
        doc: dict[str, Any] = yaml.safe_load(fh) or {}

    raw_rules: list[dict[str, Any]] = doc.get("rules", [])
    rules: list[BaseRule] = []

    for entry in raw_rules:
        entry = dict(entry)  # shallow copy so we can pop safely
        rule_name = entry.pop("name")
        rule_type = entry.pop("type")

        if rule_type not in _RULE_REGISTRY:
            raise ValueError(
                f"Unknown rule type '{rule_type}' in '{yaml_path}'. "
                f"Known types: {sorted(_RULE_REGISTRY)}"
            )

        rule_cls = _RULE_REGISTRY[rule_type]

        # Normalise severity — keep as string; constructor handles conversion
        if "severity" in entry:
            entry["severity"] = entry["severity"].lower()

        try:
            rule_instance = rule_cls(name=rule_name, **entry)
        except TypeError as exc:
            raise ValueError(
                f"Failed to instantiate rule '{rule_name}' (type='{rule_type}'): {exc}"
            ) from exc

        rules.append(rule_instance)
        logger.debug("Loaded rule '%s' (type=%s, severity=%s)", rule_name, rule_type, entry.get("severity"))

    anomaly_config: dict[str, Any] | None = doc.get("anomaly_detection")
    return rules, anomaly_config
