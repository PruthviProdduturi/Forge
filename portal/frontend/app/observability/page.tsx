"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";

const ACCENT = "#0ea5e9";

interface HealthData {
  status: "ok" | "degraded";
  env: string;
  checks: {
    airflow: boolean;
    trino: boolean;
    adls: boolean;
  };
}

const SERVICE_META = [
  {
    key: "airflow" as const,
    label: "Airflow",
    description: "Workflow orchestration scheduler",
    icon: "fa-calendar-check",
    okColor: "#059669",
    errColor: "#dc2626",
  },
  {
    key: "trino" as const,
    label: "Trino",
    description: "Distributed SQL query engine",
    icon: "fa-bolt",
    okColor: "#059669",
    errColor: "#dc2626",
  },
  {
    key: "adls" as const,
    label: "ADLS Gen2",
    description: "Azure Data Lake Storage Gen2",
    icon: "fa-hard-drive",
    okColor: "#059669",
    errColor: "#dc2626",
  },
];

const EXTERNAL_LINKS = [
  {
    label: "Azure Monitor",
    href: "https://portal.azure.com/#blade/Microsoft_Azure_Monitoring/AzureMonitoringBrowseBlade",
    icon: "fa-chart-area",
    description: "Metrics, logs, and alerts",
  },
  {
    label: "Managed Grafana",
    href: "https://grafana-forge-dev.azmk8s.io",
    icon: "fa-chart-line",
    description: "Dashboards and visualisations",
  },
  {
    label: "Log Analytics",
    href: "https://portal.azure.com/#blade/Microsoft_Azure_Monitoring/AzureMonitoringBrowseBlade/logAnalytics",
    icon: "fa-file-lines",
    description: "Query and explore logs",
  },
];

export default function ObservabilityPage() {
  const { getToken } = useAuth();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  async function fetchHealth() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<HealthData>("/api/health", getToken);
      setHealth(data);
      setLastChecked(new Date());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHealth();
    // Refresh every 30 seconds
    const interval = setInterval(fetchHealth, 30_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allOk = health?.status === "ok";

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #f8faff 0%, #eef2f7 100%)" }}>
      {/* Hero */}
      <div style={{
        background: `linear-gradient(135deg, ${ACCENT} 0%, #0f172a 100%)`,
        padding: "48px 1.5rem 40px",
      }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 11, background: "rgba(255,255,255,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <i className="fas fa-chart-line" style={{ color: "#fff", fontSize: 18 }} />
            </div>
            <h1 style={{ fontSize: "clamp(1.6rem,3.5vw,2.2rem)", fontWeight: 800, color: "#fff", margin: 0, letterSpacing: "-0.02em" }}>
              Observability
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.7)", margin: 0, fontSize: 15 }}>
            Platform health, cluster metrics, and infrastructure monitoring
          </p>

          {/* Overall status pill */}
          {!loading && health && (
            <div style={{ marginTop: 20 }}>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "6px 16px", borderRadius: 20,
                background: allOk ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)",
                border: `1px solid ${allOk ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`,
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: allOk ? "#22c55e" : "#ef4444",
                  boxShadow: `0 0 0 3px ${allOk ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
                  {allOk ? "All Systems Operational" : "Degraded — See Below"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 1.5rem 60px" }}>
        {/* Refresh / last checked */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "#94a3b8" }}>
            Service Health
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {lastChecked && (
              <span style={{ fontSize: 12, color: "#94a3b8" }}>
                Last checked: {lastChecked.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={fetchHealth}
              disabled={loading}
              style={{
                padding: "5px 12px", borderRadius: 8, border: "1px solid #e2e8f0",
                background: "#fff", color: "#64748b", fontSize: 12, fontWeight: 600,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
              }}
            >
              <i className={`fas ${loading ? "fa-spinner fa-spin" : "fa-rotate-right"}`} style={{ fontSize: 11 }} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div style={{
            background: "#fff", border: "1px solid #fca5a5", borderTop: "3px solid #ef4444",
            borderRadius: 12, padding: "20px 24px", color: "#dc2626", marginBottom: 24,
          }}>
            <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
            {error}
          </div>
        )}

        {/* Service status cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16, marginBottom: 36 }}>
          {SERVICE_META.map(svc => {
            const isOk = health?.checks[svc.key] ?? false;
            const color = loading ? "#94a3b8" : (isOk ? svc.okColor : svc.errColor);
            return (
              <div
                key={svc.key}
                style={{
                  background: "#fff", border: "1px solid #e2e8f0",
                  borderTop: `3px solid ${color}`, borderRadius: 12,
                  padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: `${color}15`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <i className={`fas ${svc.icon}`} style={{ color, fontSize: 16 }} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{svc.label}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{svc.description}</div>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {loading ? (
                    <>
                      <i className="fas fa-spinner fa-spin" style={{ color: "#94a3b8", fontSize: 12 }} />
                      <span style={{ fontSize: 13, color: "#94a3b8" }}>Checking…</span>
                    </>
                  ) : (
                    <>
                      <span style={{
                        width: 9, height: 9, borderRadius: "50%",
                        background: color,
                        boxShadow: `0 0 0 3px ${color}30`,
                      }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color }}>
                        {isOk ? "Healthy" : "Unreachable"}
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* External links */}
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: "0.09em",
          textTransform: "uppercase", color: "#94a3b8", marginBottom: 14,
        }}>
          Monitoring & Dashboards
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
          {EXTERNAL_LINKS.map(link => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <div
                style={{
                  background: "#fff", border: "1px solid #e2e8f0",
                  borderTop: `3px solid ${ACCENT}`, borderRadius: 12,
                  padding: "16px 18px", cursor: "pointer",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  transition: "box-shadow 0.15s, transform 0.15s",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = "0 6px 20px rgba(0,0,0,0.1)";
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: `${ACCENT}15`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <i className={`fas ${link.icon}`} style={{ color: ACCENT, fontSize: 13 }} />
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>{link.label}</span>
                  <i className="fas fa-arrow-up-right-from-square" style={{ marginLeft: "auto", color: "#cbd5e1", fontSize: 11 }} />
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>{link.description}</div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
