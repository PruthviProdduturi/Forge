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

// ─── Types ────────────────────────────────────────────────────────────────────
export type AuthProvider = "azure_ad";
export type UserRole = "Viewer" | "Analyst" | "Editor" | "Admin";

export interface UserInfo {
  name: string;
  email: string;
  initials: string;
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
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => Promise<string | null>;
  refreshAuth: () => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
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

  // ── Fetch session from proxy ───────────────────────────────────────────────
  const initialize = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
      });

      if (res.status === 401) {
        // Not authenticated — show sign-in (proxy will redirect on next navigation)
        setState({
          isConnecting: false,
          isAuthenticated: false,
          noAccess: false,
          provider: "azure_ad",
          user: null,
          role: null,
          token: null,
        });
        return;
      }

      if (!res.ok) {
        throw new Error(`/api/auth/me returned ${res.status}`);
      }

      const data = await res.json() as { name: string; email: string; role: UserRole };
      const user: UserInfo = {
        name: data.name,
        email: data.email,
        initials: buildInitials(data.name),
      };

      setState({
        isConnecting: false,
        isAuthenticated: true,
        noAccess: false,
        provider: "azure_ad",
        user,
        role: data.role,
        token: null, // session cookie — no bearer token needed
      });
    } catch {
      // Backend unreachable — enter demo mode so the UI renders
      const isDemo = !process.env.NEXT_PUBLIC_API_BASE_URL && typeof window !== "undefined";
      setState({
        isConnecting: false,
        isAuthenticated: isDemo,
        noAccess: false,
        provider: "azure_ad",
        user: isDemo
          ? { name: "Demo User", email: "demo@forge.dev", initials: "DU" }
          : null,
        role: isDemo ? "Viewer" : null,
        token: null,
      });
    }
  }, []);

  // ── Login — redirect to proxy sign-in ─────────────────────────────────────
  const login = useCallback(async (): Promise<void> => {
    window.location.href = "/oauth2/sign_in";
  }, []);

  // ── Logout — redirect to proxy sign-out ───────────────────────────────────
  const logout = useCallback(async (): Promise<void> => {
    window.location.href = "/oauth2/sign_out";
  }, []);

  // ── No bearer token — session cookie handled by browser ───────────────────
  const getToken = useCallback(async (): Promise<string | null> => {
    return null;
  }, []);

  // ── Refresh ────────────────────────────────────────────────────────────────
  const refreshAuth = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, isConnecting: true }));
    await initialize();
  }, [initialize]);

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
