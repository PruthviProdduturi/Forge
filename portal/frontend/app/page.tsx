"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useTheme } from "../contexts/ThemeContext";
import { apiFetch } from "../utils/api";

interface HealthData {
  status: string;
  checks: {
    airflow: boolean | null;
    trino: boolean | null;
    spark_connect: boolean | null;
    adls: boolean | null;
  };
}

interface Pipeline {
  dag_id: string;
  description: string;
  is_active: boolean;
  last_run_state: string | null;
  last_run_at: string | null;
  is_paused: boolean;
  schedule: string | null;
  tags: string[];
}

interface DQSummary {
  dataset: string;
  pass_rate: number | null;
  last_run_at: string;
  critical_failures: number;
  warnings: number;
  last_status: "PASS" | "FAIL" | "WARN" | "MONITORED";
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  success: { bg: "#dcfce7", color: "#16a34a", label: "Success" },
  failed:  { bg: "#fee2e2", color: "#dc2626", label: "Failed" },
  running: { bg: "#fef9c3", color: "#ca8a04", label: "Running" },
  queued:  { bg: "#e0f2fe", color: "#0284c7", label: "Queued" },
};

const DQ_STYLE: Record<string, { bg: string; color: string }> = {
  PASS:      { bg: "#dcfce7", color: "#16a34a" },
  FAIL:      { bg: "#fee2e2", color: "#dc2626" },
  WARN:      { bg: "#fef9c3", color: "#ca8a04" },
  MONITORED: { bg: "#f1f5f9", color: "#64748b" },
};

function SvcIcon({ type, size = 16 }: { type: string; size?: number; color?: string }) {
  const imgStyle: React.CSSProperties = { width: size, height: size, display: "block" };
  switch (type) {
    case "adls":
      // Azure Data Lake Storage — stacked cylinders
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="rgba(255,255,255,0.9)" aria-hidden>
        <ellipse cx="12" cy="6.5" rx="8" ry="3.2"/>
        <path d="M4 6.5v4c0 1.77 3.58 3.2 8 3.2s8-1.43 8-3.2v-4" opacity="0.7"/>
        <path d="M4 10.5v4c0 1.77 3.58 3.2 8 3.2s8-1.43 8-3.2v-4" opacity="0.45"/>
      </svg>;
    case "airflow":
      // Official Apache Airflow logo from Simple Icons
      return <img src="https://cdn.simpleicons.org/apacheairflow/ffffff" style={imgStyle} alt="Airflow" />;
    case "spark":
      // Apache Spark lightning bolt
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="rgba(255,255,255,0.9)" aria-hidden>
        <path d="M14 2L4.5 13.5H11L9 22L20 10.5H13.5L14 2Z"/>
      </svg>;
    case "trino":
      // Official Trino logo from Simple Icons
      return <img src="https://cdn.simpleicons.org/trino/ffffff" style={imgStyle} alt="Trino" />;
    default:
      return <i className={`fas ${type}`} style={{ color: "rgba(255,255,255,0.9)", fontSize: size * 0.85 }} />;
  }
}

export default function HomePage() {
  const { user, role, getToken } = useAuth();
  const { primaryColor } = useTheme();

  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [dq, setDq] = useState<DQSummary[]>([]);

  useEffect(() => {
    apiFetch<HealthData>("/api/health", getToken)
      .then(setHealth).catch(() => {}).finally(() => setHealthLoading(false));
    apiFetch<Pipeline[]>("/api/pipelines", getToken)
      .then(setPipelines).catch(() => {});
    apiFetch<DQSummary[]>("/api/dq/summary", getToken)
      .then(setDq).catch(() => {});
  }, [getToken]);

  // Pipeline stats
  const activePipelines = pipelines.filter(p => p.is_active && !p.is_paused).length;
  const failedPipelines = pipelines.filter(p => p.last_run_state === "failed").length;

  // DQ stats
  const dqPass      = dq.filter(d => d.last_status === "PASS").length;
  const dqFail      = dq.filter(d => d.last_status === "FAIL").length;
  const dqWarn      = dq.filter(d => d.last_status === "WARN").length;
  const dqMonitored = dq.filter(d => d.last_status === "MONITORED").length;
  const dqRated     = dq.filter(d => d.pass_rate !== null);
  const dqAvgRate   = dqRated.length > 0
    ? Math.round(dqRated.reduce((s, d) => s + (d.pass_rate ?? 0), 0) / dqRated.length * 100)
    : null;
  const dqIssues    = dq.filter(d => (d.last_status !== "PASS" && d.last_status !== "MONITORED") || d.critical_failures > 0);

  // Platform health
  const platformOk  = !healthLoading && health?.status === "ok";

  // Service checks
  const services = [
    { label: "ADLS",    key: "adls",         type: "adls",    ok: health?.checks.adls },
    { label: "Airflow", key: "airflow",       type: "airflow", ok: health?.checks.airflow },
    { label: "Spark",   key: "spark_connect", type: "spark",   ok: health?.checks.spark_connect },
    { label: "Trino",   key: "trino",         type: "trino",   ok: health?.checks.trino },
  ];

  const recentPipelines = [...pipelines]
    .sort((a, b) => {
      if (a.last_run_at && b.last_run_at)
        return new Date(b.last_run_at).getTime() - new Date(a.last_run_at).getTime();
      if (a.last_run_at) return -1;
      if (b.last_run_at) return 1;
      return a.dag_id.localeCompare(b.dag_id);
    })
    .slice(0, 14);

  function extractTag(tags: string[], prefix: string) {
    const t = tags.find(t => t.startsWith(`${prefix}:`));
    return t ? t.slice(prefix.length + 1) : null;
  }

  const LAYER_COLOR: Record<string, { bg: string; color: string }> = {
    bronze: { bg: "#fef3e2", color: "#b45309" },
    silver: { bg: "#f1f5f9", color: "#475569" },
    gold:   { bg: "#fefce8", color: "#854d0e" },
  };

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return (
    <div style={{ minHeight: "100%" }}>

      {/* ── Hero ── */}
      <div style={{
        background: `linear-gradient(135deg, ${primaryColor} 0%, #0f1e2e 100%)`,
        padding: "36px 1.5rem 40px",
      }}>
        <div style={{ maxWidth: 1400, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 32, flexWrap: "wrap" }}>

            {/* Platform identity */}
            <div style={{ flex: "1 1 420px" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "rgba(255,255,255,0.55)", letterSpacing: "0.02em", marginBottom: 6 }}>
                DSEng
              </div>
              <h1 style={{ fontSize: 34, fontWeight: 800, color: "#fff", margin: "0 0 10px", letterSpacing: "-0.025em", lineHeight: 1.1 }}>
                Platform Overview
              </h1>
              <p style={{ fontSize: 14, color: "rgba(255,255,255,0.55)", margin: "0 0 16px", lineHeight: 1.6, fontWeight: 400, maxWidth: 400 }}>
                Medallion data lakehouse on Azure Kubernetes Service — Bronze, Silver, and Gold layers on ADLS Gen2.
              </p>
              {role && (
                <span style={{
                  fontSize: 11, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "4px 10px", borderRadius: 5,
                  background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)",
                  border: "1px solid rgba(255,255,255,0.12)",
                }}>
                  <i className="fas fa-shield-halved" style={{ fontSize: 10 }} />
                  {role}
                </span>
              )}
            </div>

            {/* Service health — 2×2 grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignContent: "start", flexShrink: 0, minWidth: 300 }}>
              {services.map(s => {
                const ok = healthLoading ? null : s.ok;
                const dotColor  = ok === true ? "#4ade80" : ok === false ? "#f87171" : "#94a3b8";
                const dotLabel  = ok === true ? "Online"  : ok === false ? "Offline"  : "Checking";
                return (
                  <div key={s.key} style={{
                    background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)",
                    borderRadius: 10, padding: "12px 14px",
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <SvcIcon type={s.type} size={15} color="rgba(255,255,255,0.9)" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{s.label}</div>
                      <div style={{ fontSize: 11, color: dotColor, fontWeight: 600 }}>{dotLabel}</div>
                    </div>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flexShrink: 0,
                      boxShadow: ok === true ? "0 0 0 3px rgba(74,222,128,0.25)" : ok === false ? "0 0 0 3px rgba(248,113,113,0.25)" : "none" }} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "28px 1.5rem 64px" }}>

        {/* KPI tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>

          {/* Active pipelines */}
          <Link href="/pipelines" style={{ textDecoration: "none" }}>
            <div style={{
              background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
              borderLeft: "3px solid var(--forge-primary)",
              padding: "13px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 12,
            }}
              onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 14px rgba(0,0,0,0.08)"}
              onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"}
            >
              <div style={{ width: 38, height: 38, borderRadius: 9, background: "rgba(var(--forge-primary-rgb),0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <i className="fas fa-sitemap" style={{ color: "var(--forge-primary)", fontSize: 15 }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8" }}>Pipelines</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 1 }}>
                  <span style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em", lineHeight: 1 }}>
                    {pipelines.length > 0 ? activePipelines : "—"}
                  </span>
                  {pipelines.length > 0 && <span style={{ fontSize: 11, color: "#94a3b8" }}>/ {pipelines.length} total</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                  <span style={{ fontSize: 11, color: "#64748b" }}>
                    {pipelines.filter(p => p.is_paused).length > 0 ? `${pipelines.filter(p => p.is_paused).length} paused` : "all active"}
                  </span>
                  {failedPipelines > 0 && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "1px 6px", borderRadius: 10 }}>
                      <i className="fas fa-circle-exclamation" style={{ fontSize: 9 }} />{failedPipelines} failed
                    </span>
                  )}
                </div>
              </div>
            </div>
          </Link>

          {/* DQ pass rate */}
          {(() => {
            const dqColor = dqAvgRate === null ? "#94a3b8" : dqAvgRate >= 95 ? "#16a34a" : dqAvgRate >= 75 ? "#ca8a04" : "#dc2626";
            return (
              <Link href="/dq" style={{ textDecoration: "none" }}>
                <div style={{
                  background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
                  borderLeft: "3px solid var(--forge-primary)",
                  padding: "13px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 12,
                }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 14px rgba(0,0,0,0.08)"}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"}
                >
                  <div style={{ width: 38, height: 38, borderRadius: 9, background: "rgba(var(--forge-primary-rgb),0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <i className="fas fa-shield-halved" style={{ color: "var(--forge-primary)", fontSize: 15 }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8" }}>DQ Pass Rate</div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 1 }}>
                      <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1, color: dqColor }}>
                        {dqAvgRate !== null ? `${dqAvgRate}%` : "—"}
                      </span>
                      {dq.length > 0 && <span style={{ fontSize: 11, color: "#94a3b8" }}>{dq.length} datasets</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                      {dqFail > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626" }}>{dqFail} fail</span>}
                      {dqWarn > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#ca8a04" }}>{dqWarn} warn</span>}
                      {dqPass > 0 && <span style={{ fontSize: 10, color: "#16a34a" }}>{dqPass} pass</span>}
                      {dq.length === 0 && <span style={{ fontSize: 11, color: "#94a3b8" }}>No datasets monitored</span>}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })()}

          {/* Datasets in catalog */}
          <Link href="/datasets" style={{ textDecoration: "none" }}>
            <div style={{
              background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
              borderLeft: "3px solid var(--forge-primary)",
              padding: "13px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 12,
            }}
              onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 14px rgba(0,0,0,0.08)"}
              onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"}
            >
              <div style={{ width: 38, height: 38, borderRadius: 9, background: "rgba(var(--forge-primary-rgb),0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <i className="fas fa-layer-group" style={{ color: "var(--forge-primary)", fontSize: 15 }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8" }}>Datasets</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 1 }}>
                  <span style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em", lineHeight: 1 }}>
                    {dq.length > 0 ? dq.length : "—"}
                  </span>
                  {dq.length > 0 && <span style={{ fontSize: 11, color: "#94a3b8" }}>in catalog</span>}
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>Bronze · Silver · Gold</div>
              </div>
            </div>
          </Link>

          {/* Platform status */}
          {(() => {
            const stColor = healthLoading ? "#94a3b8" : platformOk ? "var(--forge-primary)" : "#dc2626";
            const stIcon  = healthLoading ? "fa-spinner fa-spin" : platformOk ? "fa-circle-check" : "fa-circle-exclamation";
            const stLabel = healthLoading ? "Checking…" : platformOk ? "Operational" : "Degraded";
            const offlineCount = Object.values(health?.checks ?? {}).filter(v => v === false).length;
            const stSub = healthLoading ? "Loading…"
              : platformOk ? "All services healthy"
              : `${offlineCount} service${offlineCount !== 1 ? "s" : ""} offline`;
            return (
              <Link href="/status" style={{ textDecoration: "none" }}>
                <div style={{
                  background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0",
                  borderLeft: "3px solid var(--forge-primary)",
                  padding: "13px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  display: "flex", alignItems: "center", gap: 12,
                }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 14px rgba(0,0,0,0.08)"}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"}
                >
                  <div style={{ width: 38, height: 38, borderRadius: 9, background: "rgba(var(--forge-primary-rgb),0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <i className={`fas ${stIcon}`} style={{ color: stColor, fontSize: 15 }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8" }}>Platform</div>
                    <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1, color: stColor, marginTop: 2 }}>{stLabel}</div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{stSub}</div>
                  </div>
                </div>
              </Link>
            );
          })()}
        </div>

        {/* Alerts — shown only when there are issues */}
        {(failedPipelines > 0 || dqIssues.length > 0) && (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
            {failedPipelines > 0 && (
              <Link href="/pipelines" style={{ textDecoration: "none", flex: 1, minWidth: 220 }}>
                <div style={{
                  background: "#fef2f2", border: "1px solid #fca5a5", borderLeft: "4px solid #ef4444",
                  borderRadius: 10, padding: "12px 16px",
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <i className="fas fa-circle-exclamation" style={{ color: "#dc2626", fontSize: 14 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#dc2626" }}>
                    {failedPipelines} pipeline{failedPipelines > 1 ? "s" : ""} failed
                  </span>
                  <i className="fas fa-arrow-right" style={{ color: "#fca5a5", fontSize: 11, marginLeft: "auto" }} />
                </div>
              </Link>
            )}
            {dqIssues.length > 0 && (
              <Link href="/dq" style={{ textDecoration: "none", flex: 1, minWidth: 220 }}>
                <div style={{
                  background: "#fef2f2", border: "1px solid #fca5a5", borderLeft: "4px solid #ef4444",
                  borderRadius: 10, padding: "12px 16px",
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <i className="fas fa-shield-halved" style={{ color: "#dc2626", fontSize: 14 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#dc2626" }}>
                    {dqIssues.length} dataset{dqIssues.length > 1 ? "s" : ""} with DQ issues
                  </span>
                  <i className="fas fa-arrow-right" style={{ color: "#fca5a5", fontSize: 11, marginLeft: "auto" }} />
                </div>
              </Link>
            )}
          </div>
        )}

        {/* Main 2-column layout */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 24, alignItems: "stretch" }}>

          {/* Pipeline activity */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#94a3b8" }}>
                Pipeline Activity
                {pipelines.length > 0 && (
                  <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#cbd5e1", marginLeft: 6 }}>
                    ({pipelines.length})
                  </span>
                )}
              </div>
              <Link href="/pipelines" style={{ fontSize: 12, color: "var(--forge-primary)", textDecoration: "none", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                View all <i className="fas fa-arrow-right" style={{ fontSize: 10 }} />
              </Link>
            </div>
            <div style={{ flex: 1, background: "#fff", border: "1px solid #e2e8f0", borderTop: "3px solid var(--forge-primary)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", display: "flex", flexDirection: "column" }}>
              {pipelines.length === 0 ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", color: "#94a3b8", fontSize: 13 }}>
                  <i className="fas fa-sitemap" style={{ fontSize: 26, opacity: 0.25, display: "block", marginBottom: 12 }} />
                  No pipelines registered yet
                </div>
              ) : (
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {/* Table header */}
                  <div style={{
                    display: "grid", gridTemplateColumns: "1fr 120px 100px 110px",
                    padding: "8px 16px", borderBottom: "1px solid #f1f5f9",
                    background: "#fafbfc",
                  }}>
                    {["Pipeline", "Resources", "Schedule", "Status"].map(h => (
                      <div key={h} style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8" }}>{h}</div>
                    ))}
                  </div>
                  {/* Rows */}
                  {recentPipelines.map((p, idx) => {
                    const s = p.last_run_state
                      ? STATE_STYLE[p.last_run_state] ?? { bg: "#f1f5f9", color: "#64748b", label: p.last_run_state }
                      : null;
                    const neverRun  = !p.last_run_state;
                    const layer     = extractTag(p.tags, "layer");
                    const output    = extractTag(p.tags, "output");
                    const executors = extractTag(p.tags, "executors");
                    const execCores = extractTag(p.tags, "exec_cores");
                    const execMem   = extractTag(p.tags, "exec_mem");
                    const lc = layer ? LAYER_COLOR[layer] ?? { bg: "#f1f5f9", color: "#64748b" } : null;
                    const scheduleLabel = !p.schedule || p.schedule === "None" ? "—"
                      : p.schedule === "@daily"   ? "Daily"
                      : p.schedule === "@hourly"  ? "Hourly"
                      : p.schedule === "@weekly"  ? "Weekly"
                      : p.schedule;
                    const dotColor = p.is_paused ? "#94a3b8" : neverRun ? "#d1d5db" : (s?.color ?? "#94a3b8");
                    return (
                      <Link
                        key={p.dag_id}
                        href="/pipelines"
                        style={{
                          textDecoration: "none",
                          display: "grid", gridTemplateColumns: "1fr 120px 100px 110px",
                          alignItems: "center",
                          padding: "11px 16px",
                          borderBottom: idx < recentPipelines.length - 1 ? "1px solid #f8fafc" : "none",
                          background: "#fff",
                        }}
                        onMouseEnter={e => (e.currentTarget as HTMLAnchorElement).style.background = "#f8fafc"}
                        onMouseLeave={e => (e.currentTarget as HTMLAnchorElement).style.background = "#fff"}
                      >
                        {/* Col 1: name + source */}
                        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{
                            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                            background: dotColor,
                            boxShadow: (!p.is_paused && !neverRun && s) ? `0 0 0 3px ${s.color}22` : "none",
                          }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 14, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {p.dag_id}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 3 }}>
                              {lc && layer && (
                                <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: lc.bg, color: lc.color }}>
                                  {layer}
                                </span>
                              )}
                              {output && (
                                <span style={{ fontSize: 12, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {output}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Col 2: resources */}
                        <div
                          style={{ fontSize: 13, color: "#475569", fontVariantNumeric: "tabular-nums", cursor: executors ? "default" : undefined }}
                          title={executors ? `${executors} executor instance${Number(executors) !== 1 ? "s" : ""} · ${execCores} cores each · ${execMem} memory per executor` : undefined}
                        >
                          {executors
                            ? <><i className="fas fa-microchip" style={{ fontSize: 10, marginRight: 4, color: "#94a3b8" }} />{executors}×{execCores}c {execMem}</>
                            : <span style={{ color: "#d1d5db" }}>—</span>
                          }
                        </div>

                        {/* Col 3: schedule */}
                        <div style={{ fontSize: 13, color: "#64748b" }}>
                          {scheduleLabel === "—"
                            ? <span style={{ color: "#d1d5db" }}>—</span>
                            : <><i className="fas fa-clock" style={{ fontSize: 10, marginRight: 4, color: "#94a3b8" }} />{scheduleLabel}</>
                          }
                        </div>

                        {/* Col 4: status + time */}
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                          {p.is_paused ? (
                            <span style={{ fontSize: 12, color: "#94a3b8" }}>Paused</span>
                          ) : neverRun ? (
                            <span style={{ fontSize: 12, color: "#94a3b8" }}>Never run</span>
                          ) : s ? (
                            <span style={{ fontSize: 12, fontWeight: 700, color: s.color }}>{s.label}</span>
                          ) : null}
                          {p.last_run_at && (
                            <span style={{ fontSize: 11, color: "#94a3b8" }}>{timeAgo(p.last_run_at)}</span>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* DQ Health card */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#94a3b8" }}>
                  Data Quality
                </div>
                <Link href="/dq" style={{ fontSize: 12, color: "var(--forge-primary)", textDecoration: "none", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                  View all <i className="fas fa-arrow-right" style={{ fontSize: 10 }} />
                </Link>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderTop: "3px solid var(--forge-primary)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", padding: "18px 18px 16px" }}>
                {dq.length === 0 ? (
                  <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, padding: "16px 0" }}>
                    <i className="fas fa-shield-halved" style={{ fontSize: 22, opacity: 0.25, display: "block", marginBottom: 10 }} />
                    No DQ results yet
                  </div>
                ) : (
                  <>
                    {dqAvgRate !== null && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#64748b" }}>Overall pass rate</span>
                          <span style={{ fontSize: 15, fontWeight: 900, color: dqAvgRate >= 95 ? "#16a34a" : dqAvgRate >= 75 ? "#ca8a04" : "#dc2626" }}>
                            {dqAvgRate}%
                          </span>
                        </div>
                        <div style={{ height: 6, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" }}>
                          <div style={{
                            width: `${dqAvgRate}%`, height: "100%", borderRadius: 4,
                            background: dqAvgRate >= 95 ? "#16a34a" : dqAvgRate >= 75 ? "#ca8a04" : "#dc2626",
                            transition: "width 0.6s ease",
                          }} />
                        </div>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      {([
                        { label: "Passing",   count: dqPass,      color: "#16a34a", bg: "#f0fdf4" },
                        { label: "Failing",   count: dqFail,      color: "#dc2626", bg: "#fef2f2" },
                        { label: "Warning",   count: dqWarn,      color: "#ca8a04", bg: "#fefce8" },
                        { label: "Profiling", count: dqMonitored, color: "#64748b", bg: "#f8fafc" },
                      ] as const).map(item => (
                        <div key={item.label} style={{
                          background: item.bg, borderRadius: 8, padding: "10px 12px",
                          border: `1px solid ${item.color}20`,
                        }}>
                          <div style={{ fontSize: 20, fontWeight: 900, color: item.color, lineHeight: 1 }}>{item.count}</div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{item.label}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Explore panel */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 12 }}>
                Explore
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {([
                  { href: "/pipelines",     icon: "fa-sitemap",          label: "Pipelines",        sublabel: "DAG runs & schedule" },
                  { href: "/dq",            icon: "fa-shield-halved",    label: "Data Quality",     sublabel: "Pass rates & rule results" },
                  { href: "/datasets",      icon: "fa-layer-group",      label: "Datasets",         sublabel: "Bronze · Silver · Gold catalog" },
                  { href: "/lineage",       icon: "fa-share-nodes",      label: "Lineage",          sublabel: "Upstream / downstream graph" },
                  { href: "/datasources",   icon: "fa-plug",             label: "Data Sources",     sublabel: "External source registry" },
                  { href: "/cost",          icon: "fa-coins",            label: "Cost Explorer",    sublabel: "Azure spend by resource group" },
                  { href: "/observability", icon: "fa-chart-line",       label: "Observability",    sublabel: "Grafana · Azure Monitor" },
                  { href: "/status",        icon: "fa-server",           label: "Cluster Status",   sublabel: "AKS pods & node pools" },
                ] as const).map(item => (
                  <Link key={item.href} href={item.href} style={{ textDecoration: "none" }}>
                    <div
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "9px 12px", borderRadius: 9,
                        background: "#fff", border: "1px solid #e2e8f0",
                        cursor: "pointer",
                      }}
                      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = "#f8fafc"}
                      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = "#fff"}
                    >
                      <div style={{
                        width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                        background: "rgba(var(--forge-primary-rgb),0.06)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <i className={`fas ${item.icon}`} style={{ color: "var(--forge-primary)", fontSize: 11 }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{item.label}</div>
                        <div style={{ fontSize: 10, color: "#94a3b8" }}>{item.sublabel}</div>
                      </div>
                      <i className="fas fa-chevron-right" style={{ color: "#e2e8f0", fontSize: 10, flexShrink: 0 }} />
                    </div>
                  </Link>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
