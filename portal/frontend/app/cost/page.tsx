"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";

const ACCENT = "#e25a1c";

interface CostSummary {
  total_cost: number;
  currency: string;
  period_days: number;
  top_resource_types: { resource_type: string; cost: number; currency: string }[];
}

interface PipelineCost {
  pipeline: string;
  cost: number;
  currency: string;
}

function formatCurrency(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export default function CostPage() {
  const { getToken } = useAuth();
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [byPipeline, setByPipeline] = useState<PipelineCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch<CostSummary>(`/api/cost/summary?days=${days}`, getToken),
      apiFetch<PipelineCost[]>(`/api/cost/by-pipeline?days=${days}`, getToken),
    ])
      .then(([s, p]) => { setSummary(s); setByPipeline(p); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [getToken, days]);

  const maxPipelineCost = byPipeline.length ? Math.max(...byPipeline.map(p => p.cost)) : 1;
  const maxResourceCost = summary?.top_resource_types.length
    ? Math.max(...summary.top_resource_types.map(r => r.cost))
    : 1;

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
              <i className="fas fa-coins" style={{ color: "#fff", fontSize: 18 }} />
            </div>
            <h1 style={{ fontSize: "clamp(1.6rem,3.5vw,2.2rem)", fontWeight: 800, color: "#fff", margin: 0, letterSpacing: "-0.02em" }}>
              Cost Explorer
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.7)", margin: 0, fontSize: 15 }}>
            Track pipeline compute costs and Azure resource spend
          </p>

          {/* Period selector */}
          <div style={{ display: "flex", gap: 6, marginTop: 20 }}>
            {[7, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                style={{
                  padding: "5px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.3)",
                  background: days === d ? "rgba(255,255,255,0.25)" : "transparent",
                  color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
                }}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 1.5rem 60px" }}>
        {loading && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
            <i className="fas fa-spinner fa-spin" style={{ fontSize: 28, marginBottom: 12, display: "block" }} />
            Loading cost data…
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

        {!loading && !error && summary && (
          <>
            {/* Total spend card */}
            <div style={{ marginBottom: 28 }}>
              <div style={{
                background: "#fff", border: "1px solid #e2e8f0",
                borderTop: `3px solid ${ACCENT}`, borderRadius: 12,
                padding: "24px 28px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                display: "inline-block", minWidth: 280,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em", color: "#94a3b8", marginBottom: 8 }}>
                  Total Spend — Last {summary.period_days} Days
                </div>
                <div style={{ fontSize: 42, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" }}>
                  {formatCurrency(summary.total_cost, summary.currency)}
                </div>
                <div style={{ marginTop: 6, fontSize: 13, color: "#64748b" }}>
                  <i className="fas fa-calendar" style={{ marginRight: 6 }} />
                  {summary.period_days}-day window
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
              {/* Top resource types */}
              <div style={{
                background: "#fff", border: "1px solid #e2e8f0",
                borderTop: `3px solid ${ACCENT}`, borderRadius: 12,
                padding: "20px 24px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 18 }}>
                  <i className="fas fa-cloud" style={{ marginRight: 8, color: ACCENT }} />
                  Top Resource Types
                </div>
                {summary.top_resource_types.length === 0 && (
                  <div style={{ color: "#94a3b8", fontSize: 13 }}>No data available</div>
                )}
                {summary.top_resource_types.map((r, i) => {
                  const pct = maxResourceCost > 0 ? (r.cost / maxResourceCost) * 100 : 0;
                  const label = r.resource_type.split("/").pop() ?? r.resource_type;
                  return (
                    <div key={r.resource_type} style={{ marginBottom: i < summary.top_resource_types.length - 1 ? 14 : 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 13, color: "#334155", fontWeight: 500 }} title={r.resource_type}>
                          {label}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                          {formatCurrency(r.cost, r.currency)}
                        </span>
                      </div>
                      <div style={{ height: 8, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{
                          width: `${pct}%`, height: "100%",
                          background: `linear-gradient(90deg, ${ACCENT}, #f97316)`,
                          borderRadius: 4, transition: "width 0.5s ease",
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Cost by pipeline */}
              <div style={{
                background: "#fff", border: "1px solid #e2e8f0",
                borderTop: `3px solid ${ACCENT}`, borderRadius: 12,
                padding: "20px 24px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 18 }}>
                  <i className="fas fa-sitemap" style={{ marginRight: 8, color: ACCENT }} />
                  Cost by Pipeline
                </div>
                {byPipeline.length === 0 && (
                  <div style={{ color: "#94a3b8", fontSize: 13 }}>
                    No pipeline tags found. Tag your Azure resources with{" "}
                    <code style={{ fontFamily: "monospace", background: "#f1f5f9", padding: "1px 5px", borderRadius: 4 }}>
                      pipeline=&lt;name&gt;
                    </code>{" "}
                    to see cost attribution.
                  </div>
                )}
                {byPipeline.map((p, i) => {
                  const pct = maxPipelineCost > 0 ? (p.cost / maxPipelineCost) * 100 : 0;
                  return (
                    <div key={p.pipeline} style={{ marginBottom: i < byPipeline.length - 1 ? 14 : 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 13, color: "#334155", fontWeight: 500 }}>
                          <i className="fas fa-circle" style={{ fontSize: 7, marginRight: 6, color: ACCENT }} />
                          {p.pipeline}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                          {formatCurrency(p.cost, p.currency)}
                        </span>
                      </div>
                      <div style={{ height: 8, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{
                          width: `${pct}%`, height: "100%",
                          background: `linear-gradient(90deg, #e25a1c, #f59e0b)`,
                          borderRadius: 4, transition: "width 0.5s ease",
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
