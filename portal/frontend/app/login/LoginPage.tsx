"use client";

import { useCallback, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { ForgeLogo } from "../../components/ForgeLogo";
import { ForgeLoader } from "../../components/ForgeLoader";

export function LoginPage() {
  const { login, isConnecting } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  if (isConnecting) {
    return <ForgeLoader text="Connecting…" />;
  }

  return (
    <div className="login-container">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <ForgeLogo size={52} showName={true} />
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
            Sign in with your organisational Microsoft account to access Forge.
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
