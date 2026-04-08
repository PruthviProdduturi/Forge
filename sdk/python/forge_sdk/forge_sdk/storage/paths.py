"""
forge_sdk.storage.paths — Medallion layer path helpers.

Each function returns a fully qualified ``abfss://`` URI for the given
medallion container. Pass a relative path to target a specific dataset,
or omit it to get the container root.

All functions accept an optional ``config`` argument; when omitted they
call :func:`~forge_sdk.config.platform.PlatformConfig.from_env` once per
call — cheap for the typical job startup pattern.

Example::

    from forge_sdk.storage.paths import bronze, silver, checkpoint

    src  = bronze("crm/raw/orders")
    dst  = silver("crm/orders_cleaned")
    ckpt = checkpoint("crm/orders_cleaned/_streaming")
"""
from __future__ import annotations

from forge_sdk.config.platform import PlatformConfig


def bronze(path: str = "", config: PlatformConfig | None = None) -> str:
    """Return an ABFS URI in the ``bronze`` container.

    Args:
        path:   Relative path within the container.
        config: Platform config; defaults to :meth:`PlatformConfig.from_env`.

    Returns:
        Fully qualified ``abfss://bronze@...`` URI.
    """
    cfg = config or PlatformConfig.from_env()
    return cfg.abfss("bronze", path)


def silver(path: str = "", config: PlatformConfig | None = None) -> str:
    """Return an ABFS URI in the ``silver`` container.

    Args:
        path:   Relative path within the container.
        config: Platform config; defaults to :meth:`PlatformConfig.from_env`.

    Returns:
        Fully qualified ``abfss://silver@...`` URI.
    """
    cfg = config or PlatformConfig.from_env()
    return cfg.abfss("silver", path)


def gold(path: str = "", config: PlatformConfig | None = None) -> str:
    """Return an ABFS URI in the ``gold`` container.

    Args:
        path:   Relative path within the container.
        config: Platform config; defaults to :meth:`PlatformConfig.from_env`.

    Returns:
        Fully qualified ``abfss://gold@...`` URI.
    """
    cfg = config or PlatformConfig.from_env()
    return cfg.abfss("gold", path)


def sandbox(path: str = "", config: PlatformConfig | None = None) -> str:
    """Return an ABFS URI in the ``sandbox`` container.

    The sandbox container exists **only in dev** (28-day TTL enforced by
    lifecycle policy). Raises :class:`RuntimeError` when called in prod to
    prevent accidental writes to a non-existent container.

    Args:
        path:   Relative path within the container.
        config: Platform config; defaults to :meth:`PlatformConfig.from_env`.

    Returns:
        Fully qualified ``abfss://sandbox@...`` URI.

    Raises:
        RuntimeError: When the resolved environment is ``prod``.
    """
    cfg = config or PlatformConfig.from_env()
    if cfg.env == "prod":
        raise RuntimeError(
            "sandbox/ container does not exist in prod. Use silver/ or gold/."
        )
    return cfg.abfss("sandbox", path)


def checkpoint(path: str = "", config: PlatformConfig | None = None) -> str:
    """Return an ABFS URI for Structured Streaming checkpoints.

    Checkpoints live under ``code/checkpoints/`` — there is no separate
    checkpoints container.  The ``code`` container is the single home for
    all operational platform artefacts (scripts, forge_lib.zip, Airflow logs,
    and checkpoints).

    Args:
        path:   Relative path within ``code/checkpoints/``.
        config: Platform config; defaults to :meth:`PlatformConfig.from_env`.

    Returns:
        Fully qualified ``abfss://code@.../checkpoints/<path>`` URI.
    """
    cfg = config or PlatformConfig.from_env()
    sub = f"checkpoints/{path}" if path else "checkpoints"
    return cfg.abfss("code", sub)


def code(path: str = "", config: PlatformConfig | None = None) -> str:
    """Return an ABFS URI in the ``code`` container.

    The ``code`` container holds job scripts, wheel files, and supporting
    artefacts deployed by CI/CD.

    Args:
        path:   Relative path within the container.
        config: Platform config; defaults to :meth:`PlatformConfig.from_env`.

    Returns:
        Fully qualified ``abfss://code@...`` URI.
    """
    cfg = config or PlatformConfig.from_env()
    return cfg.abfss("code", path)
