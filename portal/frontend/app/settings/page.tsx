"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";

interface PlatformInfo {
  env: string;
  platform: {
    airflow_host: string;
    trino_host: string;
    adls_account: string;
    purview_endpoint: string;
    resource_group: string;
    subscription_id: string;
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

  const p = platformInfo?.platform;
  const subId = p?.subscription_id;

  const trinoUrl = p?.trino_host ? `https://${p.trino_host}` : null;
  const adlsUrl = subId && p?.adls_account && p?.resource_group
    ? `https://portal.azure.com/#resource/subscriptions/${subId}/resourceGroups/${p.resource_group}/providers/Microsoft.Storage/storageAccounts/${p.adls_account}/overview`
    : null;
  const purviewUrl = p?.purview_endpoint || null;
  const rgUrl = subId && p?.resource_group
    ? `https://portal.azure.com/#resource/subscriptions/${subId}/resourceGroups/${p.resource_group}/overview`
    : null;

  return (
    <PageLayout
      icon="fa-server"
      title="Platform"
      subtitle="Connected infrastructure endpoints and environment configuration."
    >
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {platformInfo ? (
            <div style={{ padding: "8px 24px 20px" }}>
              <Row label="Environment" value={(platformInfo.env ?? "dev").toUpperCase()} badge={platformInfo.env === "prod" ? "red" : "green"} />
              <Row label="Airflow" value={p?.airflow_host ?? "—"} mono />
              <Row label="Trino" value={p?.trino_host ?? "—"} mono href={trinoUrl ?? undefined} />
              <Row label="ADLS Account" value={p?.adls_account ?? "—"} mono href={adlsUrl ?? undefined} />
              <Row label="Purview" value={(p?.purview_endpoint ?? "").replace("https://", "") || "—"} mono href={purviewUrl ?? undefined} />
              <Row label="Resource Group" value={p?.resource_group ?? "—"} mono href={rgUrl ?? undefined} />
            </div>
          ) : (
            <div style={{ padding: "32px 24px", color: "#94a3b8", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: 12 }} />
              Loading platform info…
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

function Row({ label, value, mono = false, badge, href }: {
  label: string; value: string; mono?: boolean; badge?: "red" | "green"; href?: string;
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
      ) : href && value !== "—" ? (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{
          fontSize: 13, fontWeight: 500, color: "var(--forge-primary)",
          fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all",
          textAlign: "right", textDecoration: "none", display: "flex", alignItems: "center", gap: 5,
        }}>
          {value}
          <i className="fas fa-arrow-up-right-from-square" style={{ fontSize: 10, opacity: 0.7 }} />
        </a>
      ) : (
        <span style={{ fontSize: 13, fontWeight: 500, color: "#0f172a", fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all", textAlign: "right" }}>
          {value}
        </span>
      )}
    </div>
  );
}
