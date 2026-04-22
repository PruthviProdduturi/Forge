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
  pass_rate: number;
  last_run_at: string;
  critical_failures: number;
  warnings: number;
  last_status: "PASS" | "FAIL" | "WARN";
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

function getGreeting(name: string): { salutation: string; sub: string } {
  const h = new Date().getHours();
  const first = name.split(" ")[0];
  const salutation =
    h < 12 ? `Good morning, ${first}`
    : h < 17 ? `Good afternoon, ${first}`
    : `Good evening, ${first}`;
  const sub =
    h < 12 ? "Here's what your pipelines have been up to overnight."
    : h < 17 ? "Live snapshot of your Forge platform."
    : "Wrapping up? Here's your platform status.";
  return { salutation, sub };
}

const STATE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  success: { bg: "#dcfce7", color: "#16a34a", label: "Success" },
  failed:  { bg: "#fee2e2", color: "#dc2626", label: "Failed" },
  running: { bg: "#fef9c3", color: "#ca8a04", label: "Running" },
  queued:  { bg: "#e0f2fe", color: "#0284c7", label: "Queued" },
};

const DQ_STYLE = {
  PASS: { bg: "#dcfce7", color: "#16a34a" },
  FAIL: { bg: "#fee2e2", color: "#dc2626" },
  WARN: { bg: "#fef9c3", color: "#ca8a04" },
};

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

  const { salutation, sub } = getGreeting(user?.name ?? "there");
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Status badges for hero
  const computeOk: boolean | null = !health ? null
    : health.checks.trino === true || health.checks.spark_connect === true ? true
    : health.checks.trino === false || health.checks.spark_connect === false ? false
    : null;

  const statusItems = [
    { label: "ADLS", ok: health?.checks.adls ?? null, icon: "fa-hard-drive" },
    { label: "Airflow", ok: health?.checks.airflow ?? null, icon: "fa-calendar-check" },
    { label: "Spark", ok: health?.checks.spark_connect ?? null, icon: "fa-fire-flame-curved" },
    { label: "Trino", ok: health?.checks.trino ?? null, icon: "fa-database" },
  ];

  // All pipelines: those with runs sorted desc first, then unrun ones alphabetically
  const recentPipelines = [...pipelines]
    .sort((a, b) => {
      if (a.last_run_at && b.last_run_at)
        return new Date(b.last_run_at).getTime() - new Date(a.last_run_at).getTime();
      if (a.last_run_at) return -1;
      if (b.last_run_at) return 1;
      return a.dag_id.localeCompare(b.dag_id);
    })
    .slice(0, 10);

  // DQ issues — FAIL or WARN status or has critical failures
  const dqIssues = dq.filter(d => d.last_status !== "PASS" || d.critical_failures > 0);
  const dqHealthy = dq.length > 0 && dqIssues.length === 0;

  const failedPipelines = pipelines.filter(p => p.last_run_state === "failed").length;

  return (
    <div style={{ minHeight: "100%" }}>

      {/* ── Hero ── */}
      <div style={{
        background: `linear-gradient(135deg, ${primaryColor} 0%, #0f1e2e 100%)`,
        padding: "48px 1.5rem 48px",
      }}>
        <div style={{ maxWidth: 1400, margin: "0 auto" }}>
          <div style={{ marginBottom: 8 }}>
            <h1 style={{ fontSize: "2rem", fontWeight: 800, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1.2, margin: "0 0 8px 0" }}>
              {salutation}
            </h1>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", maxWidth: 560, lineHeight: 1.6, margin: 0 }}>
              {sub} &mdash; <span style={{ opacity: 0.6 }}>{today}</span>
            </p>
          </div>

          {/* Status pills */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 20, minHeight: 36 }}>
            {role && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "5px 12px", borderRadius: 20,
                background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
                fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.85)",
              }}>
                <i className="fas fa-shield-halved" style={{ fontSize: 10 }} />
                {role}
              </div>
            )}
            <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.2)", margin: "0 4px" }} />
            {statusItems.map(s => {
              const ok = healthLoading ? null : s.ok;
              const dotColor = ok === true ? "#4ade80" : ok === false ? "#f87171" : "#94a3b8";
              const textColor = ok === true ? "rgba(255,255,255,0.9)" : ok === false ? "#fca5a5" : "rgba(255,255,255,0.5)";
              return (
                <div key={s.label} style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 12px", borderRadius: 20,
                  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)",
                  fontSize: 12, fontWeight: 600, color: textColor,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                  {s.label}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "28px 1.5rem 60px" }}>

        {/* Platform stats row */}
        {pipelines.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
            {[
              { label: "Total Pipelines", value: pipelines.length, icon: "fa-sitemap", color: "var(--forge-primary)" },
              { label: "Active", value: pipelines.filter(p => p.is_active && !p.is_paused).length, icon: "fa-circle-play", color: "#16a34a" },
              { label: "Paused", value: pipelines.filter(p => p.is_paused).length, icon: "fa-pause-circle", color: "#94a3b8" },
              { label: "Failed", value: pipelines.filter(p => p.last_run_state === "failed").length, icon: "fa-circle-xmark", color: "#dc2626" },
            ].map(s => (
              <div key={s.label} style={{
                background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
                padding: "14px 18px", display: "flex", alignItems: "center", gap: 12,
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: `${s.color}14`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <i className={`fas ${s.icon}`} style={{ color: s.color, fontSize: 13 }} />
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", lineHeight: 1 }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, marginTop: 2 }}>{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Alert bar — only when there are problems */}
        {(failedPipelines > 0 || dqIssues.length > 0) && (
          <div style={{
            display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24,
          }}>
            {failedPipelines > 0 && (
              <Link href="/pipelines" style={{ textDecoration: "none", flex: 1, minWidth: 200 }}>
                <div style={{
                  background: "#fef2f2", border: "1px solid #fca5a5", borderLeft: "3px solid #ef4444",
                  borderRadius: 10, padding: "12px 16px",
                  display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
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
              <Link href="/dq" style={{ textDecoration: "none", flex: 1, minWidth: 200 }}>
                <div style={{
                  background: "#fef2f2", border: "1px solid #fca5a5", borderLeft: "3px solid #ef4444",
                  borderRadius: 10, padding: "12px 16px",
                  display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
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

        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 24, alignItems: "start" }}>

          {/* ── Recent Pipeline Activity ── */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "#94a3b8" }}>
                Pipelines {pipelines.length > 0 && <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#cbd5e1" }}>({pipelines.length})</span>}
              </div>
              <Link href="/pipelines" style={{ fontSize: 12, color: "var(--forge-primary)", textDecoration: "none", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                View all <i className="fas fa-arrow-right" style={{ fontSize: 10 }} />
              </Link>
            </div>
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderTop: "3px solid var(--forge-primary)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              {pipelines.length === 0 ? (
                <div style={{ padding: "32px 20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                  No pipelines registered yet
                </div>
              ) : (
                recentPipelines.map((p, idx) => {
                  const s = p.last_run_state ? STATE_STYLE[p.last_run_state] ?? { bg: "#f1f5f9", color: "#64748b", label: p.last_run_state } : null;
                  const neverRun = !p.last_run_state;
                  return (
                    <Link key={p.dag_id} href="/pipelines" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 12,
                      padding: "12px 16px",
                      borderBottom: idx < recentPipelines.length - 1 ? "1px solid #f8fafc" : "none",
                      background: idx % 2 === 0 ? "#fff" : "#fafbfc",
                      cursor: "pointer",
                    }}
                      onMouseEnter={e => (e.currentTarget as HTMLAnchorElement).style.background = "#f0f9ff"}
                      onMouseLeave={e => (e.currentTarget as HTMLAnchorElement).style.background = idx % 2 === 0 ? "#fff" : "#fafbfc"}
                    >
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                        background: p.is_paused ? "#94a3b8" : neverRun ? "#d1d5db" : (s?.color ?? "#94a3b8"),
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: neverRun ? "#64748b" : "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {p.dag_id}
                        </div>
                        {p.tags[0] && (
                          <div style={{ fontSize: 11, color: "#94a3b8" }}>{p.tags[0]}</div>
                        )}
                      </div>
                      {neverRun ? (
                        <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: "#f1f5f9", color: "#94a3b8", whiteSpace: "nowrap" }}>
                          Never run
                        </span>
                      ) : s ? (
                        <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>
                          {s.label}
                        </span>
                      ) : null}
                      <span style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "nowrap", minWidth: 52, textAlign: "right" }}>
                        {timeAgo(p.last_run_at)}
                      </span>
                    </Link>
                  );
                })
              )}
            </div>
          </div>

          {/* ── Right column ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

            {/* DQ Status */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "#94a3b8" }}>
                  Data Quality
                </div>
                <Link href="/dq" style={{ fontSize: 12, color: "var(--forge-primary)", textDecoration: "none", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                  View all <i className="fas fa-arrow-right" style={{ fontSize: 10 }} />
                </Link>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderTop: "3px solid var(--forge-primary)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                {dq.length === 0 ? (
                  <div style={{ padding: "20px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <i className="fas fa-shield-halved" style={{ color: "#cbd5e1", fontSize: 15 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8" }}>No DQ results yet</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>
                      DQ rules run as pipeline steps. Results appear here after your first pipeline completes.
                    </p>
                  </div>
                ) : dqHealthy ? (
                  <div style={{ padding: "20px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                    <i className="fas fa-circle-check" style={{ color: "#16a34a", fontSize: 18 }} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a" }}>All datasets passing</div>
                      <div style={{ fontSize: 12, color: "#64748b" }}>{dq.length} monitored</div>
                    </div>
                  </div>
                ) : (
                  dqIssues.slice(0, 6).map((d, idx) => {
                    const s = DQ_STYLE[d.last_status];
                    return (
                      <div key={d.dataset} style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                        borderBottom: idx < Math.min(dqIssues.length, 6) - 1 ? "1px solid #f8fafc" : "none",
                        background: idx % 2 === 0 ? "#fff" : "#fafbfc",
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {d.dataset}
                          </div>
                          {d.critical_failures > 0 && (
                            <div style={{ fontSize: 11, color: "#dc2626" }}>{d.critical_failures} critical</div>
                          )}
                        </div>
                        <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>
                          {d.last_status}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Platform quick links */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 12 }}>
                Jump To
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { href: "/datasources", icon: "fa-plug",          label: "Data Sources" },
                  { href: "/lineage",     icon: "fa-share-nodes",   label: "Lineage" },
                  { href: "/cost",        icon: "fa-coins",          label: "Cost" },
                  { href: "/observability", icon: "fa-chart-line",  label: "Observability" },
                  { href: "/settings",    icon: "fa-server",         label: "Platform Settings" },
                ].map(item => (
                  <Link key={item.href} href={item.href} style={{ textDecoration: "none" }}>
                    <div style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "9px 14px", borderRadius: 9,
                      background: "#fff", border: "1px solid #e2e8f0",
                      fontSize: 13, color: "#374151", fontWeight: 500,
                      transition: "background 0.1s",
                    }}
                      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = "#f8fafc"}
                      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = "#fff"}
                    >
                      <i className={`fas ${item.icon}`} style={{ color: "var(--forge-primary)", fontSize: 12, width: 14, textAlign: "center" }} />
                      {item.label}
                      <i className="fas fa-arrow-right" style={{ color: "#cbd5e1", fontSize: 10, marginLeft: "auto" }} />
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
