"""Forge Developer Portal FastAPI application."""
from __future__ import annotations

import time
from typing import Callable

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, cost, datasets, dq, health, lineage, pipelines
from app.core.config import get_settings

settings = get_settings()

# ── Structured logging setup ──────────────────────────────────────────────────
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer() if settings.forge_env == "dev" else structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(10),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Forge Developer Portal API",
    version="1.0.0",
    description="API backend for the Forge data platform developer portal",
)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request logging middleware ────────────────────────────────────────────────
@app.middleware("http")
async def logging_middleware(request: Request, call_next: Callable) -> Response:
    start = time.perf_counter()
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        method=request.method,
        path=request.url.path,
    )
    try:
        response = await call_next(request)
        elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
        log.info(
            "request_completed",
            status_code=response.status_code,
            elapsed_ms=elapsed_ms,
        )
        return response
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
        log.error("request_failed", error=str(exc), elapsed_ms=elapsed_ms)
        raise


# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(pipelines.router)
app.include_router(datasets.router)
app.include_router(dq.router)
app.include_router(lineage.router)
app.include_router(cost.router)


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Forge Developer Portal API", "version": "1.0.0"}
