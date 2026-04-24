"use client";

import { useEffect, useState, useMemo } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";
import { ForgeLoader } from "../../components/ForgeLoader";

const ACCENT = "var(--forge-primary)";

const LAYER_META: Record<string, { color: string; icon: string; label: string }> = {
  bronze: { color: "#cd7f32", icon: "fa-layer-group", label: "Bronze" },
  silver: { color: "#94a3b8", icon: "fa-database",    label: "Silver" },
  gold:   { color: "#d4af37", icon: "fa-star",        label: "Gold"   },
};

const RUN_COLOR: Record<string, string> = {
  success: "#22c55e",
  running: "#3b82f6",
  failed:  "#ef4444",
  queued:  "#f59e0b",
};

function typeColor(t: string): string {
  const tl = t.toLowerCase();
  if (tl.includes("varchar") || tl.includes("char") || tl.includes("string")) return "#3b82f6";
  if (tl.includes("int") || tl.includes("bigint") || tl.includes("smallint") || tl.includes("double") || tl.includes("float") || tl.includes("decimal")) return "#10b981";
  if (tl.includes("timestamp") || tl.includes("date") || tl.includes("time")) return "#f59e0b";
  if (tl.includes("boolean") || tl.includes("bool")) return "#a855f7";
  return "#64748b";
}

interface Dataset {
  name: string;
  layer: "bronze" | "silver" | "gold";
  schema: string;
  row_count: number | null;
  last_updated: string | null;
  size_bytes: number | null;
  has_dq: boolean;
}

interface DQSummary {
  dataset: string;
  total_runs: number;
  pass_rate: number | null;
  last_run_at: string;
  critical_failures: number;
  warnings: number;
  last_status: string;
}

interface Pipeline {
  dag_id: string;
  is_active: boolean;
  last_run_state: string | null;
  last_run_at: string | null;
  tags: string[];
}

interface SchemaColumn {
  name: string;
  type: string;
  position: number;
}

interface DatasetDetail {
  columns: SchemaColumn[];
  stats: { row_count: number | null; last_updated: string | null; size_bytes: number | null };
}

function formatRows(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatBytes(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${(n / 1_024).toFixed(1)} KB`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function matchPipeline(pipelines: Pipeline[], d: Dataset): Pipeline | undefined {
  const nameNorm = d.name.replace(/[_-]/g, "").toLowerCase();
  return pipelines.find(p => {
    if (!p.dag_id.toLowerCase().includes(d.layer)) return false;
    const dagNorm = p.dag_id.replace(/[_-]/g, "").toLowerCase();
    // Direct: DAG name contains dataset name (e.g. nyctaxibronze in nyctaxibronze)
    if (dagNorm.includes(nameNorm)) return true;
    // Reverse: strip layer from DAG name to get project stem (e.g. "nyctaxi" from nyctaxisilver)
    // then check if dataset name starts with that stem (e.g. nyctaxitrips starts with nyctaxi)
    const dagStem = dagNorm.replace(/(bronze|silver|gold)$/, "");
    return dagStem.length >= 4 && nameNorm.startsWith(dagStem);
  });
}

function assetName(d: Dataset, pipelines: Pipeline[]): string {
  const pipeline = matchPipeline(pipelines, d);
  if (pipeline) {
    const outputTag = pipeline.tags?.find((t: string) => t.startsWith("output:"));
    if (outputTag) return outputTag.slice(7); // strip "output:" prefix → e.g. "NycTaxiBronze"
    return pipeline.dag_id.replace(/_?(bronze|silver|gold)$/i, "").replace(/_/g, " ");
  }
  return d.name;
}

// DQ status badge
function DQBadge({ status }: { status: string }) {
  const cfg: Record<string, { bg: string; color: string }> = {
    PASS: { bg: "#dcfce7", color: "#16a34a" },
    WARN: { bg: "#fef9c3", color: "#a16207" },
    FAIL: { bg: "#fee2e2", color: "#dc2626" },
  };
  const c = cfg[status] ?? { bg: "#f1f5f9", color: "#64748b" };
  return (
    <span style={{ padding: "2px 7px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: c.bg, color: c.color }}>{status}</span>
  );
}

export default function DatasetsPage() {
  const { getToken } = useAuth();
  const [datasets,  setDatasets]  = useState<Dataset[]>([]);
  const [dqMap,     setDqMap]     = useState<Record<string, DQSummary>>({});
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState<"all" | "bronze" | "silver" | "gold">("all");
  const [search,    setSearch]    = useState("");

  const [selected,      setSelected]      = useState<Dataset | null>(null);
  const [detail,        setDetail]        = useState<DatasetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    Promise.allSettled([
      apiFetch<Dataset[]>("/api/datasets", getToken),
      apiFetch<DQSummary[]>("/api/dq/summary", getToken),
      apiFetch<Pipeline[]>("/api/pipelines", getToken),
    ]).then(([dsRes, dqRes, plRes]) => {
      if (dsRes.status === "fulfilled") setDatasets(dsRes.value);
      else setError((dsRes.reason as Error).message);
      if (dqRes.status === "fulfilled") {
        const map: Record<string, DQSummary> = {};
        for (const s of dqRes.value) map[s.dataset] = s;
        setDqMap(map);
      }
      if (plRes.status === "fulfilled") setPipelines(plRes.value);
    }).finally(() => setLoading(false));
  }, [getToken]);

  function selectDataset(d: Dataset) {
    if (selected?.name === d.name && selected?.layer === d.layer) {
      setSelected(null); setDetail(null); return;
    }
    setSelected(d); setDetail(null); setDetailLoading(true);
    apiFetch<DatasetDetail>(`/api/datasets/${d.layer}/${d.name}/schema`, getToken)
      .then(setDetail)
      .catch(() => setDetail({ columns: [], stats: { row_count: null, last_updated: null, size_bytes: null } }))
      .finally(() => setDetailLoading(false));
  }

  const filtered = useMemo(() => {
    let list = datasets;
    if (activeLayer !== "all") list = list.filter(d => d.layer === activeLayer);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(q) || d.schema.toLowerCase().includes(q));
    }
    return list;
  }, [datasets, activeLayer, search]);

  const counts = useMemo(() => ({
    all:    datasets.length,
    bronze: datasets.filter(d => d.layer === "bronze").length,
    silver: datasets.filter(d => d.layer === "silver").length,
    gold:   datasets.filter(d => d.layer === "gold").length,
  }), [datasets]);

  const heroContent = (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      {([
        { key: "all",    label: "Total",  color: "rgba(255,255,255,0.9)" },
        { key: "bronze", label: "Bronze", color: LAYER_META.bronze.color },
        { key: "silver", label: "Silver", color: LAYER_META.silver.color },
        { key: "gold",   label: "Gold",   color: LAYER_META.gold.color },
      ] as const).map(({ key, label, color }) => (
        <div key={key} style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "8px 18px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{loading ? "—" : counts[key]}</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>{label}</span>
        </div>
      ))}
    </div>
  );

  const LEFT_COLS = "1fr 72px 1fr 130px";

  return (
    <PageLayout icon="fa-database" title="Dataset Catalog" subtitle="Explore datasets across Bronze, Silver, and Gold layers" heroContent={heroContent} fullHeight>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 4, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 4 }}>
          {(["all", "bronze", "silver", "gold"] as const).map(layer => (
            <button key={layer} onClick={() => setActiveLayer(layer)} style={{
              padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer",
              fontSize: 13, fontWeight: 600,
              background: activeLayer === layer ? (layer === "all" ? ACCENT : LAYER_META[layer].color) : "transparent",
              color: activeLayer === layer ? "#fff" : "#64748b",
              transition: "all 0.15s",
            }}>
              {layer === "all" ? "All" : LAYER_META[layer].label}
            </button>
          ))}
        </div>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <i className="fas fa-magnifying-glass" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 13 }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search datasets…"
            style={{ width: "100%", padding: "9px 12px 9px 36px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 14, background: "#fff", outline: "none", boxSizing: "border-box" }} />
        </div>
      </div>

      {/* Two-panel layout — always 50/50, fills remaining page height */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, minWidth: 0, flex: 1, overflow: "hidden" }}>

        {/* ── Left: Catalog table ── */}
        <div style={{ minWidth: 0, overflow: "auto", background: "#fff", border: `1px solid ${error ? "#fca5a5" : "#e2e8f0"}`, borderTop: `3px solid ${error ? "#ef4444" : ACCENT}`, borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
          {loading && <ForgeLoader text="Loading datasets…" fullscreen={false} />}
          {error && <div style={{ padding: "20px 24px", color: "#dc2626" }}><i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />{error}</div>}

          {!loading && !error && (
            filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>No datasets found</div>
            ) : (
              <div>
                {/* Header */}
                <div style={{ display: "grid", gridTemplateColumns: LEFT_COLS, background: "#f8fafc", borderBottom: "2px solid #e2e8f0" }}>
                  {["Dataset", "Layer", "Pipeline", "DQ Health"].map((h, i) => (
                    <div key={i} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{h}</div>
                  ))}
                </div>

                {filtered.map(d => {
                  const layerInfo = LAYER_META[d.layer] ?? LAYER_META.bronze;
                  const dq = dqMap[`${d.layer}/${d.name}`];
                  const pipeline = matchPipeline(pipelines, d);
                  const runColor = pipeline?.last_run_state ? (RUN_COLOR[pipeline.last_run_state] ?? "#94a3b8") : "#94a3b8";
                  const isSelected = selected?.name === d.name && selected?.layer === d.layer;

                  return (
                    <div key={`${d.layer}/${d.name}`}
                      onClick={() => selectDataset(d)}
                      style={{
                        display: "grid", gridTemplateColumns: LEFT_COLS,
                        borderBottom: "1px solid #f1f5f9",
                        borderLeft: `3px solid ${isSelected ? layerInfo.color : "transparent"}`,
                        cursor: "pointer",
                        background: isSelected ? `${layerInfo.color}0d` : "transparent",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#f8fafc"; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                    >
                      {/* Dataset */}
                      <div style={{ padding: "11px 16px", display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <div style={{ width: 28, height: 28, borderRadius: 7, background: `${layerInfo.color}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <i className={`fas ${layerInfo.icon}`} style={{ color: layerInfo.color, fontSize: 11 }} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{assetName(d, pipelines)}</div>
                          <div style={{ fontSize: 10, color: "#94a3b8", fontFamily: "monospace", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{d.schema}.{d.name}</div>
                        </div>
                      </div>

                      {/* Layer */}
                      <div style={{ padding: "11px 16px", display: "flex", alignItems: "center" }}>
                        <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: `${layerInfo.color}1a`, color: layerInfo.color, textTransform: "uppercase" as const }}>{layerInfo.label}</span>
                      </div>

                      {/* Pipeline */}
                      <div style={{ padding: "11px 16px", display: "flex", alignItems: "center", minWidth: 0 }}>
                        {pipeline ? (
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: runColor, flexShrink: 0 }} />
                              <span style={{ fontSize: 11, color: "#334155", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{pipeline.dag_id}</span>
                            </div>
                            {pipeline.last_run_state && (
                              <div style={{ fontSize: 10, color: "#94a3b8", paddingLeft: 11, marginTop: 2, textTransform: "capitalize" as const }}>
                                {pipeline.last_run_state}{pipeline.last_run_at ? ` · ${timeAgo(pipeline.last_run_at)}` : ""}
                              </div>
                            )}
                          </div>
                        ) : <span style={{ fontSize: 11, color: "#cbd5e1" }}>—</span>}
                      </div>

                      {/* DQ */}
                      <div style={{ padding: "11px 16px", display: "flex", alignItems: "center" }}>
                        {dq ? (
                          <div style={{ width: "100%", minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <DQBadge status={dq.last_status} />
                              <span style={{ fontSize: 11, fontWeight: 700, color: "#334155" }}>
                                {dq.pass_rate !== null ? `${Math.round(dq.pass_rate * 100)}%` : "—"}
                              </span>
                            </div>
                            <div style={{ height: 3, borderRadius: 2, background: "#f1f5f9", overflow: "hidden" }}>
                              <div style={{ height: "100%", width: dq.pass_rate !== null ? `${Math.round(dq.pass_rate * 100)}%` : "0%", borderRadius: 2, background: dq.last_status === "PASS" ? "#22c55e" : dq.last_status === "WARN" ? "#f59e0b" : "#94a3b8" }} />
                            </div>
                          </div>
                        ) : d.has_dq ? (
                          <span style={{ fontSize: 11, color: "#94a3b8" }}>No runs yet</span>
                        ) : (
                          <span style={{ fontSize: 11, color: "#cbd5e1" }}>—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>

        {/* ── Right: Detail panel — always visible ── */}
        {(() => {
          if (!selected) {
            return (
              <div style={{ minWidth: 0, background: "#fff", border: "1px solid #e2e8f0", borderTop: `3px solid #e2e8f0`, borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", textAlign: "center", height: "100%" }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
                  <i className="fas fa-table-columns" style={{ color: "#cbd5e1", fontSize: 20 }} />
                </div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#94a3b8", marginBottom: 6 }}>No dataset selected</div>
                <div style={{ fontSize: 12, color: "#cbd5e1" }}>Click a row on the left to explore schema, stats, and pipeline info</div>
              </div>
            );
          }

          const layerInfo = LAYER_META[selected.layer] ?? LAYER_META.bronze;
          const pipeline = matchPipeline(pipelines, selected);
          const dq = dqMap[`${selected.layer}/${selected.name}`];
          const runColor = pipeline?.last_run_state ? (RUN_COLOR[pipeline.last_run_state] ?? "#94a3b8") : "#94a3b8";
          const cols = detail?.columns ?? [];
          const stats = detail?.stats;

          return (
            <div style={{ minWidth: 0, background: "#fff", border: "1px solid #e2e8f0", borderTop: `3px solid ${layerInfo.color}`, borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.07)", overflow: "hidden", display: "flex", flexDirection: "column", height: "100%" }}>

              {/* Panel header */}
              <div style={{ padding: "14px 16px 12px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{assetName(selected, pipelines)}</span>
                    <span style={{ padding: "2px 7px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: `${layerInfo.color}1a`, color: layerInfo.color, textTransform: "uppercase" as const, flexShrink: 0 }}>{layerInfo.label}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#94a3b8", fontFamily: "monospace", marginTop: 3 }}>{selected.schema}.{selected.name}</div>
                </div>
                <button onClick={() => { setSelected(null); setDetail(null); }}
                  style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 16, padding: 4, lineHeight: 1, flexShrink: 0 }}
                  title="Close">✕</button>
              </div>

              {/* Stats strip */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", borderBottom: "1px solid #f1f5f9" }}>
                {[
                  { label: "Rows",    value: formatRows(stats?.row_count   ?? selected.row_count) },
                  { label: "Updated", value: timeAgo(stats?.last_updated   ?? selected.last_updated) },
                  { label: "Size",    value: formatBytes(stats?.size_bytes ?? selected.size_bytes) },
                  { label: "Cols",    value: detailLoading ? "…" : (cols.length > 0 ? String(cols.length) : "—") },
                ].map((s, i) => (
                  <div key={s.label} style={{ padding: "10px 12px", borderRight: i < 3 ? "1px solid #f1f5f9" : "none" }}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "#94a3b8" }}>{s.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: s.value === "—" ? "#cbd5e1" : "#0f172a", marginTop: 2 }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Schema */}
              <div style={{ flex: 1, padding: "12px 16px", overflowY: "auto" }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "#64748b", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Schema</span>
                  {!detailLoading && cols.length > 0 && <span style={{ color: "#94a3b8", fontWeight: 400, textTransform: "none" as const, letterSpacing: 0 }}>{cols.length} columns</span>}
                </div>

                {detailLoading && <ForgeLoader text="Loading schema…" fullscreen={false} />}
                {!detailLoading && cols.length === 0 && (
                  <div style={{ textAlign: "center", padding: "28px 0", color: "#94a3b8", fontSize: 12 }}>
                    <i className="fas fa-circle-info" style={{ marginRight: 6 }} />Schema unavailable — run the pipeline to populate this table
                  </div>
                )}
                {!detailLoading && cols.length > 0 && (
                  <div style={{ border: "1px solid #f1f5f9", borderRadius: 8, overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", background: "#f8fafc", padding: "4px 0" }}>
                      <div style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const }}>Column</div>
                      <div style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const }}>Type</div>
                    </div>
                    {cols.map((col, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", borderTop: "1px solid #f8fafc", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                        <div style={{ padding: "5px 12px", fontSize: 12, color: "#0f172a", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 4 }}>
                          {col.name.startsWith("__") && <span style={{ color: "#94a3b8", fontSize: 9 }}>⚙</span>}
                          <span style={{ fontWeight: col.name.startsWith("__") ? 500 : 400 }}>{col.name}</span>
                        </div>
                        <div style={{ padding: "5px 12px", fontSize: 11, color: typeColor(col.type), fontFamily: "monospace", whiteSpace: "nowrap" as const }}>{col.type}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pipeline action */}
              {pipeline && (
                <div style={{ padding: "10px 16px", borderTop: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: runColor, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{pipeline.dag_id}</span>
                    {pipeline.last_run_state && (
                      <span style={{ fontSize: 10, color: "#94a3b8", flexShrink: 0, textTransform: "capitalize" as const }}>{pipeline.last_run_state}{pipeline.last_run_at ? ` · ${timeAgo(pipeline.last_run_at)}` : ""}</span>
                    )}
                  </div>
                  <a href={`/pipelines?dag=${pipeline.dag_id}`}
                    onClick={e => e.stopPropagation()}
                    style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${layerInfo.color}`, background: `${layerInfo.color}12`, color: layerInfo.color, fontSize: 11, fontWeight: 700, textDecoration: "none", display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                    <i className="fas fa-arrow-right" style={{ fontSize: 9 }} /> Open Pipeline
                  </a>
                </div>
              )}

              {/* DQ summary */}
              {dq && (
                <div style={{ padding: "10px 16px", borderTop: "1px solid #f1f5f9" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <DQBadge status={dq.last_status} />
                      <span style={{ fontSize: 11, color: "#64748b" }}>{dq.total_runs} run{dq.total_runs !== 1 ? "s" : ""}</span>
                      {dq.warnings > 0 && <span style={{ fontSize: 10, color: "#a16207" }}>{dq.warnings}W</span>}
                      {dq.critical_failures > 0 && <span style={{ fontSize: 10, color: "#dc2626" }}>{dq.critical_failures}C</span>}
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>
                      {dq.pass_rate !== null ? `${Math.round(dq.pass_rate * 100)}%` : "—"}
                    </span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: "#f1f5f9", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: dq.pass_rate !== null ? `${Math.round(dq.pass_rate * 100)}%` : "0%", borderRadius: 2, background: dq.last_status === "PASS" ? "#22c55e" : dq.last_status === "WARN" ? "#f59e0b" : "#94a3b8" }} />
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
      </div>
    </PageLayout>
  );
}
