"use client";

import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "../../auth/useAuth";
import { useForgeEnv } from "../../hooks/useForgeEnv";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";
import { ForgeLoader } from "../../components/ForgeLoader";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  operator?: string | null;
  operator_name?: string | null;
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
  source_name?: string;
}

// ── State map ─────────────────────────────────────────────────────────────────

const STATE: Record<string, { bg: string; color: string; dot: string; label: string }> = {
  success:         { bg: "#dcfce7", color: "#16a34a", dot: "#22c55e", label: "Success" },
  failed:          { bg: "#fee2e2", color: "#dc2626", dot: "#ef4444", label: "Failed" },
  running:         { bg: "#fef9c3", color: "#ca8a04", dot: "#eab308", label: "Running" },
  queued:          { bg: "#e0f2fe", color: "#0284c7", dot: "#38bdf8", label: "Queued" },
  up_for_retry:    { bg: "#fff7ed", color: "#ea580c", dot: "#f97316", label: "Retrying" },
  upstream_failed: { bg: "#fef2f2", color: "#991b1b", dot: "#fca5a5", label: "Upstream Failed" },
  skipped:         { bg: "#f8fafc", color: "#94a3b8", dot: "#cbd5e1", label: "Skipped" },
};

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span style={{ fontSize: 11, color: "#94a3b8" }}>—</span>;
  const s = STATE[state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: state };
  return (
    <span style={{ padding: "2px 8px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dur(start: string | null, end: string | null, secs?: number | null): string {
  if (secs != null) { const m = Math.floor(secs / 60); return m > 0 ? `${m}m ${Math.round(secs % 60)}s` : `${Math.round(secs)}s`; }
  if (!start) return "—";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const s2 = Math.floor(ms / 1000); const m = Math.floor(s2 / 60);
  return m > 0 ? `${m}m ${s2 % 60}s` : `${s2}s`;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  // Force UTC so logical_date "2024-01-01T02:00:00+00:00" shows as "1 Jan 2024", not "31 Dec 2023"
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function fmtRunId(run_id: string, run_type: string): string {
  const match = run_id.match(/__(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  if (!match) return run_id;
  const ts = new Date(match[1] + "Z");
  const label = ts.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
  const prefix = run_id.startsWith("backfill__") ? "Backfill" : run_type === "manual" || run_id.startsWith("manual__") ? "Manual" : "Scheduled";
  return `${prefix} · ${label}`;
}

function groupRuns(runs: Run[]): Array<{ key: string; date: Date; runs: Run[] }> {
  const map = new Map<string, { date: Date; runs: Run[] }>();
  for (const run of runs) {
    const d = new Date(run.logical_date ?? run.start_date ?? Date.now());
    const k = d.toISOString().split("T")[0];
    if (!map.has(k)) map.set(k, { date: d, runs: [] });
    map.get(k)!.runs.push(run);
  }
  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      date: v.date,
      runs: v.runs.sort((a, b) =>
        new Date(b.start_date ?? b.logical_date ?? 0).getTime() -
        new Date(a.start_date ?? a.logical_date ?? 0).getTime()
      ),
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

function groupState(runs: Run[]): string | null {
  // Show the state of the most recently started run in the group
  const sorted = [...runs].sort((a, b) =>
    new Date(b.start_date ?? b.logical_date ?? 0).getTime() -
    new Date(a.start_date ?? a.logical_date ?? 0).getTime()
  );
  return sorted[0]?.state ?? null;
}

// ── Task Graph ────────────────────────────────────────────────────────────────

const NW = 164, NH = 50, HG = 60, VG = 12;

interface GNode { id: string; x: number; y: number; state: string | null; opLabel: string; ti?: TaskInstance }

function buildGraph(
  tasksDef: PipelineDetail["tasks_def"],
  tasks: TaskInstance[]
): { nodes: GNode[]; edges: Array<{ x1: number; y1: number; x2: number; y2: number }>; svgW: number; svgH: number } {
  if (!tasksDef.length) return { nodes: [], edges: [], svgW: 0, svgH: 0 };

  const stateMap = new Map(tasks.map(t => [t.task_id, t]));
  const indegree = new Map<string, number>(tasksDef.map(t => [t.task_id, 0]));
  for (const t of tasksDef) for (const d of t.downstream_task_ids) indegree.set(d, (indegree.get(d) ?? 0) + 1);

  const levels = new Map<string, number>();
  const work = new Map(indegree);
  const q: string[] = [];
  for (const [id, deg] of work) if (deg === 0) { levels.set(id, 0); q.push(id); }

  let qi = 0;
  while (qi < q.length) {
    const id = q[qi++];
    const myLv = levels.get(id) ?? 0;
    const task = tasksDef.find(t => t.task_id === id);
    if (!task) continue;
    for (const d of task.downstream_task_ids) {
      const nLv = myLv + 1;
      if ((levels.get(d) ?? -1) < nLv) levels.set(d, nLv);
      const nd = (work.get(d) ?? 1) - 1;
      work.set(d, nd);
      if (nd <= 0) q.push(d);
    }
  }
  for (const t of tasksDef) if (!levels.has(t.task_id)) levels.set(t.task_id, 0);

  const byLevel = new Map<number, string[]>();
  for (const [id, lv] of levels) { if (!byLevel.has(lv)) byLevel.set(lv, []); byLevel.get(lv)!.push(id); }

  const maxPer = Math.max(...[...byLevel.values()].map(v => v.length));
  const totalH = maxPer * (NH + VG) - VG;
  const maxLv = Math.max(...levels.values(), 0);

  const pos = new Map<string, { x: number; y: number }>();
  for (const [lv, ids] of byLevel) {
    const lvH = ids.length * (NH + VG) - VG;
    const startY = (totalH - lvH) / 2;
    ids.forEach((id, i) => pos.set(id, { x: lv * (NW + HG), y: startY + i * (NH + VG) }));
  }

  const nodes: GNode[] = tasksDef.map(t => {
    const p = pos.get(t.task_id) ?? { x: 0, y: 0 };
    const ti = stateMap.get(t.task_id);
    return { id: t.task_id, x: p.x, y: p.y, state: ti?.state ?? null, opLabel: (t.operator_name ?? "").split(".").pop() ?? "Task", ti };
  });

  const edges: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const t of tasksDef) {
    const from = pos.get(t.task_id);
    if (!from) continue;
    for (const d of t.downstream_task_ids) {
      const to = pos.get(d);
      if (to) edges.push({ x1: from.x + NW, y1: from.y + NH / 2, x2: to.x, y2: to.y + NH / 2 });
    }
  }

  return { nodes, edges, svgW: (maxLv + 1) * (NW + HG) - HG, svgH: totalH };
}

const SRC_W = 120, SRC_H = NH; // source node dimensions (same height as task nodes)

function opIcon(opLabel: string): string {
  if (opLabel.toLowerCase().includes("spark")) return "⚡";
  if (opLabel.toLowerCase().includes("dq") || opLabel.toLowerCase().includes("gate")) return "◆";
  if (opLabel.toLowerCase().includes("trigger")) return "▶";
  if (opLabel.toLowerCase().includes("sensor")) return "⏳";
  if (opLabel.toLowerCase().includes("python") || opLabel.toLowerCase().includes("bash")) return "⚙";
  return "●";
}

function TaskGraph({ tasksDef, tasks, selectedTask, onSelectTask, sourceName }: {
  tasksDef: PipelineDetail["tasks_def"];
  tasks: TaskInstance[];
  selectedTask: string | null;
  onSelectTask: (id: string) => void;
  sourceName?: string;
}) {
  const { nodes, edges, svgW, svgH } = useMemo(() => buildGraph(tasksDef, tasks), [tasksDef, tasks]);

  if (!nodes.length) return (
    <div style={{ padding: "32px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
      <i className="fas fa-diagram-project" style={{ fontSize: 18, display: "block", marginBottom: 6 }} />
      No task graph available
    </div>
  );

  // Find root nodes (no incoming edges) to connect from the source node
  const hasUpstream = new Set<string>();
  for (const t of tasksDef) for (const d of t.downstream_task_ids) hasUpstream.add(d);
  const rootNodes = nodes.filter(n => !hasUpstream.has(n.id));

  const PAD = 16;
  const START_OFFSET = SRC_W + HG; // space for source rect + gap before first tasks

  const srcX = 0;
  const srcY = svgH / 2 - SRC_H / 2;

  return (
    <div style={{ overflowX: "auto", overflowY: "hidden", background: "#f8fafc", borderRadius: 10, border: "1px solid #e2e8f0", padding: PAD }}>
      <svg width={svgW + START_OFFSET + PAD} height={svgH + PAD} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <marker id="pg-arrow" viewBox="0 0 8 6" refX="7" refY="3" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" style={{ fill: "#94a3b8" }} />
          </marker>
        </defs>
        <g transform={`translate(${PAD / 2},${PAD / 2})`}>
          {/* Source → root task edges */}
          {rootNodes.map(root => {
            const toX = root.x + START_OFFSET;
            const toY = root.y + NH / 2;
            const fromX = srcX + SRC_W;
            const fromY = srcY + SRC_H / 2;
            const cx = (fromX + toX) / 2;
            return (
              <path key={`src-${root.id}`}
                d={`M ${fromX} ${fromY} C ${cx} ${fromY} ${cx} ${toY} ${toX} ${toY}`}
                style={{ fill: "none", stroke: "#cbd5e1", strokeWidth: 1.5 }}
                markerEnd="url(#pg-arrow)"
              />
            );
          })}
          {/* Source node — rectangle styled like task nodes */}
          <rect x={srcX} y={srcY} width={SRC_W} height={SRC_H} rx={8}
            style={{ fill: "#f0f9ff", stroke: "#7dd3fc", strokeWidth: 1.5 }} />
          <rect x={srcX} y={srcY} width={4} height={SRC_H} rx={2}
            style={{ fill: "#0ea5e9" }} />
          <text x={srcX + 18} y={srcY + SRC_H / 2 + 1} textAnchor="middle" dominantBaseline="middle"
            style={{ fontSize: "12px", userSelect: "none", fontFamily: "system-ui,sans-serif", fill: "#0ea5e9" }}>🗄</text>
          <text x={srcX + 30} y={srcY + 18} style={{ fontSize: "10px", fontWeight: "700", fill: "#0369a1", fontFamily: "system-ui,sans-serif", userSelect: "none" }}>
            {(sourceName ?? "SOURCE").length > 14 ? (sourceName ?? "SOURCE").slice(0, 13) + "…" : (sourceName ?? "SOURCE")}
          </text>
          <text x={srcX + 30} y={srcY + 34} style={{ fontSize: "9px", fill: "#94a3b8", fontFamily: "system-ui,sans-serif", userSelect: "none" }}>
            External Source
          </text>

          {/* Task-to-task edges (offset right by START_OFFSET) */}
          {edges.map((e, i) => {
            const x1 = e.x1 + START_OFFSET, y1 = e.y1, x2 = e.x2 + START_OFFSET, y2 = e.y2;
            const cx = (x1 + x2) / 2;
            return (
              <path key={i}
                d={`M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`}
                style={{ fill: "none", stroke: "#cbd5e1", strokeWidth: 1.5 }}
                markerEnd="url(#pg-arrow)"
              />
            );
          })}
          {/* Task nodes */}
          {nodes.map(({ id, x: nx, y: ny, state, opLabel }) => {
            const x = nx + START_OFFSET;
            const y = ny;
            const s = state ? (STATE[state] ?? null) : null;
            const isSel = selectedTask === id;
            return (
              <g key={id} style={{ cursor: "pointer" }} onClick={() => onSelectTask(id)}>
                {isSel && <rect x={x - 3} y={y - 3} width={NW + 6} height={NH + 6} rx={10} style={{ fill: "var(--forge-primary)", opacity: 0.12 }} />}
                <rect x={x} y={y} width={NW} height={NH} rx={8}
                  style={{ fill: s?.bg ?? "#fff", stroke: isSel ? "var(--forge-primary)" : (s ? s.color + "44" : "#e2e8f0"), strokeWidth: isSel ? 2 : 1 }}
                />
                <rect x={x} y={y} width={4} height={NH} rx={2} style={{ fill: s?.dot ?? "#cbd5e1" }} />
                {/* Operator icon */}
                <text x={x + 14} y={y + NH / 2 + 1} textAnchor="middle" dominantBaseline="middle"
                  style={{ fontSize: "11px", userSelect: "none", fontFamily: "system-ui,sans-serif", fill: s?.color ?? "#94a3b8" }}>
                  {opIcon(opLabel)}
                </text>
                <text x={x + 26} y={y + 20} style={{ fontSize: "11px", fontWeight: "600", fill: s?.color ?? "#1e293b", fontFamily: "system-ui,sans-serif", userSelect: "none" }}>
                  {id.length > 17 ? id.slice(0, 15) + "…" : id}
                </text>
                <text x={x + 26} y={y + 36} style={{ fontSize: "10px", fill: "#94a3b8", fontFamily: "system-ui,sans-serif", userSelect: "none" }}>
                  {opLabel.length > 20 ? opLabel.slice(0, 18) + "…" : opLabel}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ── Column styles ─────────────────────────────────────────────────────────────

const COL: React.CSSProperties = {
  display: "flex", flexDirection: "column",
  background: "#fff", border: "1px solid #e2e8f0",
  borderRadius: 12, overflow: "hidden",
  boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
};
const COL_HEAD: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid #f1f5f9", flexShrink: 0 };
const COL_BODY: React.CSSProperties = { overflowY: "auto", flex: 1 };

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PipelinesPage() {
  const { getToken, role } = useAuth();
  const { isDev } = useForgeEnv();
  const searchParams = useSearchParams();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [myDagIds, setMyDagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [selectedDagId, setSelectedDagId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<TaskInstance[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const [triggering, setTriggering] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [restateModal, setRestateModal] = useState<{ dag_id: string; fromDate: string; toDate: string } | null>(null);
  const [restating, setRestating] = useState(false);
  // expandedGroups = set of date keys the user has opened; empty = all collapsed
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [bulkCancelling, setBulkCancelling] = useState(false);
  const [refreshingRuns, setRefreshingRuns] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [pausing, setPausing] = useState(false);

  const canTrigger = role === "Admin" || role === "Editor";

  useEffect(() => {
    apiFetch<Pipeline[]>("/api/pipelines", getToken).then(list => {
      setPipelines(list);
      // Auto-select DAG from ?dag= URL param (e.g. linked from Datasets page)
      const dagParam = searchParams.get("dag");
      if (dagParam && list.some(p => p.dag_id === dagParam)) {
        setSelectedDagId(dagParam);
      }
    }).catch(() => {}).finally(() => setLoading(false));
    apiFetch<string[]>("/api/pipelines/mine", getToken).then(setMyDagIds).catch(() => {});
  }, [getToken, searchParams]);

  useEffect(() => {
    if (!selectedDagId) { setDetail(null); setSelectedRun(null); setTasks([]); setSelectedTask(null); setSelectedRunIds(new Set()); setExpandedGroups(new Set()); return; }
    setDetailLoading(true); setDetail(null); setSelectedRun(null); setTasks([]); setSelectedTask(null); setLogsOpen(false);
    apiFetch<PipelineDetail>(`/api/pipelines/${selectedDagId}`, getToken)
      .then(d => { setDetail(d); if (d.recent_runs.length > 0) setSelectedRun(d.recent_runs[0]); })
      .catch(() => {}).finally(() => setDetailLoading(false));
  }, [selectedDagId, getToken]);

  function fetchTasks(dagId: string, run: Run) {
    setTasksLoading(true);
    apiFetch<TaskInstance[]>(`/api/pipelines/${dagId}/runs/${run.dag_run_id}/tasks`, getToken)
      .then(all => {
        const latest = new Map<string, TaskInstance>();
        for (const t of all) {
          const ex = latest.get(t.task_id);
          if (!ex || (t.try_number ?? 0) > (ex.try_number ?? 0)) latest.set(t.task_id, t);
        }
        setTasks([...latest.values()]);
      })
      .catch(() => setTasks([])).finally(() => setTasksLoading(false));
  }

  useEffect(() => {
    if (!selectedRun || !selectedDagId) { setTasks([]); setSelectedTask(null); setLogsOpen(false); return; }
    setSelectedTask(null); setLogsOpen(false);
    fetchTasks(selectedDagId, selectedRun);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun, selectedDagId, getToken]);

  async function fetchLogs(task_id: string, tryNum = 1) {
    if (!selectedRun || !selectedDagId) return;
    setLogsLoading(true); setLogsOpen(true); setLogsContent("");
    try {
      const res = await apiFetch<{ logs: string }>(
        `/api/pipelines/${selectedDagId}/runs/${encodeURIComponent(selectedRun.dag_run_id)}/tasks/${task_id}/logs?attempt=${tryNum}`,
        getToken
      );
      setLogsContent(res.logs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLogsContent(`Failed to load logs:\n${msg}`);
    }
    finally { setLogsLoading(false); }
  }

  function handleSelectTask(id: string) {
    if (selectedTask === id) { setSelectedTask(null); setLogsContent(""); return; }
    const inst = tasks.find(t => t.task_id === id);
    setSelectedTask(id); setLogsContent("");
    fetchLogs(id, inst?.try_number ? Math.max(1, inst.try_number) : 1);
  }

  function flash(ok: boolean, msg: string) { setActionMsg({ ok, msg }); setTimeout(() => setActionMsg(null), 5000); }

  async function handleTrigger(dag_id: string, force = false) {
    setTriggering(dag_id); setStopConfirm(null);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/trigger`, getToken, { method: "POST", body: JSON.stringify({ conf: {}, force }) });
      flash(true, force ? "Active run cancelled — new run triggered" : "Triggered");
      setPipelines(prev => prev.map(p => p.dag_id === dag_id ? { ...p, last_run_state: "queued" } : p));
    } catch (e: unknown) { flash(false, e instanceof Error ? e.message : "Trigger failed"); }
    finally { setTriggering(null); }
  }

  async function handleRestate() {
    if (!restateModal) return;
    const { dag_id, fromDate, toDate } = restateModal;
    setRestating(true);
    try {
      const res = await apiFetch<{ triggered: string[]; errors: string[]; days: number }>(
        `/api/pipelines/${dag_id}/restate`, getToken,
        { method: "POST", body: JSON.stringify({ from_date: fromDate, to_date: toDate, conf: {} }) }
      );
      const errStr = res.errors.length ? ` (${res.errors.length} failed)` : "";
      flash(res.errors.length === 0, `Restate submitted: ${res.triggered.length} of ${res.days} day(s) queued${errStr}`);
      setPipelines(prev => prev.map(p => p.dag_id === dag_id ? { ...p, last_run_state: "queued" } : p));
      setRestateModal(null);
    } catch (e: unknown) { flash(false, e instanceof Error ? e.message : "Restate failed"); }
    finally { setRestating(false); }
  }

  async function handleDelete(dag_id: string) {
    setDeleting(dag_id); setDeleteConfirm(null);
    try {
      await apiFetch(`/api/pipelines/${dag_id}`, getToken, { method: "DELETE" });
      flash(true, `Pipeline "${dag_id}" deleted`);
      setSelectedDagId(null);
      setPipelines(prev => prev.filter(p => p.dag_id !== dag_id));
      setMyDagIds(prev => prev.filter(id => id !== dag_id));
    } catch (e: unknown) { flash(false, e instanceof Error ? e.message : "Delete failed"); }
    finally { setDeleting(null); }
  }

  async function handlePause(dag_id: string, isPaused: boolean) {
    setPausing(true);
    try {
      const action = isPaused ? "unpause" : "pause";
      await apiFetch(`/api/pipelines/${dag_id}/${action}`, getToken, { method: "POST" });
      const next = !isPaused;
      setPipelines(prev => prev.map(p => p.dag_id === dag_id ? { ...p, is_paused: next, is_active: !next } : p));
      setDetail(prev => prev ? { ...prev, is_paused: next } : prev);
      flash(true, `Pipeline "${dag_id}" ${next ? "paused" : "unpaused"}`);
    } catch (e: unknown) { flash(false, e instanceof Error ? e.message : "Action failed"); }
    finally { setPausing(false); }
  }

  async function handleBulkCancel() {
    if (!detail || selectedRunIds.size === 0) return;
    setBulkCancelling(true);
    const ids = [...selectedRunIds];
    let ok = 0, fail = 0;
    for (const run_id of ids) {
      try {
        await apiFetch(`/api/pipelines/${detail.dag_id}/runs/${run_id}/cancel`, getToken, { method: "POST" });
        ok++;
      } catch { fail++; }
    }
    setBulkCancelling(false);
    setSelectedRunIds(new Set());
    flash(fail === 0, `Cancelled ${ok} run${ok !== 1 ? "s" : ""}${fail ? ` (${fail} failed)` : ""}`);
  }

  async function handleRerun(dag_id: string) {
    setRerunning(true);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/trigger`, getToken, { method: "POST", body: JSON.stringify({ conf: {}, force: false }) });
      flash(true, "New run triggered");
      setPipelines(prev => prev.map(p => p.dag_id === dag_id ? { ...p, last_run_state: "queued" } : p));
    } catch (e: unknown) { flash(false, e instanceof Error ? e.message : "Rerun failed"); }
    finally { setRerunning(false); }
  }

  async function handleRestartRun(dag_id: string, run_id: string) {
    setRestarting(true);
    try {
      await apiFetch(`/api/pipelines/${dag_id}/runs/${run_id}/restart`, getToken, { method: "POST" });
      flash(true, "Run deleted and fresh run triggered");
      setSelectedRun(null);
      setPipelines(prev => prev.map(p => p.dag_id === dag_id ? { ...p, last_run_state: "queued" } : p));
    } catch (e: unknown) { flash(false, e instanceof Error ? e.message : "Restart failed"); }
    finally { setRestarting(false); }
  }

  async function refreshRuns() {
    if (!selectedDagId) return;
    setRefreshingRuns(true);
    setExpandedGroups(new Set());
    setSelectedRunIds(new Set());
    try {
      const d = await apiFetch<PipelineDetail>(`/api/pipelines/${selectedDagId}`, getToken);
      setDetail(d);
      if (d.recent_runs.length > 0) setSelectedRun(d.recent_runs[0]);
    } catch { /* silent */ }
    finally { setRefreshingRuns(false); }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return pipelines;
    const q = search.toLowerCase();
    return pipelines.filter(p => p.dag_id.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || p.tags.some(t => t.toLowerCase().includes(q)));
  }, [pipelines, search]);

  const groups = useMemo(() => detail ? groupRuns(detail.recent_runs) : [], [detail]);
  const selTaskDef = detail?.tasks_def.find(t => t.task_id === selectedTask);
  const selTaskInst = tasks.find(t => t.task_id === selectedTask);
  // Bronze: source:TlcYellowTrip tag → show external data source name
  // Silver/Gold: ExternalTaskSensor task_id like "wait_for_nyc_taxi_bronze" → show upstream DAG name
  const sourceName =
    detail?.tags?.find(t => t.startsWith("source:"))?.slice(7) ??
    detail?.tasks_def?.find(t => t.operator_name?.toLowerCase().includes("externaltasksensor"))
      ?.task_id.replace(/^wait_for_/, "");

  const heroContent = (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {[
        { label: "Total",  value: loading ? "—" : pipelines.length, icon: "fa-layer-group" },
        { label: "Mine",   value: loading ? "—" : myDagIds.length,  icon: "fa-user" },
        { label: "Active", value: loading ? "—" : pipelines.filter(p => p.is_active && !p.is_paused).length, icon: "fa-circle-play" },
        { label: "Paused", value: loading ? "—" : pipelines.filter(p => p.is_paused).length, icon: "fa-pause-circle" },
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

  // ── Restate date-range modal ─────────────────────────────────────────────────
  const restateDays = restateModal
    ? Math.round((new Date(restateModal.toDate).getTime() - new Date(restateModal.fromDate).getTime()) / 86400000) + 1
    : 0;

  const restateModalEl = restateModal && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.18)", padding: "28px 32px", minWidth: 340, maxWidth: 420 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <i className="fas fa-rotate-left" style={{ color: "var(--forge-primary)", fontSize: 16 }} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>Restate Pipeline</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{restateModal.dag_id}</div>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 4 }}>From Date</label>
          <input type="date" value={restateModal.fromDate}
            onChange={e => setRestateModal(m => m ? { ...m, fromDate: e.target.value } : m)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 4 }}>To Date</label>
          <input type="date" value={restateModal.toDate}
            onChange={e => setRestateModal(m => m ? { ...m, toDate: e.target.value } : m)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>
        {restateDays > 0 && (
          <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#0369a1", marginBottom: 16 }}>
            <i className="fas fa-info-circle" style={{ marginRight: 6 }} />
            {restateDays} day{restateDays !== 1 ? "s" : ""} will be restated. Any existing runs for these dates will be cleared and requeued from scratch.
          </div>
        )}
        {restateDays <= 0 && (
          <div style={{ background: "#fff1f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#dc2626", marginBottom: 16 }}>
            <i className="fas fa-exclamation-triangle" style={{ marginRight: 6 }} />From date must be ≤ To date
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setRestateModal(null)} disabled={restating}
            style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #e2e8f0", background: "transparent", color: "#64748b", fontSize: 13, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={handleRestate} disabled={restating || restateDays <= 0}
            style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: restateDays > 0 ? "var(--forge-primary)" : "#e2e8f0", color: restateDays > 0 ? "#fff" : "#94a3b8", fontSize: 13, fontWeight: 700, cursor: restateDays > 0 ? "pointer" : "not-allowed" }}>
            <i className={`fas ${restating ? "fa-spinner fa-spin" : "fa-rotate-left"}`} style={{ marginRight: 6, fontSize: 11 }} />
            {restating ? "Restating…" : `Restate ${restateDays > 0 ? `${restateDays} day${restateDays !== 1 ? "s" : ""}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
    <PageLayout icon="fa-sitemap" title="Pipelines" subtitle="Browse, monitor and trigger your Forge data pipelines" heroContent={heroContent} fullHeight>

      {actionMsg && (
        <div style={{ background: actionMsg.ok ? "#f0fdf4" : "#fff1f2", border: `1px solid ${actionMsg.ok ? "#86efac" : "#fca5a5"}`, borderRadius: 10, padding: "10px 16px", marginBottom: 14, color: actionMsg.ok ? "#16a34a" : "#dc2626", fontSize: 13 }}>
          <i className={`fas ${actionMsg.ok ? "fa-check-circle" : "fa-circle-exclamation"}`} style={{ marginRight: 8 }} />{actionMsg.msg}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "250px 268px 1fr", gap: 16, height: "100%", minHeight: 480 }}>

        {/* ── Col 1: Pipeline list ── */}
        <div style={COL}>
          <div style={{ ...COL_HEAD, borderTop: "3px solid var(--forge-primary)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 8 }}>
              Pipelines · {filtered.length}
            </div>
            <div style={{ position: "relative" }}>
              <i className="fas fa-magnifying-glass" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 11 }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by name or tag…"
                style={{ width: "100%", padding: "7px 10px 7px 30px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12, boxSizing: "border-box", outline: "none", background: "#f8fafc" }}
              />
            </div>
          </div>
          <div style={COL_BODY}>
            {loading ? (
              <ForgeLoader text="Loading pipelines…" fullscreen={false} />
            ) : filtered.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>No pipelines found</div>
            ) : filtered.map(p => {
              const isSel = selectedDagId === p.dag_id;
              const dot = STATE[p.last_run_state ?? ""]?.dot ?? (p.is_paused ? "#94a3b8" : "#22c55e");
              return (
                <button key={p.dag_id} onClick={() => setSelectedDagId(isSel ? null : p.dag_id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                    background: isSel ? "rgba(var(--forge-primary-rgb,99,102,241),0.07)" : "transparent",
                    border: "none", borderLeft: isSel ? "3px solid var(--forge-primary)" : "3px solid transparent",
                    borderBottom: "1px solid #f8fafc", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0, boxShadow: p.last_run_state === "running" ? `0 0 0 4px ${dot}30` : "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div title={p.dag_id} style={{ fontSize: 13, fontWeight: isSel ? 700 : 600, color: isSel ? "var(--forge-primary)" : "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.dag_id}
                    </div>
                    {p.description && <div title={p.description} style={{ fontSize: 11, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description}</div>}
                  </div>
                  {p.is_paused
                    ? <i className="fas fa-pause" style={{ color: "#94a3b8", fontSize: 9, flexShrink: 0 }} />
                    : p.last_run_state ? <StateBadge state={p.last_run_state} /> : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Col 2: Run history ── */}
        <div style={COL}>
          <div style={{ ...COL_HEAD, borderTop: `3px solid ${detail?.is_paused ? "#94a3b8" : "#10b981"}` }}>
            {detail ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span title={detail.dag_id} style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{detail.dag_id}</span>
                  {detail.is_paused
                    ? <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: "#f1f5f9", color: "#94a3b8", flexShrink: 0 }}>PAUSED</span>
                    : <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: "#dcfce7", color: "#16a34a", flexShrink: 0 }}>ACTIVE</span>}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {canTrigger && (
                    <>
                      {/* Restate — shown when active run or dev mode */}
                      {(detail.last_run_state === "running" || detail.last_run_state === "queued") ? (
                        <button onClick={() => {
                          const runDate = selectedRun?.logical_date?.split("T")[0]
                            ?? detail.recent_runs[0]?.logical_date?.split("T")[0]
                            ?? new Date().toISOString().split("T")[0];
                          setRestateModal({ dag_id: detail.dag_id, fromDate: runDate, toDate: runDate });
                        }} disabled={triggering === detail.dag_id}
                          style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #f59e0b", background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                          <i className="fas fa-rotate-right" style={{ marginRight: 4, fontSize: 9 }} />Restate
                        </button>
                      ) : isDev ? (
                        <button onClick={() => {
                          const lastDate = detail.recent_runs[0]?.logical_date?.split("T")[0] ?? new Date().toISOString().split("T")[0];
                          setRestateModal({ dag_id: detail.dag_id, fromDate: lastDate, toDate: lastDate });
                        }}
                          style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid var(--forge-primary)", background: "var(--forge-primary)", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                          <i className="fas fa-rotate-left" style={{ marginRight: 4, fontSize: 9 }} />Restate
                        </button>
                      ) : null}

                      {/* Pause / Unpause */}
                      {canTrigger && (
                        <button onClick={() => handlePause(detail.dag_id, detail.is_paused)} disabled={pausing}
                          title={detail.is_paused ? "Unpause pipeline" : "Pause pipeline"}
                          style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid #e2e8f0", background: "transparent", color: detail.is_paused ? "#16a34a" : "#64748b", fontSize: 11, cursor: "pointer" }}>
                          <i className={`fas ${pausing ? "fa-spinner fa-spin" : detail.is_paused ? "fa-circle-play" : "fa-pause"}`} style={{ fontSize: 9 }} />
                        </button>
                      )}

                      {/* Delete — dev only */}
                      {isDev && (
                        deleteConfirm === detail.dag_id ? (
                          <>
                            <button onClick={() => handleDelete(detail.dag_id)} disabled={deleting === detail.dag_id}
                              style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #ef4444", background: "#fee2e2", color: "#dc2626", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                              <i className={`fas ${deleting === detail.dag_id ? "fa-spinner fa-spin" : "fa-trash"}`} style={{ marginRight: 4, fontSize: 9 }} />Confirm Delete
                            </button>
                            <button onClick={() => setDeleteConfirm(null)}
                              style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid #e2e8f0", background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer" }}>Cancel</button>
                          </>
                        ) : (
                          <button onClick={() => setDeleteConfirm(detail.dag_id)}
                            style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid #e2e8f0", background: "transparent", color: "#ef4444", fontSize: 11, cursor: "pointer" }}>
                            <i className="fas fa-trash" style={{ fontSize: 9 }} />
                          </button>
                        )
                      )}
                    </>
                  )}
                  <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: "auto" }}>{groups.length} slot{groups.length !== 1 ? "s" : ""}</span>
                  <button onClick={refreshRuns} disabled={refreshingRuns}
                    title="Refresh runs"
                    style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #e2e8f0", background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center" }}>
                    <i className={`fas fa-rotate-right${refreshingRuns ? " fa-spin" : ""}`} style={{ fontSize: 10 }} />
                  </button>
                </div>

                {/* Bulk action bar — shown when runs are selected */}
                {selectedRunIds.size > 0 && canTrigger && (
                  <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", padding: "6px 10px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#0284c7", flex: 1 }}>
                      {selectedRunIds.size} selected
                    </span>
                    <button onClick={() => {
                      const selRuns = detail.recent_runs.filter(r => selectedRunIds.has(r.dag_run_id));
                      const dates = selRuns.map(r => r.logical_date?.split("T")[0] ?? r.start_date?.split("T")[0] ?? "").filter(Boolean).sort();
                      if (dates.length === 0) return;
                      setRestateModal({ dag_id: detail.dag_id, fromDate: dates[0], toDate: dates[dates.length - 1] });
                    }}
                      style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--forge-primary)", background: "var(--forge-primary)", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      <i className="fas fa-rotate-left" style={{ marginRight: 4, fontSize: 9 }} />Restate
                    </button>
                    <button onClick={handleBulkCancel} disabled={bulkCancelling}
                      style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #ef4444", background: "#fee2e2", color: "#dc2626", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      <i className={`fas ${bulkCancelling ? "fa-spinner fa-spin" : "fa-ban"}`} style={{ marginRight: 4, fontSize: 9 }} />Cancel
                    </button>
                    <button onClick={() => setSelectedRunIds(new Set())}
                      style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #e2e8f0", background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer" }}>
                      <i className="fas fa-xmark" style={{ fontSize: 10 }} />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8" }}>Run History</div>
            )}
          </div>
          <div style={COL_BODY}>
            {!selectedDagId ? (
              <div style={{ padding: "48px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                <i className="fas fa-hand-pointer" style={{ fontSize: 22, display: "block", marginBottom: 10 }} />Select a pipeline
              </div>
            ) : detailLoading ? (
              <ForgeLoader text="Loading runs…" fullscreen={false} />
            ) : groups.length === 0 ? (
              <div style={{ padding: "48px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>No runs yet</div>
            ) : groups.map(group => {
              const gState = groupState(group.runs);
              const gs = gState ? (STATE[gState] ?? null) : null;
              const isSelGroup = selectedRun && group.runs.some(r => r.dag_run_id === selectedRun.dag_run_id);
              const isExpanded = expandedGroups.has(group.key);
              const toggleCollapse = (e: React.MouseEvent) => {
                e.stopPropagation();
                setExpandedGroups(prev => {
                  const next = new Set(prev);
                  next.has(group.key) ? next.delete(group.key) : next.add(group.key);
                  return next;
                });
              };
              const borderColor = gs?.dot ?? "#e2e8f0";
              return (
                <div key={group.key} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  {/* Date group header */}
                  <div style={{
                    display: "flex", alignItems: "center",
                    borderLeft: `3px solid ${isSelGroup ? "var(--forge-primary)" : borderColor}`,
                    background: isSelGroup ? "rgba(var(--forge-primary-rgb,99,102,241),0.04)" : "#fafbfc",
                  }}>
                    <button onClick={() => {
                        setSelectedRun(group.runs[0]);
                        setExpandedGroups(prev => { const next = new Set(prev); next.add(group.key); return next; });
                      }}
                      style={{
                        flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "9px 10px 9px 12px",
                        border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
                      }}
                    >
                      <span style={{
                        width: 9, height: 9, borderRadius: "50%", background: gs?.dot ?? "#94a3b8", flexShrink: 0,
                        boxShadow: gState === "running" ? `0 0 0 3px ${gs?.dot ?? "#94a3b8"}30` : "none",
                      }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: isSelGroup ? "var(--forge-primary)" : "#0f172a" }}>
                          {fmtDate(group.key)}
                        </div>
                        <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>
                          {group.runs.length} run{group.runs.length !== 1 ? "s" : ""}
                          {group.runs[0]?.start_date && (
                            <> · {dur(group.runs[0].start_date, group.runs[0].end_date)}</>
                          )}
                        </div>
                      </div>
                      {gs && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 6,
                          background: gs.bg, color: gs.color, whiteSpace: "nowrap",
                        }}>
                          {gs.label}
                        </span>
                      )}
                    </button>
                    <button onClick={toggleCollapse}
                      style={{ padding: "6px 10px", border: "none", background: "transparent", cursor: "pointer", color: isExpanded ? "var(--forge-primary)" : "#94a3b8", fontSize: 10, flexShrink: 0 }}
                      title={isExpanded ? "Collapse" : "Expand"}>
                      <i className={`fas fa-chevron-${isExpanded ? "up" : "down"}`} />
                    </button>
                  </div>

                  {/* Individual run rows */}
                  {isExpanded && group.runs.map((run) => {
                    const isSel = selectedRun?.dag_run_id === run.dag_run_id;
                    const isChecked = selectedRunIds.has(run.dag_run_id);
                    const rs = STATE[run.state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: run.state };
                    const runLabel = run.run_type === "manual" || run.dag_run_id.startsWith("manual__")
                      ? "Manual"
                      : run.dag_run_id.startsWith("restate__")
                      ? "Restate"
                      : run.dag_run_id.startsWith("backfill__")
                      ? "Backfill"
                      : "Scheduled";
                    const runTime = run.logical_date
                      ? new Date(run.logical_date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
                      : "";
                    return (
                      <div key={run.dag_run_id} style={{
                        display: "flex", alignItems: "center", gap: 0,
                        borderLeft: `3px solid ${isSel ? "var(--forge-primary)" : "transparent"}`,
                        background: isSel ? "rgba(var(--forge-primary-rgb,99,102,241),0.06)" : "#fff",
                        borderBottom: "1px solid #f8fafc",
                      }}>
                        {/* Checkbox */}
                        {canTrigger && (
                          <div
                            onClick={e => {
                              e.stopPropagation();
                              setSelectedRunIds(prev => {
                                const next = new Set(prev);
                                next.has(run.dag_run_id) ? next.delete(run.dag_run_id) : next.add(run.dag_run_id);
                                return next;
                              });
                            }}
                            style={{ padding: "0 6px 0 10px", cursor: "pointer", display: "flex", alignItems: "center" }}
                          >
                            <div style={{
                              width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                              border: `2px solid ${isChecked ? "var(--forge-primary)" : "#cbd5e1"}`,
                              background: isChecked ? "var(--forge-primary)" : "#fff",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>
                              {isChecked && <i className="fas fa-check" style={{ fontSize: 7, color: "#fff" }} />}
                            </div>
                          </div>
                        )}
                        {/* Status bar */}
                        <div style={{ width: 3, alignSelf: "stretch", background: rs.dot, flexShrink: 0, marginRight: 8 }} />
                        {/* Run info — click to select */}
                        <button onClick={() => setSelectedRun(run)} style={{
                          flex: 1, display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 10px 6px 0", border: "none", background: "transparent",
                          cursor: "pointer", textAlign: "left", minWidth: 0,
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: isSel ? "var(--forge-primary)" : "#374151" }}>
                              {runLabel}{runTime ? ` · ${runTime}` : ""}
                            </div>
                            {run.start_date && (
                              <div style={{ fontSize: 10, color: "#94a3b8" }}>{dur(run.start_date, run.end_date)}</div>
                            )}
                          </div>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 5,
                            background: rs.bg, color: rs.color, whiteSpace: "nowrap", flexShrink: 0,
                          }}>
                            {rs.label}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Col 3: Graph + detail ── */}
        <div style={{ ...COL, overflow: "hidden" }}>
          {!selectedDagId ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#94a3b8", gap: 8 }}>
              <i className="fas fa-diagram-project" style={{ fontSize: 32 }} />
              <div style={{ fontSize: 14, fontWeight: 600, color: "#64748b" }}>Select a pipeline to explore</div>
              <div style={{ fontSize: 12 }}>Task graph and run details appear here</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

              {/* Graph panel */}
              <div style={{ flexShrink: 0, padding: "12px 16px 10px", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <i className="fas fa-diagram-project" style={{ color: "var(--forge-primary)", fontSize: 11 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b" }}>
                    Task Graph
                  </span>
                  {tasksLoading && <i className="fas fa-spinner fa-spin" style={{ fontSize: 10, color: "#94a3b8", marginLeft: 4 }} />}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                    {tasks.length > 0 && (
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        {Object.entries(STATE).filter(([k]) => tasks.some(t => t.state === k)).map(([, s]) => (
                          <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#64748b" }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot }} />{s.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {selectedRun && selectedDagId && (
                      <button
                        onClick={() => fetchTasks(selectedDagId, selectedRun)}
                        disabled={tasksLoading}
                        title="Refresh graph"
                        style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 7px", cursor: tasksLoading ? "not-allowed" : "pointer", color: "#64748b", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
                      >
                        <i className={`fas ${tasksLoading ? "fa-spinner fa-spin" : "fa-rotate-right"}`} style={{ fontSize: 10 }} />
                        Refresh
                      </button>
                    )}
                  </div>
                </div>
                {/* Deployment provenance strip */}
                {(detail?.owner_alias || detail?.owner_email || detail?.deployed_at) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "5px 0 8px", borderBottom: "1px solid #f1f5f9", marginBottom: 8, flexWrap: "wrap" }}>
                    {(detail.owner_alias || detail.owner_email) && (
                      <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748b" }}>
                        <i className="fas fa-user-gear" style={{ fontSize: 10, color: "#94a3b8" }} />
                        <span style={{ fontWeight: 600, color: "#374151" }}>{detail.owner_alias || detail.owner_email}</span>
                      </span>
                    )}
                    {detail.deployed_at && (
                      <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748b" }}>
                        <i className="fas fa-rocket" style={{ fontSize: 10, color: "#94a3b8" }} />
                        Deployed {new Date(detail.deployed_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </div>
                )}
                {detailLoading ? (
                  <ForgeLoader text="Loading graph…" fullscreen={false} />
                ) : (
                  <TaskGraph tasksDef={detail?.tasks_def ?? []} tasks={tasks} selectedTask={selectedTask} onSelectTask={handleSelectTask} sourceName={sourceName} />
                )}
              </div>

              {/* Detail panel */}
              <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px 32px" }}>
                {!selectedRun ? (
                  <div style={{ padding: "32px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                    <i className="fas fa-mouse-pointer" style={{ fontSize: 20, display: "block", marginBottom: 10 }} />
                    Select a run from the history panel
                  </div>
                ) : (
                  <>
                    {/* Run summary */}
                    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <StateBadge state={selectedRun.state} />
                        {selectedRun.run_type === "manual" && (
                          <span style={{ padding: "1px 7px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: "#f1f5f9", color: "#64748b" }}>MANUAL</span>
                        )}
                        <span title={selectedRun.dag_run_id} style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                          {fmtRunId(selectedRun.dag_run_id, selectedRun.run_type)}
                        </span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                        {[
                          { label: "Run date", value: fmtDate(selectedRun.logical_date) },
                          { label: "Started",  value: fmt(selectedRun.start_date) },
                          { label: "Duration", value: dur(selectedRun.start_date, selectedRun.end_date) },
                        ].map(s => (
                          <div key={s.label}>
                            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#94a3b8" }}>{s.label}</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", marginTop: 2 }}>{s.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Rerun / Restart — only for failed runs with canTrigger */}
                      {canTrigger && selectedRun.state === "failed" && selectedDagId && (
                        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                          <button
                            onClick={() => handleRerun(selectedDagId)}
                            disabled={rerunning || restarting}
                            style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "1px solid var(--forge-primary)", background: "transparent", color: "var(--forge-primary)", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                          >
                            <i className={`fas ${rerunning ? "fa-spinner fa-spin" : "fa-rotate-right"}`} style={{ fontSize: 11 }} />
                            {rerunning ? "Running…" : "Rerun"}
                          </button>
                          <button
                            onClick={() => handleRestartRun(selectedDagId, selectedRun.dag_run_id)}
                            disabled={rerunning || restarting}
                            style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "none", background: "#fef3c7", color: "#d97706", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                          >
                            <i className={`fas ${restarting ? "fa-spinner fa-spin" : "fa-trash-can-arrow-up"}`} style={{ fontSize: 11 }} />
                            {restarting ? "Restarting…" : "Restart"}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Selected task detail */}
                    {selectedTask && (selTaskDef || selTaskInst) && (
                      <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
                        <div style={{ padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
                          <i className="fas fa-cube" style={{ color: "var(--forge-primary)", fontSize: 10 }} />
                          <span title={selectedTask} style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedTask}</span>
                          <StateBadge state={selTaskInst?.state ?? null} />
                          <button
                            onClick={() => { if (selTaskInst) fetchLogs(selectedTask, Math.max(1, selTaskInst.try_number || 1)); }}
                            disabled={logsLoading || !selTaskInst}
                            title="Refresh logs"
                            style={{ padding: "4px 8px", borderRadius: 7, border: "1px solid #e2e8f0", background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
                          >
                            <i className={`fas ${logsLoading ? "fa-spinner fa-spin" : "fa-rotate-right"}`} style={{ fontSize: 10 }} />
                          </button>
                          <button onClick={() => { setSelectedTask(null); setLogsOpen(false); }}
                            style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 14, padding: "0 2px" }}>✕</button>
                        </div>
                        <div style={{ padding: "10px 14px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                          {[
                            { label: "Operator", value: (selTaskDef?.operator_name ?? selTaskInst?.operator_name ?? selTaskInst?.operator ?? "—").split(".").pop() ?? "—" },
                            { label: "Duration", value: dur(selTaskInst?.start_date ?? null, selTaskInst?.end_date ?? null, selTaskInst?.duration) },
                            { label: "Attempt",  value: selTaskInst?.try_number != null ? `#${Math.max(1, selTaskInst.try_number)}` : "—" },
                          ].map(s => (
                            <div key={s.label}>
                              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#94a3b8" }}>{s.label}</div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a", marginTop: 2 }}>{s.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Log viewer — always visible when a task is selected */}
                    {selectedTask && (
                      <div style={{ background: "#0f172a", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
                        <div style={{ padding: "8px 14px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 8 }}>
                          <i className="fas fa-terminal" style={{ color: "#64748b", fontSize: 10 }} />
                          <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", flex: 1 }}>{selectedTask}</span>
                        </div>
                        <div style={{ padding: "12px 14px" }}>
                          {logsLoading ? (
                            <div style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>
                              <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading logs…
                            </div>
                          ) : (
                            <pre style={{ margin: 0, fontSize: 11, color: "#e2e8f0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 320, overflowY: "auto" }}>
                              {logsContent || "No log content."}
                            </pre>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Task list fallback (when no task selected in graph) */}
                    {!selectedTask && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 10 }}>
                          Activities{tasks.length > 0 ? ` · ${tasks.filter(t => !(t.operator_name ?? t.operator ?? "").includes("TriggerDagRunOperator")).length}` : ""}
                        </div>
                        {tasksLoading ? (
                          <ForgeLoader text="Loading tasks…" fullscreen={false} />
                        ) : tasks.filter(t => !(t.operator_name ?? t.operator ?? "").includes("TriggerDagRunOperator")).map(t => {
                          const s = t.state ? (STATE[t.state] ?? { bg: "#f1f5f9", color: "#64748b", dot: "#94a3b8", label: t.state }) : null;
                          return (
                            <div key={t.task_id} onClick={() => handleSelectTask(t.task_id)}
                              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", marginBottom: 6, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 9, cursor: "pointer" }}
                            >
                              <div style={{ width: 26, height: 26, borderRadius: 7, background: s?.bg ?? "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                {t.state === "running" ? <i className="fas fa-spinner fa-spin" style={{ color: s?.color, fontSize: 10 }} />
                                  : t.state === "success" ? <i className="fas fa-check" style={{ color: s?.color, fontSize: 10 }} />
                                  : t.state === "failed" ? <i className="fas fa-xmark" style={{ color: s?.color, fontSize: 10 }} />
                                  : <i className="fas fa-circle" style={{ color: s?.dot ?? "#94a3b8", fontSize: 7 }} />}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.task_id}</div>
                                <div style={{ fontSize: 11, color: "#94a3b8" }}>
                                  {(t.operator_name ?? t.operator ?? "—").split(".").pop()}
                                  {t.start_date && <> · {dur(t.start_date, t.end_date, t.duration)}</>}
                                  {t.try_number > 1 && <> · try #{t.try_number}</>}
                                </div>
                              </div>
                              <StateBadge state={t.state} />
                            </div>
                          );
                        })}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </PageLayout>
    {restateModalEl}
    </>
  );
}
