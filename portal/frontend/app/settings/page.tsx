"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";

interface PlatformInfo {
  env: string;
  auth_provider: string;
  platform: {
    airflow_host: string;
    trino_host: string;
    adls_account: string;
    purview_endpoint: string;
    resource_group: string;
  };
}

export default function PlatformSettingsPage() {
  const { getToken } = useAuth();
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);

  useEffect(() => {
    apiFetch<PlatformInfo>("/api/health", getToken)
      .then(setPlatformInfo)
      .catch(() => {});
  }, [getToken]);

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Hero */}
      <div style={{
        background: "linear-gradient(135deg, var(--forge-primary) 0%, var(--forge-dark) 100%)",
        padding: "48px 1.5rem 40px",
      }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 11, background: "rgba(255,255,255,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <i className="fas fa-server" style={{ color: "#fff", fontSize: 18 }} />
            </div>
            <h1 style={{ fontSize: "clamp(1.6rem,3.5vw,2.2rem)", fontWeight: 800, color: "#fff", margin: 0, letterSpacing: "-0.02em" }}>
              Platform
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.7)", margin: 0, fontSize: 15 }}>
            Connected infrastructure endpoints and environment configuration.
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 1.5rem 80px" }}>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {platformInfo ? (
            <div style={{ padding: "8px 24px 20px" }}>
              <Row label="Environment" value={(platformInfo.env ?? "dev").toUpperCase()} badge={platformInfo.env === "prod" ? "red" : "green"} />
              <Row label="Auth Provider" value={platformInfo.auth_provider === "azure_ad" ? "Azure AD (SSO)" : "Local"} />
              <Row label="Airflow" value={platformInfo.platform?.airflow_host ?? "—"} mono />
              <Row label="Trino" value={platformInfo.platform?.trino_host ?? "—"} mono />
              <Row label="ADLS Account" value={platformInfo.platform?.adls_account ?? "—"} mono />
              <Row label="Purview" value={(platformInfo.platform?.purview_endpoint ?? "").replace("https://", "") || "—"} mono />
              <Row label="Resource Group" value={platformInfo.platform?.resource_group ?? "—"} mono />
            </div>
          ) : (
            <div style={{ padding: "32px 24px", color: "#94a3b8", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: 12 }} />
              Loading platform info…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono = false, badge }: {
  label: string; value: string; mono?: boolean; badge?: "red" | "green";
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #f8fafc", gap: 16 }}>
      <span style={{ fontSize: 13, color: "#64748b", flexShrink: 0 }}>{label}</span>
      {badge ? (
        <span style={{
          padding: "2px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700,
          background: badge === "red" ? "#fee2e2" : "#dcfce7",
          color: badge === "red" ? "#dc2626" : "#16a34a",
        }}>
          {value}
        </span>
      ) : (
        <span style={{ fontSize: 13, fontWeight: 500, color: "#0f172a", fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all", textAlign: "right" }}>
          {value}
        </span>
      )}
    </div>
  );
}
