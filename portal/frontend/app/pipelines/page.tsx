"use client";

import { useEffect, useState, useMemo } from "react";
import { useAuth } from "../../auth/useAuth";
import { useForgeEnv } from "../../hooks/useForgeEnv";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";

const ACCENT = "var(--forge-primary)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Pipeline {
  dag_id: string;
  description: string;
  is_active: boolean;
  is_paused: boolean;
  last_run_state: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  next_run_at: string | null;
  schedule: string | null;
  tags: string[];
}

interface Run {
  dag_run_id: string;
  state: string;
  start_date: string | null;
  end_date: string | null;
  logical_date: string | null;
  run_type: string;
}

interface TaskInstance {
  task_id: string;
  state: string | null;
  start_date: string | null;
  end_date: string | null;
  duration: number | null;
  try_number: number;
  operator?: string | null;        // Airflow 2.x
  operator_name?: string | null;   // Airflow 3.x
}

interface PipelineDetail {
  dag_id: string;
  description: string;
  is_paused: boolean;
  schedule: string | null;
  tags: string[];
  last_run_state: string | null;
  last_run_id: string | null;
  last_run_at: string | null;
  recent_runs: Run[];
  doc_md: string;
  tasks_def: Array<{ task_id: string; operator_name: string; downstream_task_ids: string[] }>;
  owner_alias?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATE: Record<string, { bg: string; color: string; dot: string; label: string }> = {
  success:           { bg: "#dcfce7", color: "#16a34a", dot: "#22c55e", label: "Success" },
  failed:            { bg: "#fee2e2", color: "#dc2626", dot: "#ef4444", label: "Failed" },
  running:           { bg: "#fef9c3", color: "#ca8a04", dot: "#eab308", label: "Running" },
  queued:            { bg: "#e0f2fe", color: "#0284c7", dot: "#38bdf8", label: "Queued" },
  up_for_retry:      { bg: "#fff7ed", color: "#ea580c", dot: "#f97316", label: "Retrying" },
  upstream_failed:   { bg: "#fef2f2", color: "#991b1b", dot: "#fca5a5", label: "Upstream Failed" },
  skipped:           { bg: "#f8fafc", color: "#94a3b8", dot: "#cbd5e1", label: "Skipped" },
};

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span style={{ fontSize: 11, color: "#94a3b8" }}>—</span>;
  const s = STATE[state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: state };
  return <span style={{ padding: "2px 8px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>{s.label}</span>;
}

function dur(start: string | null, end: string | null, secs?: number | null): string {
  if (secs != null) {
    const m = Math.floor(secs / 60); const s2 = Math.round(secs % 60);
    return m > 0 ? `${m}m ${s2}s` : `${s2}s`;
  }
  if (!start) return "—";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const s2 = Math.floor(ms / 1000); const m = Math.floor(s2 / 60);
  return m > 0 ? `${m}m ${s2 % 60}s` : `${s2}s`;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Group runs by logical date */
function groupRuns(runs: Run[]): Array<{ key: string; date: Date; runs: Run[] }> {
  const map = new Map<string, { date: Date; runs: Run[] }>();
  for (const run of runs) {
    const d = new Date(run.logical_date ?? run.start_date ?? Date.now());
    const k = d.toISOString().split("T")[0];
    if (!map.has(k)) map.set(k, { date: d, runs: [] });
    map.get(k)!.runs.push(run);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

function groupState(runs: Run[]): string | null {
  for (const s of ["running", "queued", "failed", "success"]) {
    if (runs.some(r => r.state === s)) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Column styles
// ---------------------------------------------------------------------------

const COL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
};

const COL_HEADER: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #f1f5f9",
  flexShrink: 0,
};

const COL_BODY: React.CSSProperties = {
  overflowY: "auto",
  flex: 1,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PipelinesPage() {
  const { getToken, role } = useAuth();
  const { isDev } = useForgeEnv();

  // List state
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [myDagIds, setMyDagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Selection state
  const [selectedDagId, setSelectedDagId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Run selection state
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<TaskInstance[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  // Logs state
  const [logsTaskId, setLogsTaskId] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);

  // Action state
  const [triggering, setTriggering] = useState<string | null>(null);
  const [togglingPause, setTogglingPause] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  const canTrigger = role === "Admin" || role === "Editor";

  // Load pipeline list
  useEffect(() => {
    apiFetch<Pipeline[]>("/api/pipelines", getToken)
      .then(setPipelines)
      .catch(() => {})
      .finally(() => setLoading(false));
    apiFetch<string[]>("/api/pipelines/mine", getToken)
      .then(setMyDagIds)
      .catch(() => {});
  }, [getToken]);

  // Load detail when a pipeline is selected
  useEffect(() => {
    if (!selectedDagId) { setDetail(null); setSelectedRun(null); setTasks([]); return; }
    setDetailLoading(true);
    setDetail(null);
    setSelectedRun(null);
    setTasks([]);
    apiFetch<PipelineDetail>(`/api/pipelines/${selectedDagId}`, getToken)
      .then(d => {
        setDetail(d);
        if (d.recent_runs.length > 0) setSelectedRun(d.recent_runs[0]);
      })
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  }, [selectedDagId, getToken]);

  // Load tasks when a run is selected
  useEffect(() => {
    if (!selectedRun || !selectedDagId) { setTasks([]); return; }
    setTasksLoading(true);
    setLogsTaskId(null);
    apiFetch<TaskInstance[]>(`/api/pipelines/${selectedDagId}/runs/${selectedRun.dag_run_id}/tasks`, getToken)
      .then(setTasks).catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  }, [selectedRun, selectedDagId, getToken]);

  async function fetchLogs(task_id: string, attempt = 1) {
    if (!selectedRun || !selectedDagId) return;
    if (logsTaskId === task_id) { setLogsTaskId(null); return; }
    setLogsTaskId(task_id);
    setLogsContent("");
    setLogsLoading(true);
    try {
      const res = await apiFetch<{ logs: string }>(
        `/api/pipelines/${selectedDagId}/runs/${selectedRun.dag_run_id}/tasks/${task_id}/logs?attempt=${attempt}`,
        getToken
      );
      setLogsContent(res.logs);
    } catch { setLogsContent("Could not fetch logs."); }
    finally { setLogsLoading(false); }
  }

  function flash(ok: boolean, msg: string) {
    setActionMsg({ ok, msg });
    setTimeout(() => setActionMsg(null), 5000);
  }

  async function handleTrigger(dag_id: string, force = false) {
    setTriggering(dag_id);
    setStopConfirm(null);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/trigger`, getToken, { method: "POST", body: JSON.stringify({ conf: {}, force }) });
      flash(true, force ? "Active run cancelled — new run triggered" : "Triggered");
      setPipelines(prev => prev.map(p => p.dag_id === dag_id ? { ...p, last_run_state: "queued" } : p));
    } catch (e: unknown) {
      flash(false, e instanceof Error ? e.message : "Trigger failed");
    } finally { setTriggering(null); }
  }

  async function handlePauseToggle(dag_id: string, currently_paused: boolean) {
    setTogglingPause(dag_id);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/${currently_paused ? "unpause" : "pause"}`, getToken, { method: "POST" });
      setPipelines(prev => prev.map(p => p.dag_id === dag_id ? { ...p, is_paused: !currently_paused } : p));
      if (detail?.dag_id === dag_id) setDetail(d => d ? { ...d, is_paused: !currently_paused } : d);
    } catch (e: unknown) {
      flash(false, e instanceof Error ? e.message : "Pause toggle failed");
    } finally { setTogglingPause(null); }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return pipelines;
    const q = search.toLowerCase();
    return pipelines.filter(p =>
      p.dag_id.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q) ||
      p.tags.some(t => t.toLowerCase().includes(q))
    );
  }, [pipelines, search]);

  const groups = useMemo(() => detail ? groupRuns(detail.recent_runs) : [], [detail]);

  const heroContent = (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {[
        { label: "Total", value: loading ? "—" : pipelines.length, icon: "fa-layer-group" },
        { label: "Mine", value: loading ? "—" : myDagIds.length, icon: "fa-user" },
        { label: "Active", value: loading ? "—" : pipelines.filter(p => p.is_active && !p.is_paused).length, icon: "fa-circle-play" },
        { label: "Failed", value: loading ? "—" : pipelines.filter(p => p.last_run_state === "failed").length, icon: "fa-circle-xmark" },
      ].map(s => (
        <div key={s.label} style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "7px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          <i className={`fas ${s.icon}`} style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }} />
          <span style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>{s.value}</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>{s.label}</span>
        </div>
      ))}
    </div>
  );

  return (
    <PageLayout icon="fa-sitemap" title="Pipelines" subtitle="Browse, monitor and trigger your Forge data pipelines" heroContent={heroContent}>

      {actionMsg && (
        <div style={{ background: actionMsg.ok ? "#f0fdf4" : "#fff1f2", border: `1px solid ${actionMsg.ok ? "#86efac" : "#fca5a5"}`, borderRadius: 10, padding: "10px 16px", marginBottom: 14, color: actionMsg.ok ? "#16a34a" : "#dc2626", fontSize: 13 }}>
          <i className={`fas ${actionMsg.ok ? "fa-check-circle" : "fa-circle-exclamation"}`} style={{ marginRight: 8 }} />{actionMsg.msg}
        </div>
      )}

      {/* 3-column layout */}
      <div style={{ display: "grid", gridTemplateColumns: "240px 300px 1fr", gap: 16, height: "calc(100vh - 260px)", minHeight: 500 }}>

        {/* ── Column 1: Pipeline list ── */}
        <div style={COL_STYLE}>
          <div style={{ ...COL_HEADER, borderTop: `3px solid ${ACCENT}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 8 }}>
              Pipelines · {filtered.length}
            </div>
            <div style={{ position: "relative" }}>
              <i className="fas fa-magnifying-glass" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 12 }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter by name…"
                style={{ width: "100%", padding: "7px 10px 7px 30px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box", outline: "none", background: "#f8fafc" }}
              />
            </div>
          </div>
          <div style={COL_BODY}>
            {loading ? (
              <div style={{ padding: "24px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                <i className="fas fa-spinner fa-spin" style={{ fontSize: 16, display: "block", marginBottom: 8 }} />Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: "24px 14px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>No pipelines found</div>
            ) : filtered.map(p => {
              const isSelected = selectedDagId === p.dag_id;
              const dot = STATE[p.last_run_state ?? ""]?.dot ?? (p.is_paused ? "#94a3b8" : "#22c55e");
              return (
                <button
                  key={p.dag_id}
                  onClick={() => setSelectedDagId(isSelected ? null : p.dag_id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 14px",
                    background: isSelected ? `${ACCENT}12` : "transparent",
                    border: "none", borderLeft: isSelected ? `3px solid ${ACCENT}` : "3px solid transparent",
                    borderBottom: "1px solid #f8fafc", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0, boxShadow: p.last_run_state === "running" ? `0 0 0 3px ${dot}30` : "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: isSelected ? 700 : 600, color: isSelected ? ACCENT : "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.dag_id}</div>
                    {p.description && <div style={{ fontSize: 11, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description}</div>}
                  </div>
                  {p.is_paused && <i className="fas fa-pause-circle" style={{ color: "#94a3b8", fontSize: 10, flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Column 2: Runs for selected pipeline ── */}
        <div style={COL_STYLE}>
          <div style={{ ...COL_HEADER, borderTop: `3px solid ${detail?.is_paused ? "#94a3b8" : "#10b981"}` }}>
            {detail ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{detail.dag_id}</span>
                  {detail.is_paused
                    ? <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: "#f1f5f9", color: "#94a3b8", flexShrink: 0 }}>PAUSED</span>
                    : <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: "#dcfce7", color: "#16a34a", flexShrink: 0 }}>ACTIVE</span>}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {canTrigger && (
                    <>
                      {(detail.last_run_state === "running" || detail.last_run_state === "queued") && isDev ? (
                        stopConfirm === detail.dag_id ? (
                          <>
                            <button onClick={() => handleTrigger(detail.dag_id, true)} disabled={triggering === detail.dag_id} style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #f59e0b", background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                              <i className={`fas ${triggering === detail.dag_id ? "fa-spinner fa-spin" : "fa-rotate-right"}`} style={{ marginRight: 4, fontSize: 9 }} />Retrigger
                            </button>
                            <button onClick={() => setStopConfirm(null)} style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid #e2e8f0", background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer" }}>Cancel</button>
                          </>
                        ) : (
                          <button onClick={() => setStopConfirm(detail.dag_id)} style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #f59e0b", background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                            <i className="fas fa-rotate-right" style={{ marginRight: 4, fontSize: 9 }} />Retrigger
                          </button>
                        )
                      ) : (
                        <button onClick={() => handleTrigger(detail.dag_id)} disabled={triggering === detail.dag_id} style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${ACCENT}`, background: ACCENT, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                          <i className={`fas ${triggering === detail.dag_id ? "fa-spinner fa-spin" : "fa-play"}`} style={{ marginRight: 4, fontSize: 9 }} />Trigger
                        </button>
                      )}
                      <button onClick={() => handlePauseToggle(detail.dag_id, detail.is_paused)} disabled={togglingPause === detail.dag_id} style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid #e2e8f0", background: "transparent", color: detail.is_paused ? "#16a34a" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                        <i className={`fas ${togglingPause === detail.dag_id ? "fa-spinner fa-spin" : detail.is_paused ? "fa-play-circle" : "fa-pause-circle"}`} />
                      </button>
                    </>
                  )}
                  <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: "auto" }}>{groups.length} slot{groups.length !== 1 ? "s" : ""}</span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8" }}>Runs</div>
            )}
          </div>
          <div style={COL_BODY}>
            {!selectedDagId ? (
              <div style={{ padding: "40px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                <i className="fas fa-hand-pointer" style={{ fontSize: 20, display: "block", marginBottom: 10 }} />
                Select a pipeline
              </div>
            ) : detailLoading ? (
              <div style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                <i className="fas fa-spinner fa-spin" style={{ fontSize: 16, display: "block", marginBottom: 8 }} />Loading…
              </div>
            ) : groups.length === 0 ? (
              <div style={{ padding: "40px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>No runs yet</div>
            ) : groups.map(group => {
              const gState = groupState(group.runs);
              const dot = gState ? (STATE[gState]?.dot ?? "#94a3b8") : "#94a3b8";
              const isSelectedGroup = selectedRun && group.runs.some(r => r.dag_run_id === selectedRun.dag_run_id);
              return (
                <div key={group.key} style={{ borderBottom: "1px solid #f8fafc" }}>
                  {/* Date header — click selects first run in group */}
                  <button
                    onClick={() => setSelectedRun(group.runs[0])}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "10px 14px",
                      background: isSelectedGroup ? `${ACCENT}08` : "transparent",
                      border: "none", borderLeft: isSelectedGroup ? `3px solid ${ACCENT}` : "3px solid transparent",
                      cursor: "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0, boxShadow: gState === "running" ? `0 0 0 3px ${dot}30` : "none" }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: isSelectedGroup ? ACCENT : "#0f172a" }}>{fmtDate(group.key)}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>
                        {group.runs.length} run{group.runs.length !== 1 ? "s" : ""}
                        {group.runs[0]?.start_date && <> · {dur(group.runs[0].start_date, group.runs[0].end_date)}</>}
                      </div>
                    </div>
                    <StateBadge state={gState} />
                  </button>

                  {/* Individual runs (shown if >1 in the group) */}
                  {group.runs.length > 1 && group.runs.map((run, ri) => {
                    const isSelected = selectedRun?.dag_run_id === run.dag_run_id;
                    const rs = STATE[run.state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: run.state };
                    return (
                      <button
                        key={run.dag_run_id}
                        onClick={() => setSelectedRun(run)}
                        style={{
                          width: "100%", display: "flex", alignItems: "center", gap: 8,
                          padding: "7px 14px 7px 34px",
                          background: isSelected ? `${ACCENT}12` : ri % 2 === 0 ? "#fafbfc" : "#fff",
                          border: "none", borderLeft: isSelected ? `3px solid ${ACCENT}` : "3px solid transparent",
                          cursor: "pointer", textAlign: "left",
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: rs.dot, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: isSelected ? ACCENT : "#374151" }}>
                            {run.run_type === "manual" ? "Manual" : fmt(run.logical_date)}
                          </div>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>{dur(run.start_date, run.end_date)}</div>
                        </div>
                        <StateBadge state={run.state} />
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Column 3: Run detail ── */}
        <div style={{ ...COL_STYLE, borderTop: `3px solid ${selectedRun ? (STATE[selectedRun.state]?.dot ?? ACCENT) : "#e2e8f0"}` }}>
          <div style={COL_HEADER}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8" }}>
              Pipeline run stages / logs
            </div>
          </div>
          <div style={COL_BODY}>
            {!selectedRun ? (
              <div style={{ padding: "60px 24px", textAlign: "center", color: "#94a3b8" }}>
                <i className="fas fa-mouse-pointer" style={{ fontSize: 24, display: "block", marginBottom: 12 }} />
                Select a run to see stages and logs
              </div>
            ) : (
              <div style={{ padding: "16px 20px" }}>
                {/* Run summary */}
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <StateBadge state={selectedRun.state} />
                    {selectedRun.run_type === "manual" && <span style={{ padding: "1px 7px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: "#f1f5f9", color: "#64748b" }}>MANUAL</span>}
                    <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedRun.dag_run_id}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                    {[
                      { label: "Run date", value: fmtDate(selectedRun.logical_date) },
                      { label: "Started", value: fmt(selectedRun.start_date) },
                      { label: "Duration", value: dur(selectedRun.start_date, selectedRun.end_date) },
                    ].map(s => (
                      <div key={s.label}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#94a3b8" }}>{s.label}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", marginTop: 2 }}>{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Task stages */}
                {tasksLoading ? (
                  <div style={{ padding: "24px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading stages…
                  </div>
                ) : tasks.length > 0 ? (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 10 }}>
                      Activities · {tasks.filter(t => !(t.operator_name ?? t.operator ?? "").includes("TriggerDagRunOperator")).length} tasks
                    </div>
                    {tasks.filter(t => !(t.operator_name ?? t.operator ?? "").includes("TriggerDagRunOperator")).map((t) => {
                      const s = t.state ? (STATE[t.state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: t.state }) : null;
                      const isLogsOpen = logsTaskId === t.task_id;
                      return (
                        <div key={t.task_id} style={{ marginBottom: 8 }}>
                          {/* Stage row */}
                          <div style={{
                            display: "flex", alignItems: "center", gap: 10,
                            background: isLogsOpen ? "#f0f9ff" : "#fff",
                            border: `1px solid ${isLogsOpen ? "#93c5fd" : "#e2e8f0"}`,
                            borderRadius: isLogsOpen ? "10px 10px 0 0" : 10, padding: "10px 14px",
                          }}>
                            {/* State icon */}
                            <div style={{ width: 28, height: 28, borderRadius: 8, background: s?.bg ?? "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {t.state === "running" ? (
                                <i className="fas fa-spinner fa-spin" style={{ color: s?.color, fontSize: 11 }} />
                              ) : t.state === "success" ? (
                                <i className="fas fa-check" style={{ color: s?.color, fontSize: 11 }} />
                              ) : t.state === "failed" ? (
                                <i className="fas fa-xmark" style={{ color: s?.color, fontSize: 11 }} />
                              ) : (
                                <i className="fas fa-circle" style={{ color: s?.dot ?? "#94a3b8", fontSize: 7 }} />
                              )}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.task_id}</div>
                              <div style={{ fontSize: 11, color: "#94a3b8" }}>
                                {(t.operator_name ?? t.operator ?? "—").split(".").pop()}
                                {t.start_date && <> · <i className="fas fa-clock" style={{ marginLeft: 6, marginRight: 3, fontSize: 9 }} />{dur(t.start_date, t.end_date, t.duration)}</>}
                                {t.try_number > 1 && <> · try #{t.try_number}</>}
                              </div>
                            </div>
                            <StateBadge state={t.state} />
                            <button
                              onClick={() => fetchLogs(t.task_id, t.try_number || 1)}
                              style={{
                                padding: "4px 10px", borderRadius: 7,
                                border: `1px solid ${isLogsOpen ? "#93c5fd" : "#e2e8f0"}`,
                                background: isLogsOpen ? "#1e40af" : "transparent",
                                color: isLogsOpen ? "#fff" : "#64748b",
                                fontSize: 11, fontWeight: 600, cursor: "pointer",
                                display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
                              }}
                            >
                              <i className="fas fa-terminal" style={{ fontSize: 10 }} />Logs
                            </button>
                          </div>

                          {/* Inline log viewer */}
                          {isLogsOpen && (
                            <div style={{ background: "#0f172a", borderRadius: "0 0 10px 10px", border: "1px solid #93c5fd", borderTop: "none", padding: "12px 14px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", fontFamily: "monospace" }}>
                                  <i className="fas fa-terminal" style={{ marginRight: 6 }} />{t.task_id}
                                </span>
                                <button onClick={() => setLogsTaskId(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}>✕</button>
                              </div>
                              {logsLoading ? (
                                <div style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>
                                  <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading logs…
                                </div>
                              ) : (
                                <pre style={{ margin: 0, fontSize: 11, color: "#e2e8f0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 360, overflowY: "auto" }}>
                                  {logsContent || "No log content."}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ padding: "24px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>No task data available</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
