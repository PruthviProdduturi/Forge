"""forge_dq.operators — Airflow operators for post-hoc DQ validation."""

try:
    from forge_dq.operators.dq_operator import DQOperator

    __all__ = ["DQOperator"]
except ImportError:
    # Airflow is not installed — operators are optional.
    __all__ = []
