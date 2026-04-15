"use client";

import { useEffect, useState, useMemo } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";

const ACCENT = "var(--forge-primary)";

interface Pipeline {
  dag_id: string;
  description: string;
  is_active: boolean;
  is_paused: boolean;
  last_run_state: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  schedule: string | null;
  tags: string[];
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

function StateBadge({ state }: { state: string | null }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    success: { bg: "#dcfce7", color: "#16a34a", label: "Success" },
    failed: { bg: "#fee2e2", color: "#dc2626", label: "Failed" },
    running: { bg: "#fef9c3", color: "#ca8a04", label: "Running" },
    queued: { bg: "#e0f2fe", color: "#0284c7", label: "Queued" },
  };
  const style = state ? map[state] ?? { bg: "#f1f5f9", color: "#64748b", label: state } : { bg: "#f1f5f9", color: "#94a3b8", label: "No runs" };
  return (
    <span style={{
      padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 600,
      background: style.bg, color: style.color,
    }}>
      {style.label}
    </span>
  );
}

export default function PipelinesPage() {
  const { getToken, role } = useAuth();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerMsg, setTriggerMsg] = useState<{ dag_id: string; ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    apiFetch<Pipeline[]>("/api/pipelines", getToken)
      .then(setPipelines)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [getToken]);

  const canTrigger = role === "Admin" || role === "Editor";

  const allTags = useMemo(() =>
    [...new Set(pipelines.flatMap(p => p.tags))].sort()
  , [pipelines]);

  const filtered = useMemo(() => {
    let list = pipelines;
    if (activeTag) list = list.filter(p => p.tags.includes(activeTag));
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      p => p.dag_id.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some(t => t.toLowerCase().includes(q))
    );
  }, [pipelines, search, activeTag]);


  async function handleTrigger(dag_id: string) {
    setTriggering(dag_id);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/trigger`, getToken, {
        method: "POST",
        body: JSON.stringify({ conf: {} }),
      });
      setTriggerMsg({ dag_id, ok: true, msg: "Triggered successfully" });
    } catch (e: unknown) {
      setTriggerMsg({ dag_id, ok: false, msg: e instanceof Error ? e.message : "Trigger failed" });
    } finally {
      setTriggering(null);
      setTimeout(() => setTriggerMsg(null), 4000);
    }
  }

  const heroContent = (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      {[
        { label: "Total", value: loading ? "—" : pipelines.length, icon: "fa-layer-group" },
        { label: "Active", value: loading ? "—" : pipelines.filter(p => p.is_active).length, icon: "fa-circle-play" },
        { label: "Paused", value: loading ? "—" : pipelines.filter(p => p.is_paused).length, icon: "fa-pause-circle" },
        { label: "Failed", value: loading ? "—" : pipelines.filter(p => p.last_run_state === "failed").length, icon: "fa-circle-xmark" },
      ].map(s => (
        <div key={s.label} style={{
          background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 10, padding: "8px 18px", display: "flex", alignItems: "center", gap: 8,
        }}>
          <i className={`fas ${s.icon}`} style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }} />
          <span style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{s.value}</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>{s.label}</span>
        </div>
      ))}
    </div>
  );

  return (
    <PageLayout
      icon="fa-sitemap"
      title="Pipeline Explorer"
      subtitle="Browse, monitor and trigger your Forge data pipelines"
      heroContent={heroContent}
    >
      {/* Tag filter + Search */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24, flexWrap: "wrap" }}>
        {allTags.length > 0 && (
          <div style={{ display: "flex", gap: 4, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 4 }}>
            <button
              onClick={() => setActiveTag(null)}
              style={{
                padding: "5px 14px", borderRadius: 7, border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 600,
                background: activeTag === null ? "var(--forge-primary)" : "transparent",
                color: activeTag === null ? "#fff" : "#64748b",
              }}
            >All</button>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                style={{
                  padding: "5px 14px", borderRadius: 7, border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 600, textTransform: "capitalize",
                  background: activeTag === tag ? "var(--forge-primary)" : "transparent",
                  color: activeTag === tag ? "#fff" : "#64748b",
                }}
              >{tag}</button>
            ))}
          </div>
        )}
        <div style={{ position: "relative", maxWidth: 360, flex: 1 }}>
          <i className="fas fa-magnifying-glass" style={{
            position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
            color: "#94a3b8", fontSize: 14,
          }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search pipelines…"
            style={{
              width: "100%", padding: "9px 14px 9px 40px", borderRadius: 10,
              border: "1px solid #e2e8f0", fontSize: 14, background: "#fff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)", outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
          <i className="fas fa-spinner fa-spin" style={{ fontSize: 28, marginBottom: 12, display: "block" }} />
          Loading pipelines…
        </div>
      )}

      {error && (
        <div style={{
          background: "#fff", border: "1px solid #fca5a5", borderTop: `3px solid #ef4444`,
          borderRadius: 12, padding: "20px 24px", color: "#dc2626",
        }}>
          <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
          {error}
        </div>
      )}

      {triggerMsg && (
        <div style={{
          background: triggerMsg.ok ? "#f0fdf4" : "#fff1f2",
          border: `1px solid ${triggerMsg.ok ? "#86efac" : "#fca5a5"}`,
          borderRadius: 10, padding: "12px 18px", marginBottom: 16,
          color: triggerMsg.ok ? "#16a34a" : "#dc2626", fontSize: 14,
        }}>
          <i className={`fas ${triggerMsg.ok ? "fa-check-circle" : "fa-circle-exclamation"}`} style={{ marginRight: 8 }} />
          <strong>{triggerMsg.dag_id}</strong>: {triggerMsg.msg}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
          <i className="fas fa-inbox" style={{ fontSize: 32, marginBottom: 12, display: "block" }} />
          No pipelines found
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderTop: `3px solid ${ACCENT}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                {["Pipeline", "Schedule", "Last Run", "Status", ""].map(h => (
                  <th key={h} style={{
                    padding: "10px 16px", textAlign: "left",
                    fontSize: 11, fontWeight: 700, color: "#94a3b8",
                    textTransform: "uppercase", letterSpacing: "0.07em",
                    whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, idx) => (
                <tr
                  key={p.dag_id}
                  style={{
                    borderBottom: idx < filtered.length - 1 ? "1px solid #f8fafc" : "none",
                    background: idx % 2 === 0 ? "#fff" : "#fafbfc",
                  }}
                >
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: p.is_paused ? "#94a3b8" : "#22c55e",
                        flexShrink: 0,
                      }} />
                      <div>
                        <div style={{ fontWeight: 600, color: "#0f172a", fontSize: 14 }}>{p.dag_id}</div>
                        {p.description && (
                          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 1 }}>{p.description}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: "#64748b", whiteSpace: "nowrap" }}>
                    {p.schedule ? (
                      <span style={{ background: "#f1f5f9", padding: "2px 8px", borderRadius: 6, fontFamily: "monospace", fontSize: 12 }}>
                        {p.schedule}
                      </span>
                    ) : "—"}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: "#64748b", whiteSpace: "nowrap" }}>
                    {timeAgo(p.last_run_at)}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <StateBadge state={p.last_run_state} />
                    {p.is_paused && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>PAUSED</span>
                    )}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    {canTrigger && (
                      <button
                        onClick={() => handleTrigger(p.dag_id)}
                        disabled={triggering === p.dag_id}
                        style={{
                          padding: "5px 12px", borderRadius: 7, border: `1px solid ${ACCENT}`,
                          background: triggering === p.dag_id ? "#e0f2fe" : "transparent",
                          color: ACCENT, fontSize: 12, fontWeight: 600, cursor: "pointer",
                          display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                        }}
                      >
                        <i className={`fas ${triggering === p.dag_id ? "fa-spinner fa-spin" : "fa-play"}`} style={{ fontSize: 10 }} />
                        Trigger
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageLayout>
  );
}
