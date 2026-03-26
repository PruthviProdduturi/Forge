"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";

const ACCENT = "#d97706";

interface DQSummary {
  dataset: string;
  total_runs: number;
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

function StatusBadge({ status }: { status: "PASS" | "FAIL" | "WARN" }) {
  const styles = {
    PASS: { bg: "#dcfce7", color: "#16a34a" },
    FAIL: { bg: "#fee2e2", color: "#dc2626" },
    WARN: { bg: "#fef9c3", color: "#ca8a04" },
  };
  const s = styles[status] ?? { bg: "#f1f5f9", color: "#64748b" };
  return (
    <span style={{
      padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 700,
      background: s.bg, color: s.color,
    }}>
      {status}
    </span>
  );
}

function PassRateBar({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  const color = pct >= 95 ? "#22c55e" : pct >= 80 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color, minWidth: 36, textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );
}

export default function DataQualityPage() {
  const { getToken } = useAuth();
  const [summary, setSummary] = useState<DQSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<DQSummary[]>("/api/dq/summary", getToken)
      .then(setSummary)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [getToken]);

  const totalDatasets = summary.length;
  const overallPassRate = summary.length
    ? summary.reduce((acc, d) => acc + d.pass_rate, 0) / summary.length
    : 0;
  const criticalCount = summary.filter(d => d.critical_failures > 0).length;

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
              <i className="fas fa-shield-halved" style={{ color: "#fff", fontSize: 18 }} />
            </div>
            <h1 style={{ fontSize: "clamp(1.6rem,3.5vw,2.2rem)", fontWeight: 800, color: "#fff", margin: 0, letterSpacing: "-0.02em" }}>
              Data Quality
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.7)", margin: 0, fontSize: 15 }}>
            Monitor DQ rules, pass rates, and critical gate failures
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 1.5rem 60px" }}>
        {/* Summary bar */}
        {!loading && !error && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 16, marginBottom: 32,
          }}>
            {[
              { label: "Datasets Monitored", value: totalDatasets, icon: "fa-database", color: ACCENT },
              { label: "Overall Pass Rate", value: `${Math.round(overallPassRate * 100)}%`, icon: "fa-check-circle", color: overallPassRate >= 0.95 ? "#22c55e" : overallPassRate >= 0.8 ? "#f59e0b" : "#ef4444" },
              { label: "With Critical Failures", value: criticalCount, icon: "fa-circle-xmark", color: criticalCount > 0 ? "#ef4444" : "#22c55e" },
            ].map(s => (
              <div key={s.label} style={{
                background: "#fff", border: "1px solid #e2e8f0",
                borderTop: `3px solid ${s.color}`, borderRadius: 12,
                padding: "18px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: `${s.color}15`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <i className={`fas ${s.icon}`} style={{ color: s.color, fontSize: 14 }} />
                  </div>
                  <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>{s.label}</span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#0f172a" }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
            <i className="fas fa-spinner fa-spin" style={{ fontSize: 28, marginBottom: 12, display: "block" }} />
            Loading DQ data…
          </div>
        )}

        {error && (
          <div style={{
            background: "#fff", border: "1px solid #fca5a5", borderTop: "3px solid #ef4444",
            borderRadius: 12, padding: "20px 24px", color: "#dc2626",
          }}>
            <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
            {error}
          </div>
        )}

        {!loading && !error && summary.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
            <i className="fas fa-shield-halved" style={{ fontSize: 32, marginBottom: 12, display: "block" }} />
            No DQ data available yet
          </div>
        )}

        {!loading && !error && summary.length > 0 && (
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderTop: `3px solid ${ACCENT}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                  {["Dataset", "Pass Rate", "Status", "Last Run", "Critical Failures", "Warnings"].map(h => (
                    <th key={h} style={{
                      padding: "10px 16px", textAlign: "left",
                      fontSize: 11, fontWeight: 700, color: "#94a3b8",
                      textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.map((d, idx) => (
                  <tr
                    key={d.dataset}
                    style={{
                      borderBottom: idx < summary.length - 1 ? "1px solid #f8fafc" : "none",
                      background: idx % 2 === 0 ? "#fff" : "#fafbfc",
                    }}
                  >
                    <td style={{ padding: "14px 16px" }}>
                      <div style={{ fontWeight: 600, color: "#0f172a", fontSize: 14 }}>{d.dataset}</div>
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>{d.total_runs} runs</div>
                    </td>
                    <td style={{ padding: "14px 16px", minWidth: 160 }}>
                      <PassRateBar rate={d.pass_rate} />
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      <StatusBadge status={d.last_status} />
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 13, color: "#64748b", whiteSpace: "nowrap" }}>
                      {timeAgo(d.last_run_at)}
                    </td>
                    <td style={{ padding: "14px 16px", textAlign: "center" }}>
                      {d.critical_failures > 0 ? (
                        <span style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          padding: "2px 10px", borderRadius: 12, fontSize: 13, fontWeight: 700,
                          background: "#fee2e2", color: "#dc2626",
                        }}>
                          <i className="fas fa-circle-exclamation" style={{ fontSize: 10 }} />
                          {d.critical_failures}
                        </span>
                      ) : (
                        <span style={{ color: "#94a3b8", fontSize: 13 }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "14px 16px", textAlign: "center" }}>
                      {d.warnings > 0 ? (
                        <span style={{
                          padding: "2px 10px", borderRadius: 12, fontSize: 13, fontWeight: 700,
                          background: "#fef9c3", color: "#ca8a04",
                        }}>
                          {d.warnings}
                        </span>
                      ) : (
                        <span style={{ color: "#94a3b8", fontSize: 13 }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
