"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { API_BASE } from "../config";
import {
  configureMsal,
  ensureMsalInitialized,
  getMsalInstance,
  loginRequest,
} from "./msalConfig";

// ─── Storage keys ────────────────────────────────────────────────────────────
const AUTH_CACHE_KEY = "forge-auth-cache";
const ROLE_CACHE_KEY = "forge-user-role";
const PROVIDER_KEY = "forge_auth_provider";
const LOCAL_TOKEN_KEY = "forge_local_token";
const LOCAL_TOKEN_EXP_KEY = "forge_local_token_exp";

// ─── Types ────────────────────────────────────────────────────────────────────
export type AuthProvider = "local" | "azure_ad" | "google";
export type UserRole = "Viewer" | "Analyst" | "Editor" | "Admin";

export interface UserInfo {
  name: string;
  email: string;
  initials: string;
}

interface AuthCache {
  provider: AuthProvider;
  user: UserInfo;
  role: UserRole;
  expiresAt: number;
}

interface AuthState {
  isConnecting: boolean;
  isAuthenticated: boolean;
  noAccess: boolean;
  provider: AuthProvider | null;
  user: UserInfo | null;
  role: UserRole | null;
  token: string | null;
}

interface AuthContextValue extends AuthState {
  login: (username?: string, password?: string) => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => Promise<string | null>;
  refreshAuth: () => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractRole(claims: Record<string, unknown>): UserRole {
  const roles = claims["roles"] ?? claims["role"] ?? claims["app_roles"];
  const list: string[] = Array.isArray(roles)
    ? (roles as string[])
    : typeof roles === "string"
      ? [roles]
      : [];

  if (list.some((r) => r.toLowerCase() === "admin")) return "Admin";
  if (list.some((r) => r.toLowerCase() === "editor")) return "Editor";
  if (list.some((r) => r.toLowerCase() === "analyst")) return "Analyst";
  if (list.length > 0) return "Viewer";
  return "Viewer";
}

function extractUser(claims: Record<string, unknown>): UserInfo {
  const name =
    (claims["name"] as string) ||
    (claims["preferred_username"] as string) ||
    (claims["email"] as string) ||
    "Unknown User";
  const email =
    (claims["email"] as string) ||
    (claims["preferred_username"] as string) ||
    (claims["upn"] as string) ||
    "";
  const parts = name.trim().split(/\s+/);
  const initials =
    parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();
  return { name, email, initials };
}

function readCache(): AuthCache | null {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as AuthCache;
    if (cache.expiresAt < Date.now()) {
      localStorage.removeItem(AUTH_CACHE_KEY);
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function writeCache(data: AuthCache): void {
  try {
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(ROLE_CACHE_KEY, data.role);
    localStorage.setItem(PROVIDER_KEY, data.provider);
  } catch {
    // ignore storage errors
  }
}

function clearCache(): void {
  try {
    localStorage.removeItem(AUTH_CACHE_KEY);
    localStorage.removeItem(ROLE_CACHE_KEY);
    localStorage.removeItem(PROVIDER_KEY);
    localStorage.removeItem(LOCAL_TOKEN_KEY);
    localStorage.removeItem(LOCAL_TOKEN_EXP_KEY);
  } catch {
    // ignore
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isConnecting: true,
    isAuthenticated: false,
    noAccess: false,
    provider: null,
    user: null,
    role: null,
    token: null,
  });

  const initializedRef = useRef(false);

  // ── Resolve auth provider from API ─────────────────────────────────────────
  // Always fetch API first (like LoomX). Cache is only a fallback when the
  // API is unreachable. Returns null when backend is unreachable so the caller
  // can fall back to the dev admin bypass.
  const resolveProvider = useCallback(async (): Promise<AuthProvider | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${API_BASE}/api/auth/provider`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (!res.ok) throw new Error("provider fetch failed");
      const data = (await res.json()) as {
        provider: AuthProvider;
        azure_client_id?: string;
        azure_tenant_id?: string;
      };
      if (data.provider === "azure_ad" && data.azure_client_id) {
        configureMsal(data.azure_client_id, data.azure_tenant_id ?? "common");
      }
      localStorage.setItem(PROVIDER_KEY, data.provider);
      return data.provider;
    } catch {
      // API unreachable
      return null;
    }
  }, []);

  // ── Local auth ────────────────────────────────────────────────────────────
  const loginLocal = useCallback(
    async (username: string, password: string): Promise<void> => {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || "Login failed");
      }
      const data = (await res.json()) as { token: string; expires_in?: number };
      const token = data.token;
      const claims = parseJwtPayload(token);
      const exp = (claims["exp"] as number) ?? Date.now() / 1000 + 3600;
      const expMs = exp * 1000;

      localStorage.setItem(LOCAL_TOKEN_KEY, token);
      localStorage.setItem(LOCAL_TOKEN_EXP_KEY, String(expMs));

      const user = extractUser(claims);
      const role = extractRole(claims);

      writeCache({
        provider: "local",
        user,
        role,
        expiresAt: expMs,
      });

      setState({
        isConnecting: false,
        isAuthenticated: true,
        noAccess: false,
        provider: "local",
        user,
        role,
        token,
      });
    },
    []
  );

  // ── Azure AD auth ─────────────────────────────────────────────────────────
  const loginAzure = useCallback(async (): Promise<void> => {
    await ensureMsalInitialized();
    const msalInstance = getMsalInstance();
    await msalInstance.loginRedirect(loginRequest);
  }, []);

  // ── Handle Azure redirect ─────────────────────────────────────────────────
  const handleAzureRedirect = useCallback(async (): Promise<boolean> => {
    try {
      await ensureMsalInitialized();
    } catch {
      return false;
    }
    const msalInstance = getMsalInstance();
    const result = await msalInstance.handleRedirectPromise();
    if (!result) return false;

    // Use the ID token — it is signed with the tenant's published JWKS keys
    // and contains the user's identity + app roles.  The access token is for
    // Microsoft Graph (User.Read scope) and is signed with MS-internal keys
    // that cannot be verified against the standard tenant JWKS endpoint.
    const token = result.idToken || result.accessToken;
    const claims = parseJwtPayload(result.idToken);
    const user = extractUser({
      ...claims,
      name: result.account?.name ?? claims["name"],
      email:
        result.account?.username ??
        (claims["email"] as string) ??
        (claims["preferred_username"] as string),
    });
    const role = extractRole(claims);
    const expMs = (result.expiresOn?.getTime() ?? Date.now() + 3600_000);

    writeCache({ provider: "azure_ad", user, role, expiresAt: expMs });

    setState({
      isConnecting: false,
      isAuthenticated: true,
      noAccess: false,
      provider: "azure_ad",
      user,
      role,
      token,
    });
    return true;
  }, []);

  // ── Silent Azure token refresh ────────────────────────────────────────────
  const acquireAzureToken = useCallback(async (): Promise<string | null> => {
    try {
      await ensureMsalInitialized();
      const msalInstance = getMsalInstance();
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length === 0) return null;
      const result = await msalInstance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      });
      // Prefer the ID token — signed with tenant JWKS keys and contains app roles.
      return result.idToken || result.accessToken;
    } catch {
      return null;
    }
  }, []);

  // ── Get current token ─────────────────────────────────────────────────────
  const getToken = useCallback(async (): Promise<string | null> => {
    if (state.provider === "azure_ad") {
      return acquireAzureToken();
    }
    const token = localStorage.getItem(LOCAL_TOKEN_KEY);
    const exp = Number(localStorage.getItem(LOCAL_TOKEN_EXP_KEY) ?? 0);
    if (token && Date.now() < exp) return token;
    // In dev-bypass mode state.token is the literal string "dev" — not a real
    // JWT.  Never forward it to the backend; return null so the caller knows
    // there is no valid session and can surface a meaningful error.
    const inMemory = state.token;
    if (!inMemory || inMemory === "dev") return null;
    return inMemory;
  }, [state.provider, state.token, acquireAzureToken]);

  // ── Login dispatcher ──────────────────────────────────────────────────────
  // Use state.provider (resolved on mount) rather than re-fetching, matching
  // LoomX's pattern. Falls back to localStorage which was written by resolveProvider.
  const login = useCallback(
    async (username?: string, password?: string): Promise<void> => {
      const activeProvider =
        state.provider ??
        (localStorage.getItem(PROVIDER_KEY) as AuthProvider | null) ??
        "local";
      if (activeProvider === "azure_ad") {
        await loginAzure();
      } else {
        if (!username || !password) {
          throw new Error("Username and password are required");
        }
        await loginLocal(username, password);
      }
    },
    [state.provider, loginAzure, loginLocal]
  );

  // ── Logout ────────────────────────────────────────────────────────────────
  const logout = useCallback(async (): Promise<void> => {
    const currentProvider = state.provider;
    clearCache();
    if (currentProvider === "azure_ad") {
      try {
        await ensureMsalInitialized();
        const msalInstance = getMsalInstance();
        const accounts = msalInstance.getAllAccounts();
        if (accounts.length > 0) {
          await msalInstance.logoutRedirect({ account: accounts[0] });
          return;
        }
      } catch {
        // fall through
      }
    }
    // Fetch the live provider so the login page shows the correct sign-in
    // option (e.g. if admin just switched from local → azure_ad).
    // We do NOT re-run full initialize() here because that would pick up
    // stale MSAL accounts and silently authenticate as Viewer.
    const freshProvider = await resolveProvider().catch(() => currentProvider ?? "local");
    setState({
      isConnecting: false,
      isAuthenticated: false,
      noAccess: false,
      provider: freshProvider ?? currentProvider ?? "local",
      user: null,
      role: null,
      token: null,
    });
  }, [state.provider, resolveProvider]);

  // ── Refresh auth state ────────────────────────────────────────────────────
  const refreshAuth = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, isConnecting: true }));
    await initialize();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dev admin bypass ─────────────────────────────────────────────────────
  // Called when resolveProvider() returns null (backend unreachable).
  // First tries to log in with the default dev credentials — if the backend
  // just became reachable this produces a real JWT and all API calls work.
  // Only falls back to the fake "dev" token when the backend is truly down.
  const loginDevAdmin = useCallback(async () => {
    try {
      await loginLocal("admin", "admin");
    } catch {
      // Backend still unreachable or credentials changed — use offline bypass.
      // API calls will fail with 401 until the user signs in properly, but the
      // UI is at least navigable.
      setState({
        isConnecting: false,
        isAuthenticated: true,
        noAccess: false,
        provider: "local",
        user: { name: "Dev Admin", email: "admin@forge.local", initials: "DA" },
        role: "Admin",
        token: "dev",
      });
    }
  }, [loginLocal]);

  // ── Initialization ────────────────────────────────────────────────────────
  const initialize = useCallback(async (): Promise<void> => {
    try {
      // Fast path: if there is a valid local JWT, use it immediately as a
      // master key. This works even when the KV provider is set to "azure_ad",
      // preventing admins from being locked out of the auth settings page while
      // they are reconfiguring the provider.
      const localToken = localStorage.getItem(LOCAL_TOKEN_KEY);
      const localExp = Number(localStorage.getItem(LOCAL_TOKEN_EXP_KEY) ?? 0);
      if (localToken && Date.now() < localExp) {
        const claims = parseJwtPayload(localToken);
        const role = extractRole(claims);
        const user = extractUser(claims);
        writeCache({ provider: "local", user, role, expiresAt: localExp });
        setState({
          isConnecting: false,
          isAuthenticated: true,
          noAccess: false,
          provider: "local",
          user,
          role,
          token: localToken,
        });
        // Still resolve provider in background so the login page knows which
        // provider to show if the user logs out.
        resolveProvider().catch(() => {});
        return;
      }

      const resolvedOrNull = await resolveProvider();

      // Backend unreachable — use dev admin bypass
      if (resolvedOrNull === null) {
        await loginDevAdmin();
        return;
      }

      const provider = resolvedOrNull;

      // Handle Azure redirect first
      if (provider === "azure_ad") {
        const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID;
        const tenantId =
          process.env.NEXT_PUBLIC_AZURE_TENANT_ID ?? "common";
        if (clientId) configureMsal(clientId, tenantId);

        const redirectHandled = await handleAzureRedirect();
        if (redirectHandled) return;

        // Only silently re-authenticate if we have an explicit prior Azure AD
        // cache entry. Without it the user must click "Sign in with Microsoft"
        // — prevents silently resolving to "Viewer" when MSAL has stale accounts
        // from earlier browser sessions where app roles weren't yet assigned.
        const azureCache = readCache();
        if (azureCache?.provider === "azure_ad") {
          try {
            await ensureMsalInitialized();
            const msalInstance = getMsalInstance();
            const accounts = msalInstance.getAllAccounts();
            if (accounts.length > 0) {
              const token = await acquireAzureToken();
              if (token) {
                const claims = parseJwtPayload(token);
                const acc = accounts[0];
                const user = extractUser({
                  ...claims,
                  name: acc.name ?? claims["name"],
                  email:
                    acc.username ??
                    (claims["email"] as string) ??
                    (claims["preferred_username"] as string),
                });
                const role = extractRole(claims);
                // Use the token's own exp claim so the cache matches the actual
                // token lifetime (Azure AD tokens are typically 60–90 min but
                // MSAL silently refreshes them, so we honour whatever it returns).
                const expMs = claims["exp"]
                  ? (claims["exp"] as number) * 1000
                  : Date.now() + 3600_000;
                writeCache({ provider: "azure_ad", user, role, expiresAt: expMs });
                setState({
                  isConnecting: false,
                  isAuthenticated: true,
                  noAccess: false,
                  provider: "azure_ad",
                  user,
                  role,
                  token,
                });
                return;
              }
            }
          } catch {
            // no existing Azure session
          }
        }
      }

      // Check cache — discard immediately if the provider has changed since it
      // was written (e.g. switched from azure_ad → local or vice-versa).
      // A mismatched cache is always stale; force a fresh login.
      const cache = readCache();
      if (cache) {
        if (cache.provider !== provider) {
          clearCache();
          setState({
            isConnecting: false,
            isAuthenticated: false,
            noAccess: false,
            provider,
            user: null,
            role: null,
            token: null,
          });
          return;
        }

        let token: string | null = null;
        let resolvedRole = cache.role;

        if (cache.provider === "local") {
          token = localStorage.getItem(LOCAL_TOKEN_KEY);
          const exp = Number(localStorage.getItem(LOCAL_TOKEN_EXP_KEY) ?? 0);
          if (!token || Date.now() > exp) {
            clearCache();
            setState({
              isConnecting: false,
              isAuthenticated: false,
              noAccess: false,
              provider,
              user: null,
              role: null,
              token: null,
            });
            return;
          }
          // Always re-derive role from the live JWT — never trust the cached
          // role. A cache written during an earlier Azure AD session (before
          // app roles were assigned) would otherwise bleed through.
          resolvedRole = extractRole(parseJwtPayload(token));
        }

        setState({
          isConnecting: false,
          isAuthenticated: true,
          noAccess: false,
          provider: cache.provider,
          user: cache.user,
          role: resolvedRole,
          token,
        });
        return;
      }

      // Not authenticated — ensure provider is written so login() reads correctly
      localStorage.setItem(PROVIDER_KEY, provider);
      setState({
        isConnecting: false,
        isAuthenticated: false,
        noAccess: false,
        provider,
        user: null,
        role: null,
        token: null,
      });
    } catch (err) {
      console.error("[AuthProvider] initialization error:", err);
      setState({
        isConnecting: false,
        isAuthenticated: false,
        noAccess: false,
        provider: null,
        user: null,
        role: null,
        token: null,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveProvider, handleAzureRedirect, acquireAzureToken, loginDevAdmin]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    initialize();
  }, [initialize]);


  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    getToken,
    refreshAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
