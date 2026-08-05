"use client";

/**
 * Renders a professional empty state when the backend API is not connected.
 * Replaces raw "API error 503" messages with a clear, helpful message.
 */
export function BackendStatus({ error, feature }: { error: string | null; feature?: string }) {
  if (!error) return null;

  const isDisconnected =
    error.includes("Backend not connected") ||
    error.includes("503") ||
    error.includes("Failed to fetch") ||
    error.includes("NetworkError");

  if (!isDisconnected) {
    // Real error — show as-is
    return (
      <div style={{ padding: "20px 24px", color: "#dc2626" }}>
        <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
        {error}
      </div>
    );
  }

  return (
    <div
      style={{
        margin: "32px auto",
        maxWidth: 520,
        textAlign: "center",
        padding: "40px 24px",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(var(--forge-primary-rgb, 30,58,95), 0.1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 16px",
        }}
      >
        <i
          className="fas fa-plug-circle-xmark"
          style={{
            fontSize: 24,
            color: "var(--forge-primary, #1e3a5f)",
            opacity: 0.6,
          }}
        />
      </div>
      <h3
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: "#e2e8f0",
          margin: "0 0 8px",
        }}
      >
        {feature ? `${feature} — ` : ""}Not Connected
      </h3>
      <p
        style={{
          fontSize: 13,
          color: "#94a3b8",
          lineHeight: 1.6,
          margin: "0 0 20px",
        }}
      >
        This feature requires the Forge backend API.{" "}
        {feature === "Cost Explorer"
          ? "Connect to Azure Cost Management to view spend data."
          : feature === "Data Sources"
            ? "Connect to the backend to register and manage data sources."
            : "Deploy the platform with the backend to see live data here."}
      </p>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px",
          borderRadius: 8,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          fontSize: 12,
          color: "#64748b",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <i className="fas fa-terminal" style={{ fontSize: 10, opacity: 0.5 }} />
        bash infra/scripts/forge-up.sh --env dev
      </div>
    </div>
  );
}
