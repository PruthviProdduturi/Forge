"use client";

import { useCallback, useState } from "react";
import { useAuth } from "../../auth/useAuth";

export function LoginPage() {
  // Use the provider already resolved by AuthProvider on mount — no second fetch needed.
  const { login, isConnecting, provider: resolvedProvider } = useAuth();
  const provider = resolvedProvider ?? "local";
  const providerLoading = isConnecting;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLocalLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!username.trim() || !password) return;
      setError(null);
      setLoading(true);
      try {
        await login(username.trim(), password);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Login failed. Please try again."
        );
      } finally {
        setLoading(false);
      }
    },
    [login, username, password]
  );

  const handleAzureLogin = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      await login();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Azure sign-in failed. Please try again."
      );
      setLoading(false);
    }
  }, [login]);

  if (isConnecting || providerLoading) {
    return (
      <div className="login-container">
        <div
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}
        >
          <div className="loading-spinner" />
          <span className="loading-text">Connecting…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <span className="login-logo-mark" aria-hidden="true">▲</span>
          <span className="login-logo-name">Forge</span>
          <span className="login-logo-tagline">
            The Core Data Engineering Platform
          </span>
        </div>

        {/* Error */}
        {error && (
          <div className="login-error" role="alert">
            <i className="fas fa-circle-exclamation" aria-hidden="true" />
            {error}
          </div>
        )}

        {/* Azure AD login */}
        {provider === "azure_ad" && (
          <div className="login-form">
            <p
              style={{
                fontSize: 13,
                color: "#64748b",
                textAlign: "center",
                lineHeight: 1.6,
                marginBottom: 4,
              }}
            >
              Sign in with your organisational Microsoft account to access
              Forge.
            </p>
            <button
              className="login-btn login-btn-azure"
              onClick={handleAzureLogin}
              disabled={loading}
              type="button"
            >
              {loading ? (
                <>
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      border: "2px solid rgba(255,255,255,0.4)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      animation: "spin 0.7s linear infinite",
                      display: "inline-block",
                    }}
                  />
                  Redirecting…
                </>
              ) : (
                <>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 21 21"
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                  </svg>
                  Sign in with Microsoft
                </>
              )}
            </button>
          </div>
        )}

        {/* Local / Google login */}
        {(provider === "local" || provider === "google" || provider === null) && (
          <form className="login-form" onSubmit={handleLocalLogin} noValidate>
            <div className="login-field">
              <label htmlFor="forge-username">Username</label>
              <input
                id="forge-username"
                type="text"
                autoComplete="username"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                required
                autoFocus
              />
            </div>
            <div className="login-field">
              <label htmlFor="forge-password">Password</label>
              <input
                id="forge-password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                required
              />
            </div>
            <button
              className="login-btn"
              type="submit"
              disabled={loading || !username.trim() || !password}
            >
              {loading ? (
                <>
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      border: "2px solid rgba(255,255,255,0.4)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      animation: "spin 0.7s linear infinite",
                      display: "inline-block",
                    }}
                  />
                  Signing in…
                </>
              ) : (
                <>
                  <i className="fas fa-right-to-bracket" aria-hidden="true" />
                  Sign in
                </>
              )}
            </button>
          </form>
        )}

        <p
          style={{
            fontSize: 11.5,
            color: "#94a3b8",
            textAlign: "center",
            marginTop: "1.5rem",
          }}
        >
          © {new Date().getFullYear()} Forge — Core Data Engineering Platform
        </p>
      </div>
    </div>
  );
}
