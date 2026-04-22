"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "../../../auth/useAuth";
import { useForgeEnv } from "../../../hooks/useForgeEnv";
import { apiFetch } from "../../../utils/api";
import { PageLayout } from "../../../components/PageLayout";
import { ForgeLoader } from "../../../components/ForgeLoader";

const ACCENT = "var(--forge-primary)";

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
  operator: string | null;
  downstream_task_ids?: string[];
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
  owner_email?: string;
  deployed_at?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATE: Record<string, { bg: string; color: string; dot: string; label: string }> = {
  success:            { bg: "#dcfce7", color: "#16a34a", dot: "#22c55e", label: "Success" },
  failed:             { bg: "#fee2e2", color: "#dc2626", dot: "#ef4444", label: "Failed" },
  running:            { bg: "#fef9c3", color: "#ca8a04", dot: "#eab308", label: "Running" },
  queued:             { bg: "#e0f2fe", color: "#0284c7", dot: "#38bdf8", label: "Queued" },
  up_for_retry:       { bg: "#fff7ed", color: "#ea580c", dot: "#f97316", label: "Retrying" },
  up_for_reschedule:  { bg: "#f5f3ff", color: "#7c3aed", dot: "#a78bfa", label: "Rescheduling" },
  upstream_failed:    { bg: "#fef2f2", color: "#991b1b", dot: "#fca5a5", label: "Upstream Failed" },
  deferred:           { bg: "#f0fdf4", color: "#15803d", dot: "#86efac", label: "Deferred" },
  skipped:            { bg: "#f8fafc", color: "#94a3b8", dot: "#cbd5e1", label: "Skipped" },
};

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span style={{ fontSize: 12, color: "#94a3b8" }}>—</span>;
  const s = STATE[state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: state };
  return <span style={{ padding: "2px 9px", borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>{s.label}</span>;
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

function fmt(iso: string | null, opts?: Intl.DateTimeFormatOptions): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", opts ?? { dateStyle: "short", timeStyle: "short" });
}

/** Determine grouping granularity from schedule cron */
function groupKey(logicalDate: string | null, schedule: string | null): string {
  const d = new Date(logicalDate ?? Date.now());
  if (!schedule || schedule.toLowerCase().includes("triggered")) {
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  // Detect hourly: cron field 1 (hour) is "*"
  const parts = schedule.split(/\s+/);
  if (parts.length === 5 && parts[1] === "*") {
    // Hourly — group by day + hour
    return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  // Default daily/weekly/monthly: group by day
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** Group runs into sorted date slots */
function groupRuns(runs: Run[], schedule: string | null): Array<{ key: string; date: Date; runs: Run[] }> {
  const map = new Map<string, { date: Date; runs: Run[] }>();
  for (const run of runs) {
    const k = groupKey(run.logical_date, schedule);
    if (!map.has(k)) map.set(k, { date: new Date(run.logical_date ?? run.start_date ?? Date.now()), runs: [] });
    map.get(k)!.runs.push(run);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Pick worst state for a group */
function groupState(runs: Run[]): string | null {
  const order = ["running", "queued", "failed", "success"];
  for (const s of order) { if (runs.some(r => r.state === s)) return s; }
  return null;
}

/** Parse Layer + Table from DAG docstring, falling back to dag_id conventions */
function parseMeta(doc: string, dagId: string) {
  const layer = doc.match(/Layer:\s+(\S+)/)?.[1]
    ?? (dagId.endsWith("_bronze") ? "bronze" : dagId.endsWith("_silver") ? "silver" : dagId.endsWith("_gold") ? "gold" : "");
  const table = doc.match(/Table:\s+(\S+)/)?.[1] ?? "";
  // Derive a human-readable source name from dag_id: strip layer suffix, replace _ with space, title-case
  const sourceName = dagId
    .replace(/_bronze$|_silver$|_gold$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
  return { layer, table, sourceName };
}

const LAYER_COLOR: Record<string, { bg: string; color: string; icon: string }> = {
  bronze: { bg: "#fef3c7", color: "#d97706", icon: "fa-layer-group" },
  silver: { bg: "#e0f2fe", color: "#0284c7", icon: "fa-layer-group" },
  gold:   { bg: "#fefce8", color: "#ca8a04", icon: "fa-layer-group" },
};

// ---------------------------------------------------------------------------
// Flow Graph
// ---------------------------------------------------------------------------

function FlowGraph({ meta, tasks, instances }: {
  meta: { layer: string; table: string; sourceName: string };
  tasks: PipelineDetail["tasks_def"];
  instances: TaskInstance[];
}) {
  const lc = LAYER_COLOR[meta.layer] ?? { bg: "#f1f5f9", color: "#64748b", icon: "fa-layer-group" };

  // Source node: actual dataset/layer name
  const sourceLabel = meta.layer === "bronze" ? meta.sourceName
    : meta.layer === "silver" ? meta.sourceName.replace(/Silver$/, "").trim() + " (Bronze)"
    : meta.layer === "gold" ? meta.sourceName.replace(/Gold$/, "").trim() + " (Silver)"
    : meta.sourceName || "Source";

  // All task instances (fall back to tasks_def structure when no run selected)
  const allInstances: TaskInstance[] = instances.length > 0 ? instances : tasks.map(t => ({
    task_id: t.task_id, state: null, start_date: null, end_date: null, duration: null, try_number: 0,
    operator: t.operator_name,
  }));

  // Only show Spark/compute tasks — downstream triggers are not part of the data flow
  const sparkTasks = allInstances.filter(t => !t.operator?.includes("TriggerDagRunOperator"));

  const node = (content: React.ReactNode, color = "#e2e8f0") => (
    <div style={{ borderRadius: 10, border: `1px solid ${color}`, background: "#fff", padding: "10px 14px", minWidth: 140, maxWidth: 200, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
      {content}
    </div>
  );

  const arrow = () => (
    <div style={{ display: "flex", alignItems: "center", padding: "0 4px" }}>
      <div style={{ width: 24, height: 2, background: "#cbd5e1" }} />
      <i className="fas fa-caret-right" style={{ color: "#94a3b8", fontSize: 10, marginLeft: -1 }} />
    </div>
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap", padding: "16px 0" }}>
      {/* Source */}
      {node(
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <div style={{ width: 24, height: 24, borderRadius: 6, background: lc.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <i className={`fas ${meta.layer === "bronze" ? "fa-database" : "fa-layer-group"}`} style={{ color: lc.color, fontSize: 10 }} />
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {meta.layer === "bronze" ? "Raw Source" : `${meta.layer === "silver" ? "Bronze" : "Silver"} Layer`}
            </span>
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>{sourceLabel}</div>
        </div>,
        lc.color + "40"
      )}

      {/* Spark tasks */}
      {sparkTasks.map(t => {
        const s = t.state ? STATE[t.state] : null;
        return (
          <div key={t.task_id} style={{ display: "flex", alignItems: "center" }}>
            {arrow()}
            {node(
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: s ? s.bg : "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <i className="fas fa-fire-flame-curved" style={{ color: s ? s.color : "#94a3b8", fontSize: 10 }} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Spark</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>{t.task_id}</div>
                {t.state && <div style={{ marginTop: 6 }}><StateBadge state={t.state} /></div>}
                {(t.duration || t.start_date) && (
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
                    <i className="fas fa-clock" style={{ marginRight: 4, fontSize: 9 }} />
                    {dur(t.start_date, t.end_date, t.duration)}
                  </div>
                )}
              </div>,
              s ? s.color + "40" : "#e2e8f0"
            )}
          </div>
        );
      })}

      {/* Output table */}
      {meta.table && (
        <div style={{ display: "flex", alignItems: "center" }}>
          {arrow()}
          {node(
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: lc.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <i className="fas fa-table" style={{ color: lc.color, fontSize: 10 }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Output</span>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#0f172a", fontFamily: "monospace", wordBreak: "break-all" }}>{meta.table}</div>
              {meta.layer && (
                <span style={{ marginTop: 4, display: "inline-block", padding: "1px 7px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: lc.bg, color: lc.color, textTransform: "capitalize" }}>
                  {meta.layer}
                </span>
              )}
            </div>,
            lc.color + "40"
          )}
        </div>
      )}

      {/* Downstream triggers intentionally not shown — only upstream and current tasks */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PipelineDetailPage() {
  const { dag_id } = useParams<{ dag_id: string }>();
  const { getToken, role } = useAuth();

  const [pipeline, setPipeline] = useState<PipelineDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<TaskInstance[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  const [triggering, setTriggering] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [logsTaskId, setLogsTaskId] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);

  const { isDev } = useForgeEnv();
  const canTrigger = role === "Admin" || role === "Editor";
  const isRunning = pipeline?.last_run_state === "running" || pipeline?.last_run_state === "queued";

  useEffect(() => {
    apiFetch<PipelineDetail>(`/api/pipelines/${dag_id}`, getToken)
      .then(d => {
        setPipeline(d);
        // Auto-expand the most recent group
        if (d.recent_runs.length > 0) {
          const firstKey = groupKey(d.recent_runs[0].logical_date, d.schedule);
          setExpandedGroups(new Set([firstKey]));
          setSelectedRun(d.recent_runs[0]);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [dag_id, getToken]);

  useEffect(() => {
    if (!selectedRun) return;
    setTasksLoading(true);
    apiFetch<TaskInstance[]>(`/api/pipelines/${dag_id}/runs/${selectedRun.dag_run_id}/tasks`, getToken)
      .then(setTasks).catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  }, [selectedRun, dag_id, getToken]);

  async function fetchLogs(task_id: string, attempt = 1) {
    if (!selectedRun) return;
    setLogsTaskId(task_id);
    setLogsContent("");
    setLogsLoading(true);
    try {
      const res = await apiFetch<{ logs: string; attempt: number }>(
        `/api/pipelines/${dag_id}/runs/${selectedRun.dag_run_id}/tasks/${task_id}/logs?attempt=${attempt}`,
        getToken
      );
      setLogsContent(res.logs);
    } catch {
      setLogsContent("Could not fetch logs.");
    } finally {
      setLogsLoading(false);
    }
  }

  function flash(ok: boolean, msg: string) {
    setActionMsg({ ok, msg });
    setTimeout(() => setActionMsg(null), 5000);
  }

  async function handleTrigger(force = false) {
    setTriggering(true);
    setStopConfirm(false);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/trigger`, getToken, { method: "POST", body: JSON.stringify({ conf: {}, force }) });
      flash(true, force ? "Active run cancelled — new run triggered" : "Triggered — check run history in a moment");
    } catch (e: unknown) {
      flash(false, e instanceof Error ? e.message : "Trigger failed");
    } finally {
      setTriggering(false);
    }
  }

  async function handlePauseToggle() {
    if (!pipeline) return;
    setTogglingPause(true);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/${pipeline.is_paused ? "unpause" : "pause"}`, getToken, { method: "POST" });
      setPipeline(p => p ? { ...p, is_paused: !p.is_paused } : p);
    } catch { /* ignore */ }
    finally { setTogglingPause(false); }
  }

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const { layer, table, sourceName } = pipeline ? parseMeta(pipeline.doc_md, dag_id) : { layer: "", table: "", sourceName: "" };
  const groups = useMemo(() => pipeline ? groupRuns(pipeline.recent_runs, pipeline.schedule) : [], [pipeline]);

  const heroContent = pipeline ? (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      {pipeline.is_paused
        ? <span style={{ padding: "4px 12px", borderRadius: 12, fontSize: 12, fontWeight: 700, background: "rgba(148,163,184,0.2)", color: "#94a3b8" }}>PAUSED</span>
        : <span style={{ padding: "4px 12px", borderRadius: 12, fontSize: 12, fontWeight: 700, background: "rgba(34,197,94,0.2)", color: "#4ade80" }}>ACTIVE</span>}
      {layer && <span style={{ padding: "4px 12px", borderRadius: 12, fontSize: 12, fontWeight: 700, background: "rgba(255,255,255,0.15)", color: "#fff", textTransform: "capitalize" }}>{layer}</span>}
      {pipeline.schedule && <span style={{ padding: "4px 12px", borderRadius: 12, fontSize: 12, fontWeight: 600, background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.8)", fontFamily: "monospace" }}><i className="fas fa-clock" style={{ marginRight: 5, fontSize: 10 }} />{pipeline.schedule}</span>}
    </div>
  ) : undefined;

  return (
    <PageLayout icon="fa-sitemap" title={dag_id} subtitle={pipeline?.description || "Pipeline details"} heroContent={heroContent}>
      {/* Back link */}
      <div style={{ marginBottom: 20 }}>
        <Link href="/pipelines" style={{ fontSize: 13, color: "#64748b", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <i className="fas fa-arrow-left" style={{ fontSize: 11 }} /> All Pipelines
        </Link>
      </div>

      {loading && <ForgeLoader text="Loading run history…" fullscreen={false} />}
      {error && <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 12, padding: "16px 20px", color: "#dc2626" }}><i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />{error}</div>}

      {!loading && pipeline && (
        <>
          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24, alignItems: "center", flexWrap: "wrap" }}>
            {canTrigger && (isRunning && isDev ? (
              /* Active run exists — Retrigger = cancel + fresh run — dev only */
              stopConfirm ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#d97706" }}>Cancel active run and retrigger?</span>
                  <button onClick={() => handleTrigger(true)} disabled={triggering} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #f59e0b", background: "#fef3c7", color: "#d97706", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                    <i className={`fas ${triggering ? "fa-spinner fa-spin" : "fa-rotate-right"}`} style={{ marginRight: 6, fontSize: 10 }} />Yes, Retrigger
                  </button>
                  <button onClick={() => setStopConfirm(false)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setStopConfirm(true)} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #f59e0b", background: "#fef3c7", color: "#d97706", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}
                  title="Cancel the active run and trigger a fresh one for this slot">
                  <i className="fas fa-rotate-right" style={{ fontSize: 11 }} />Retrigger
                </button>
              )
            ) : isRunning ? (
              /* Prod + active run — no retrigger button, just informational */
              <span style={{ padding: "7px 14px", borderRadius: 8, background: "#fef9c3", border: "1px solid #fde68a", fontSize: 13, fontWeight: 600, color: "#d97706", display: "flex", alignItems: "center", gap: 7 }}>
                <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} />Run in progress
              </span>
            ) : (
              <button onClick={() => handleTrigger(false)} disabled={triggering} style={{ padding: "7px 16px", borderRadius: 8, border: `1px solid ${ACCENT}`, background: ACCENT, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
                <i className={`fas ${triggering ? "fa-spinner fa-spin" : "fa-play"}`} style={{ fontSize: 11 }} />Trigger Run
              </button>
            ))}
            <button onClick={handlePauseToggle} disabled={togglingPause} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: pipeline.is_paused ? "#16a34a" : "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
              <i className={`fas ${togglingPause ? "fa-spinner fa-spin" : pipeline.is_paused ? "fa-play-circle" : "fa-pause-circle"}`} style={{ fontSize: 12 }} />
              {pipeline.is_paused ? "Unpause" : "Pause"}
            </button>
            {actionMsg && <span style={{ fontSize: 13, fontWeight: 600, color: actionMsg.ok ? "#16a34a" : "#dc2626" }}><i className={`fas ${actionMsg.ok ? "fa-check-circle" : "fa-circle-exclamation"}`} style={{ marginRight: 6 }} />{actionMsg.msg}</span>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 24, alignItems: "start" }}>

            {/* ── Left: Grouped runs ── */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 10 }}>
                Run History · {groups.length} slot{groups.length !== 1 ? "s" : ""}
              </div>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                {groups.length === 0 ? (
                  <div style={{ padding: "32px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>No runs yet</div>
                ) : groups.map((group, gi) => {
                  const gState = groupState(group.runs);
                  const dot = gState ? (STATE[gState]?.dot ?? "#94a3b8") : "#94a3b8";
                  const expanded = expandedGroups.has(group.key);
                  return (
                    <div key={group.key} style={{ borderBottom: gi < groups.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                      {/* Group header */}
                      <button
                        onClick={() => toggleGroup(group.key)}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0, boxShadow: gState === "running" ? `0 0 0 3px ${dot}30` : "none" }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{group.key}</div>
                          <div style={{ fontSize: 11, color: "#94a3b8" }}>{group.runs.length} run{group.runs.length !== 1 ? "s" : ""}</div>
                        </div>
                        <i className={`fas fa-chevron-${expanded ? "up" : "down"}`} style={{ color: "#94a3b8", fontSize: 10, flexShrink: 0 }} />
                      </button>

                      {/* Runs in this group */}
                      {expanded && group.runs.map((run, ri) => {
                        const isSelected = selectedRun?.dag_run_id === run.dag_run_id;
                        const rs = STATE[run.state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: run.state };
                        return (
                          <button
                            key={run.dag_run_id}
                            onClick={() => setSelectedRun(run)}
                            style={{
                              width: "100%", display: "flex", alignItems: "center", gap: 8,
                              padding: "8px 14px 8px 30px", background: isSelected ? `${ACCENT}10` : ri % 2 === 0 ? "#fafbfc" : "#fff",
                              border: "none", borderLeft: isSelected ? `3px solid ${ACCENT}` : "3px solid transparent",
                              cursor: "pointer", textAlign: "left",
                            }}
                          >
                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: rs.dot, flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: isSelected ? ACCENT : "#374151" }}>
                                {run.run_type === "manual" ? "Manual trigger" : fmt(run.logical_date, { timeStyle: "short" })}
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

              {/* Metadata */}
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 16px", marginTop: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                {[
                  { label: "Owner", value: pipeline.owner_alias || pipeline.owner_email || "—" },
                  { label: "Schedule", value: pipeline.schedule || "Manual" },
                  { label: "Tags", value: pipeline.tags.join(", ") || "—" },
                  { label: "Deployed", value: pipeline.deployed_at ? fmt(pipeline.deployed_at) : "—" },
                ].map(row => (
                  <div key={row.label} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #f8fafc", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>{row.label}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", textAlign: "right", wordBreak: "break-all" }}>{row.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Right: Run detail ── */}
            <div>
              {selectedRun ? (
                <>
                  {/* Run header */}
                  <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderTop: `3px solid ${ACCENT}`, borderRadius: 12, padding: "16px 20px", marginBottom: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                      <StateBadge state={selectedRun.state} />
                      <span style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace" }}>{selectedRun.dag_run_id}</span>
                      {selectedRun.run_type === "manual" && (
                        <span style={{ padding: "1px 7px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: "#f1f5f9", color: "#64748b" }}>MANUAL</span>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                      {[
                        { label: "Logical date", value: fmt(selectedRun.logical_date) },
                        { label: "Started", value: fmt(selectedRun.start_date) },
                        { label: "Duration", value: dur(selectedRun.start_date, selectedRun.end_date) },
                      ].map(s => (
                        <div key={s.label}>
                          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#94a3b8" }}>{s.label}</div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", marginTop: 2 }}>{s.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Flow graph */}
                  <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 20px", marginBottom: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 4 }}>Data Flow</div>
                    {tasksLoading ? (
                      <ForgeLoader text="Loading graph…" fullscreen={false} />
                    ) : (
                      <FlowGraph meta={{ layer, table, sourceName }} tasks={pipeline.tasks_def} instances={tasks} />
                    )}
                  </div>

                  {/* Task instances table */}
                  {tasks.length > 0 && (
                    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                      <div style={{ padding: "12px 16px", borderBottom: "1px solid #f1f5f9", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8" }}>
                        Task Instances
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                            {["Task", "Operator", "Status", "Started", "Duration", "Try", ""].map(h => (
                              <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tasks.filter(t => !t.operator?.includes("TriggerDagRunOperator")).map((t, i, arr) => (
                            <tr key={t.task_id} style={{ borderBottom: i < arr.length - 1 ? "1px solid #f8fafc" : "none", background: logsTaskId === t.task_id ? "#f8faff" : i % 2 === 0 ? "#fff" : "#fafbfc" }}>
                              <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{t.task_id}</td>
                              <td style={{ padding: "10px 14px", fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>{t.operator?.split(".").pop() ?? "—"}</td>
                              <td style={{ padding: "10px 14px" }}><StateBadge state={t.state} /></td>
                              <td style={{ padding: "10px 14px", fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>{fmt(t.start_date)}</td>
                              <td style={{ padding: "10px 14px", fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>{dur(t.start_date, t.end_date, t.duration)}</td>
                              <td style={{ padding: "10px 14px", fontSize: 12, color: "#64748b" }}>#{t.try_number}</td>
                              <td style={{ padding: "10px 14px" }}>
                                <button
                                  onClick={() => logsTaskId === t.task_id ? setLogsTaskId(null) : fetchLogs(t.task_id, t.try_number || 1)}
                                  style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #e2e8f0", background: logsTaskId === t.task_id ? ACCENT : "transparent", color: logsTaskId === t.task_id ? "#fff" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5 }}
                                >
                                  <i className="fas fa-terminal" style={{ fontSize: 10 }} />
                                  Logs
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {/* Inline log viewer */}
                      {logsTaskId && (
                        <div style={{ borderTop: "1px solid #e2e8f0", background: "#0f172a", padding: "14px 16px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", fontFamily: "monospace" }}>
                              <i className="fas fa-terminal" style={{ marginRight: 6 }} />{logsTaskId} — logs
                            </span>
                            <button onClick={() => setLogsTaskId(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}>✕</button>
                          </div>
                          {logsLoading ? (
                            <div style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>
                              <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading logs…
                            </div>
                          ) : (
                            <pre style={{ margin: 0, fontSize: 11, color: "#e2e8f0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 400, overflowY: "auto" }}>
                              {logsContent || "No log content available."}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "48px 24px", textAlign: "center", color: "#94a3b8" }}>
                  <i className="fas fa-hand-pointer" style={{ fontSize: 24, marginBottom: 12, display: "block" }} />
                  Select a run on the left to see its details
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </PageLayout>
  );
}
