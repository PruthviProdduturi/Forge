"""Simple in-process TTL cache for expensive backend calls.

Thread-safe; suitable for use with asyncio.to_thread since reads/writes
hold a short threading.Lock (no I/O inside the lock).

Usage:
    from app.core.cache import cache

    result = cache.get_or_set("my:key", ttl=60, fn=lambda: expensive_call())
    cache.delete_prefix("dq:")
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class TTLCache:
    """In-memory key-value store with per-entry TTL (seconds)."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}  # key → (expires_at, value)
        self._lock = threading.Lock()

    def get(self, key: str) -> tuple[bool, Any]:
        """Return (hit, value). Value is None on a miss."""
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return False, None
            exp, val = entry
            if time.monotonic() >= exp:
                del self._store[key]
                return False, None
            return True, val

    def set(self, key: str, value: Any, ttl: float) -> None:
        """Store value with TTL seconds from now."""
        with self._lock:
            self._store[key] = (time.monotonic() + ttl, value)

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)

    def delete_prefix(self, prefix: str) -> None:
        """Evict all entries whose key starts with *prefix*."""
        with self._lock:
            keys = [k for k in self._store if k.startswith(prefix)]
            for k in keys:
                del self._store[k]

    def get_or_set(self, key: str, ttl: float, fn: Callable[[], T]) -> T:
        """Return cached value or call *fn*, cache the result, and return it."""
        hit, val = self.get(key)
        if hit:
            return val  # type: ignore[return-value]
        result = fn()
        self.set(key, result, ttl)
        return result


# Module-level singleton — shared across all requests in the same process.
cache = TTLCache()
