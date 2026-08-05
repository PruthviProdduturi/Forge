"use client";

import { useCallback, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useAuth } from "../../auth/useAuth";
import { ForgeLogo } from "../../components/ForgeLogo";
import { ForgeLoader } from "../../components/ForgeLoader";

export function LoginPage() {
  const { login, isConnecting } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const showComingSoon = useCallback((provider: string) => {
    setToast(provider === "google" ? "Google" : "Microsoft");
  }, []);

  // Azure AD — proxy-based (AKS only)
  const handleAzureLogin = useCallback(async () => {
    setError(null);
    setLoading("azure");
    try {
      await login();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Azure sign-in failed. Please try again."
      );
      setLoading(null);
    }
  }, [login]);

  // GitHub OAuth via NextAuth
  const handleGitHubLogin = useCallback(() => {
    setError(null);
    setLoading("github");
    signIn("github", { callbackUrl: "/about" });
  }, []);

  // Google OAuth via NextAuth — coming soon
  const handleGoogleLogin = useCallback(() => {
    showComingSoon("google");
  }, [showComingSoon]);

  if (isConnecting) {
    return <ForgeLoader text="Connecting…" />;
  }

  const btnSpinner = (
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
  );

  return (
    <div className="login-container">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <ForgeLogo size={52} showName={true} />
          <span className="login-logo-tagline">
            The Core Platform
          </span>
        </div>

        {/* Error */}
        {error && (
          <div className="login-error" role="alert">
            <i className="fas fa-circle-exclamation" aria-hidden="true" />
            {error}
          </div>
        )}

        <div className="login-form">
          <p
            style={{
              fontSize: 13,
              color: "#64748b",
              textAlign: "center",
              lineHeight: 1.6,
              marginBottom: 12,
            }}
          >
            Sign in to access the Forge Developer Portal.
          </p>

          {/* GitHub — primary */}
          <button
            className="login-btn login-btn-github"
            onClick={handleGitHubLogin}
            disabled={loading !== null}
            type="button"
            style={{
              background: "#24292e",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "12px 16px",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              width: "100%",
              marginBottom: 4,
            }}
          >
            {loading === "github" ? (
              <>{btnSpinner} Redirecting…</>
            ) : (
              <>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="white"
                  aria-hidden="true"
                >
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                Sign in with GitHub
              </>
            )}
          </button>

          {/* Divider */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              margin: "10px 0",
            }}
          >
            <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
            <span style={{ fontSize: 11, color: "#94a3b8" }}>or</span>
            <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
          </div>

          {/* Google */}
          <button
            className="login-btn login-btn-google"
            onClick={handleGoogleLogin}
            disabled={loading !== null}
            type="button"
            style={{
              background: "#fff",
              color: "#3c4043",
              border: "1px solid #dadce0",
              borderRadius: 8,
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: toast ? "not-allowed" : "pointer",
              opacity: toast ? 0.5 : 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              width: "100%",
              marginBottom: 8,
            }}
          >
            {loading === "google" ? (
              <>{btnSpinner} Redirecting…</>
            ) : (
              <>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                Sign in with Google
              </>
            )}
          </button>

          {/* Azure AD — for AKS deployments */}
          <button
            className="login-btn login-btn-azure"
            onClick={() => showComingSoon("microsoft")}
            disabled={loading !== null}
            type="button"
            style={{ opacity: toast ? 0.5 : undefined, cursor: toast ? "not-allowed" : undefined }}
          >
            {loading === "azure" ? (
              <>{btnSpinner} Redirecting…</>
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

        <p
          style={{
            fontSize: 11.5,
            color: "#94a3b8",
            textAlign: "center",
            marginTop: "1.5rem",
          }}
        >
          © {new Date().getFullYear()} Forge — The Core Platform
        </p>
      </div>

      {/* Coming-soon modal */}
      {toast && (
        <>
          <div
            onClick={() => setToast(null)}
            style={{
              position: "fixed", inset: 0,
              background: "rgba(0,0,0,0.4)",
              backdropFilter: "blur(4px)",
              zIndex: 99,
              animation: "fadeIn 0.2s ease-out",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              maxWidth: 400,
              width: "calc(100% - 40px)",
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 16,
              padding: "28px 24px",
              boxShadow: "0 24px 64px rgba(0,0,0,0.15)",
              animation: "modalPop 0.3s ease-out",
              zIndex: 100,
              textAlign: "center",
            }}
          >
            <style>{`
              @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
              @keyframes modalPop { from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
            `}</style>
            <div style={{
              width: 48, height: 48, borderRadius: "50%",
              background: "rgba(0,120,212,0.08)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <i className="fas fa-plug-circle-exclamation" style={{ fontSize: 20, color: "#0078d4" }} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>
              {toast === "google" ? "Google" : "Microsoft"} sign-in coming soon
            </div>
            <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6, marginBottom: 20 }}>
              This provider isn&rsquo;t wired up yet. GitHub login works great — and hey, your code lives there anyway.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                type="button"
                onClick={() => setToast(null)}
                style={{
                  padding: "9px 18px", borderRadius: 8,
                  background: "transparent", border: "1px solid #e2e8f0",
                  color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer",
                }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => { setToast(null); handleGitHubLogin(); }}
                style={{
                  padding: "9px 18px", borderRadius: 8,
                  background: "#24292e", border: "none",
                  color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                Sign in with GitHub
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
