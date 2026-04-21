"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { apiFetch } from "../utils/api";

let _cachedEnv: string | null = null;

/**
 * Returns the Forge environment from the platform health endpoint.
 * Result is module-cached — only one network call per session.
 * isDev is true only when env === "dev".
 */
export function useForgeEnv(): { env: string | null; isDev: boolean; loading: boolean } {
  const { getToken } = useAuth();
  const [env, setEnv] = useState<string | null>(_cachedEnv);
  const [loading, setLoading] = useState(_cachedEnv === null);

  useEffect(() => {
    if (_cachedEnv !== null) return;
    apiFetch<{ env: string }>("/api/health", getToken)
      .then(d => {
        _cachedEnv = d.env ?? "dev";
        setEnv(_cachedEnv);
      })
      .catch(() => {
        _cachedEnv = "dev"; // fail-safe: show buttons if we can't determine env
        setEnv(_cachedEnv);
      })
      .finally(() => setLoading(false));
  }, [getToken]);

  return { env, isDev: env === "dev", loading };
}
