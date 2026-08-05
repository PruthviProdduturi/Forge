"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";
import { ForgeLoader } from "../../components/ForgeLoader";
import { BackendStatus } from "../../components/BackendStatus";

const ACCENT = "var(--forge-primary)";
const DOWN_COLOR = "#6366f1";

const LAYER_META: Record<string, { color: string; icon: string; label: string }> = {
  bronze: { color: "#cd7f32", icon: "fa-layer-group", label: "Bronze" },
  silver: { color: "#94a3b8", icon: "fa-database",    label: "Silver" },
  gold:   { color: "#d4af37", icon: "fa-star",        label: "Gold"   },
};

interface Dataset {
  name: string;
  layer: "bronze" | "silver" | "gold";
  schema: string;
}

interface LineageNode {
  guid: string;
  name: string;
  type: string;
  qualified_name: string;
  depth?: number;
  layer?: string;
}

interface LineageData {
  entity: { name: string; type: string; qualified_name: string } | null;
  upstream: LineageNode[];
  downstream: LineageNode[];
}

interface SVGLine {
  x1: number; y1: number;
  x2: number; y2: number;
  direction: "upstream" | "downstream";
}

function cleanType(t: string): string {
  return (t || "").replace(/spark_|openlineage_|delta_/gi, "").replace(/_/g, " ").trim() || "Dataset";
}

// ── Graph node card ────────────────────────────────────────────────────────────
function GraphNode({
  node, direction, onClick, nodeRef,
}: {
  node: LineageNode;
  direction: "upstream" | "downstream";
  onClick?: () => void;
  nodeRef?: (el: HTMLDivElement | null) => void;
}) {
  const isUp = direction === "upstream";
  const color = isUp ? ACCENT : DOWN_COLOR;
  return (
    <div
      ref={nodeRef}
      onClick={onClick}
      style={{
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderLeft: `3px solid ${color}`,
        borderRadius: 9,
        padding: "10px 14px",
        cursor: onClick ? "pointer" : "default",
        position: "relative",
        zIndex: 1,
        transition: "box-shadow 0.15s, background 0.1s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
      onMouseEnter={e => {
        if (onClick) {
          e.currentTarget.style.background = "#f8fafc";
          e.currentTarget.style.boxShadow = "0 3px 10px rgba(0,0,0,0.1)";
        }
      }}
      onMouseLeave={e => {
        if (onClick) {
          e.currentTarget.style.background = "#fff";
          e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
        }
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
        <i
          className={`fas ${isUp ? "fa-arrow-up-to-line" : "fa-arrow-down-to-line"}`}
          style={{ color, fontSize: 10, flexShrink: 0 }}
        />
        <span style={{
          fontWeight: 600, color: "#0f172a", fontSize: 13,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
        }}>
          {node.name}
        </span>
        <span style={{
          marginLeft: "auto", padding: "1px 6px", borderRadius: 4, flexShrink: 0,
          fontSize: 9, fontWeight: 700, background: `${color}18`, color,
          textTransform: "uppercase" as const,
        }}>
          {cleanType(node.type)}
        </span>
      </div>
      <div style={{
        fontSize: 10, color: "#94a3b8", fontFamily: "monospace",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
      }}>
        {node.qualified_name || node.guid}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function LineagePage() {
  const { getToken } = useAuth();

  // Catalog state
  const [datasets, setDatasets]         = useState<Dataset[]>([]);
  const [datasetsLoading, setDsLoading] = useState(true);
  const [search, setSearch]             = useState("");
  const [activeLayer, setActiveLayer]   = useState<"all" | "bronze" | "silver" | "gold">("all");

  // Lineage state
  const [selected, setSelected]         = useState<Dataset | null>(null);
  const [lineageData, setLineageData]   = useState<LineageData | null>(null);
  const [lineageLoading, setLLoading]   = useState(false);
  const [lineageError, setLError]       = useState<string | null>(null);

  // SVG graph
  const containerRef                    = useRef<HTMLDivElement>(null);
  const centerRef                       = useRef<HTMLDivElement>(null);
  const nodeRefs                        = useRef<Map<string, HTMLDivElement>>(new Map());
  const colRefs                         = useRef<Map<string, HTMLDivElement>>(new Map());
  const [svgLines, setSvgLines]         = useState<SVGLine[]>([]);
  const [svgSize, setSvgSize]           = useState({ w: 0, h: 0 });

  // Group nodes by depth for multi-hop columns
  const upstreamByDepth = useMemo(() => {
    const map = new Map<number, LineageNode[]>();
    lineageData?.upstream.forEach(n => {
      const d = n.depth ?? 1;
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(n);
    });
    return map;
  }, [lineageData]);

  const downstreamByDepth = useMemo(() => {
    const map = new Map<number, LineageNode[]>();
    lineageData?.downstream.forEach(n => {
      const d = n.depth ?? 1;
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(n);
    });
    return map;
  }, [lineageData]);

  const maxUpDepth   = useMemo(() => upstreamByDepth.size   > 0 ? Math.max(...upstreamByDepth.keys())   : 0, [upstreamByDepth]);
  const maxDownDepth = useMemo(() => downstreamByDepth.size > 0 ? Math.max(...downstreamByDepth.keys()) : 0, [downstreamByDepth]);

  // Column depth arrays: upstream rendered deepest-first (left), downstream shallowest-first (left)
  const upDepths   = useMemo(() => maxUpDepth   > 0 ? Array.from({ length: maxUpDepth   }, (_, i) => maxUpDepth   - i) : [], [maxUpDepth]);
  const downDepths = useMemo(() => maxDownDepth > 0 ? Array.from({ length: maxDownDepth }, (_, i) => i + 1)            : [], [maxDownDepth]);

  // Load datasets on mount
  useEffect(() => {
    apiFetch<Dataset[]>("/api/datasets", getToken)
      .then(setDatasets)
      .catch(() => {})
      .finally(() => setDsLoading(false));
  }, [getToken]);

  const filtered = useMemo(() => {
    let list = datasets;
    if (activeLayer !== "all") list = list.filter(d => d.layer === activeLayer);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(q));
    }
    return list;
  }, [datasets, activeLayer, search]);

  // Measure node positions and draw SVG lines (depth-aware)
  const measureAndDraw = useCallback(() => {
    const container = containerRef.current;
    const center    = centerRef.current;
    if (!container || !center || !lineageData) return;

    const cRect    = container.getBoundingClientRect();
    const centRect = center.getBoundingClientRect();
    const lines: SVGLine[] = [];

    lineageData.upstream.forEach(n => {
      const el = nodeRefs.current.get(`up-${n.guid}`);
      if (!el) return;
      const r     = el.getBoundingClientRect();
      const depth = n.depth ?? 1;

      if (depth === 1) {
        // Direct source → center
        lines.push({
          x1: r.right - cRect.left,
          y1: r.top + r.height / 2 - cRect.top,
          x2: centRect.left - cRect.left,
          y2: centRect.top  + centRect.height / 2 - cRect.top,
          direction: "upstream",
        });
      } else {
        // Deeper node → adjacent closer column
        const colEl = colRefs.current.get(`up-col-${depth - 1}`);
        if (colEl) {
          const colR = colEl.getBoundingClientRect();
          lines.push({
            x1: r.right - cRect.left,
            y1: r.top + r.height / 2 - cRect.top,
            x2: colR.left - cRect.left,
            y2: colR.top  + colR.height / 2 - cRect.top,
            direction: "upstream",
          });
        }
      }
    });

    lineageData.downstream.forEach(n => {
      const el = nodeRefs.current.get(`dn-${n.guid}`);
      if (!el) return;
      const r     = el.getBoundingClientRect();
      const depth = n.depth ?? 1;

      if (depth === 1) {
        // Center → direct consumer
        lines.push({
          x1: centRect.right - cRect.left,
          y1: centRect.top   + centRect.height / 2 - cRect.top,
          x2: r.left - cRect.left,
          y2: r.top  + r.height / 2 - cRect.top,
          direction: "downstream",
        });
      } else {
        // Deeper node ← adjacent closer column
        const colEl = colRefs.current.get(`dn-col-${depth - 1}`);
        if (colEl) {
          const colR = colEl.getBoundingClientRect();
          lines.push({
            x1: colR.right - cRect.left,
            y1: colR.top   + colR.height / 2 - cRect.top,
            x2: r.left - cRect.left,
            y2: r.top  + r.height / 2 - cRect.top,
            direction: "downstream",
          });
        }
      }
    });

    setSvgLines(lines);
    setSvgSize({ w: cRect.width, h: cRect.height });
  }, [lineageData]);

  // Re-measure when data loads or on resize
  useEffect(() => {
    if (!lineageData) { setSvgLines([]); colRefs.current.clear(); return; }
    const id = requestAnimationFrame(() => measureAndDraw());
    return () => cancelAnimationFrame(id);
  }, [lineageData, measureAndDraw]);

  useEffect(() => {
    window.addEventListener("resize", measureAndDraw);
    return () => window.removeEventListener("resize", measureAndDraw);
  }, [measureAndDraw]);

  // Lineage loading helpers
  const loadLineage = useCallback(async (dataset: Dataset) => {
    setSelected(dataset);
    setLLoading(true);
    setLError(null);
    setLineageData(null);
    nodeRefs.current.clear();
    colRefs.current.clear();
    try {
      const data = await apiFetch<LineageData>(
        `/api/lineage/graph/${encodeURIComponent(dataset.schema || dataset.layer)}/${encodeURIComponent(dataset.name)}`,
        getToken,
      );
      setLineageData(data);
    } catch (e: unknown) {
      setLError(e instanceof Error ? e.message : "Failed to load lineage");
    } finally {
      setLLoading(false);
    }
  }, [getToken]);

  const handleNodeClick = useCallback((node: LineageNode) => {
    const norm = node.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit  = datasets.find(d => d.name.toLowerCase().replace(/[^a-z0-9]/g, "") === norm);
    if (hit) {
      loadLineage(hit);
    } else if (node.qualified_name && !node.qualified_name.startsWith("external:")) {
      // Derive schema/table from qualified_name: lakehouse.{schema}.{table}
      const parts = node.qualified_name.split(".");
      if (parts.length >= 3) {
        loadLineage({ name: parts[parts.length - 1], layer: parts[parts.length - 2] as "bronze" | "silver" | "gold", schema: parts[parts.length - 2] });
      }
    }
  }, [datasets, loadLineage]);

  const meta = selected ? (LAYER_META[selected.layer] ?? LAYER_META.bronze) : null;

  const heroContent = (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 14px", borderRadius: 20,
        background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
        fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.9)",
      }}>
        <i className="fas fa-circle" style={{ fontSize: 7, color: "#4ade80" }} />
        Airflow Lineage
      </div>
      {selected && (
        <>
          <i className="fas fa-chevron-right" style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }} />
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 14px", borderRadius: 20,
            background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.3)",
            fontSize: 12, fontWeight: 600, color: "#fff",
          }}>
            <i className="fas fa-table" style={{ fontSize: 10 }} />
            {selected.name}
          </div>
          {lineageData && [
            { icon: "fa-arrow-up",   txt: `${lineageData.upstream.length} upstream` },
            { icon: "fa-arrow-down", txt: `${lineageData.downstream.length} downstream` },
          ].map(b => (
            <div key={b.txt} style={{
              display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 20,
              background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
              fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)",
            }}>
              <i className={`fas ${b.icon}`} style={{ fontSize: 9 }} /> {b.txt}
            </div>
          ))}
        </>
      )}
      {!selected && !datasetsLoading && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 20,
          background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
          fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)",
        }}>
          {datasets.length} datasets
        </div>
      )}
    </div>
  );

  return (
    <PageLayout
      icon="fa-share-nodes"
      title="Lineage Explorer"
      subtitle="Trace upstream sources and downstream consumers across the medallion layers"
      heroContent={heroContent}
      fullHeight
    >
      <div style={{ display: "grid", gridTemplateColumns: "290px 1fr", gap: 16, height: "100%", minHeight: 0 }}>

        {/* ── Left: Dataset catalog ─────────────────────────────────────────── */}
        <div style={{
          background: "#fff", border: "1px solid #e2e8f0", borderTop: `3px solid ${ACCENT}`,
          borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <div style={{ padding: "10px 10px 0", borderBottom: "1px solid #f1f5f9", flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 3, background: "#f8fafc", borderRadius: 7, padding: 3, marginBottom: 8 }}>
              {(["all", "bronze", "silver", "gold"] as const).map(layer => (
                <button key={layer} onClick={() => setActiveLayer(layer)} style={{
                  flex: 1, padding: "5px 0", borderRadius: 5, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 600,
                  background: activeLayer === layer
                    ? layer === "all" ? ACCENT : LAYER_META[layer].color
                    : "transparent",
                  color: activeLayer === layer ? "#fff" : "#64748b",
                  transition: "all 0.12s",
                }}>
                  {layer === "all" ? "All" : LAYER_META[layer].label}
                </button>
              ))}
            </div>
            <div style={{ position: "relative", marginBottom: 8 }}>
              <i className="fas fa-magnifying-glass" style={{
                position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)",
                color: "#94a3b8", fontSize: 11,
              }} />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Filter datasets…"
                style={{
                  width: "100%", padding: "7px 9px 7px 28px", borderRadius: 7,
                  border: "1px solid #e2e8f0", fontSize: 12, outline: "none",
                  boxSizing: "border-box" as const, background: "#f8fafc",
                }}
              />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {datasetsLoading && <ForgeLoader text="Loading…" fullscreen={false} />}
            {!datasetsLoading && filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: "40px 16px", color: "#94a3b8", fontSize: 12 }}>
                No datasets found
              </div>
            )}
            {!datasetsLoading && filtered.map(d => {
              const m = LAYER_META[d.layer];
              const isSel = selected?.name === d.name && selected?.layer === d.layer;
              return (
                <div
                  key={`${d.layer}/${d.name}`}
                  onClick={() => loadLineage(d)}
                  style={{
                    padding: "9px 12px", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 9,
                    borderBottom: "1px solid #f8fafc",
                    borderLeft: `3px solid ${isSel ? m.color : "transparent"}`,
                    background: isSel ? `${m.color}0d` : "transparent",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = "#f8fafc"; }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{
                    width: 26, height: 26, borderRadius: 6, flexShrink: 0,
                    background: `${m.color}18`, display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <i className={`fas ${m.icon}`} style={{ color: m.color, fontSize: 10 }} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                      {d.name}
                    </div>
                    <div style={{ fontSize: 10, color: "#94a3b8" }}>{d.layer}</div>
                  </div>
                  <span style={{
                    padding: "1px 6px", borderRadius: 4, flexShrink: 0,
                    fontSize: 9, fontWeight: 700, background: `${m.color}1a`, color: m.color,
                    textTransform: "uppercase" as const,
                  }}>{m.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: Lineage graph ──────────────────────────────────────────── */}
        <div style={{ minWidth: 0, overflow: "auto" }}>

          {/* Empty state */}
          {!selected && (
            <div style={{
              background: "#fff", border: "1px solid #e2e8f0", borderTop: "3px solid #e2e8f0",
              borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", padding: "80px 24px", textAlign: "center", height: "100%",
              boxSizing: "border-box" as const,
            }}>
              <div style={{
                width: 60, height: 60, borderRadius: 15, background: "#f8fafc",
                border: "1px solid #e2e8f0", display: "flex", alignItems: "center",
                justifyContent: "center", marginBottom: 18,
              }}>
                <i className="fas fa-share-nodes" style={{ fontSize: 24, color: "#cbd5e1" }} />
              </div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "#64748b", marginBottom: 6 }}>
                Select a dataset
              </div>
              <div style={{ fontSize: 13, color: "#94a3b8", maxWidth: 300, lineHeight: 1.6 }}>
                Click any dataset on the left to explore its complete upstream and downstream lineage.
              </div>
            </div>
          )}

          {/* Graph panel */}
          {selected && meta && (
            <div style={{
              background: "#fff",
              border: `1px solid ${lineageError ? "#fca5a5" : "#e2e8f0"}`,
              borderTop: `3px solid ${lineageError ? "#ef4444" : meta.color}`,
              borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}>

              {/* Header */}
              <div style={{
                padding: "14px 20px", borderBottom: "1px solid #f1f5f9",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                  background: `${meta.color}18`, display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <i className={`fas ${meta.icon}`} style={{ color: meta.color, fontSize: 14 }} />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{selected.name}</div>
                  {lineageData?.entity?.qualified_name && (
                    <div style={{ fontSize: 10, color: "#94a3b8", fontFamily: "monospace", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                      {lineageData.entity.qualified_name}
                    </div>
                  )}
                </div>
                <span style={{
                  padding: "3px 10px", borderRadius: 7, flexShrink: 0,
                  fontSize: 11, fontWeight: 700, background: `${meta.color}18`,
                  color: meta.color, textTransform: "uppercase" as const,
                }}>{meta.label}</span>
              </div>

              {lineageLoading && <ForgeLoader text="Loading lineage…" fullscreen={false} />}

              {lineageError && <BackendStatus error={lineageError} feature="Lineage" />}

              {/* ── Graph canvas ── */}
              {lineageData && !lineageLoading && (
                <div
                  ref={containerRef}
                  style={{ padding: "24px 20px", position: "relative" }}
                >
                  {/* SVG overlay for bezier curves */}
                  {svgLines.length > 0 && (
                    <svg
                      style={{
                        position: "absolute", top: 0, left: 0,
                        width: svgSize.w, height: svgSize.h,
                        pointerEvents: "none", overflow: "visible",
                      }}
                    >
                      <defs>
                        <marker id="arr-up" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
                          <polygon points="0 0,7 3.5,0 7" fill="var(--forge-primary)" fillOpacity="0.45" />
                        </marker>
                        <marker id="arr-dn" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
                          <polygon points="0 0,7 3.5,0 7" fill={DOWN_COLOR} fillOpacity="0.45" />
                        </marker>
                      </defs>
                      {svgLines.map((l, i) => {
                        const isUp  = l.direction === "upstream";
                        const color = isUp ? "var(--forge-primary)" : DOWN_COLOR;
                        const cx    = (l.x1 + l.x2) / 2;
                        return (
                          <path
                            key={i}
                            d={`M ${l.x1} ${l.y1} C ${cx} ${l.y1} ${cx} ${l.y2} ${l.x2} ${l.y2}`}
                            stroke={color}
                            strokeWidth={1.5}
                            strokeOpacity={0.35}
                            fill="none"
                            markerEnd={isUp ? "url(#arr-up)" : "url(#arr-dn)"}
                          />
                        );
                      })}
                    </svg>
                  )}

                  {/* Dynamic multi-depth pipeline layout */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: [
                      ...upDepths.map(() => "minmax(140px, 1fr)"),
                      upDepths.length === 0 ? "minmax(140px, 1fr)" : null,
                      "200px",
                      ...downDepths.map(() => "minmax(140px, 1fr)"),
                      downDepths.length === 0 ? "minmax(140px, 1fr)" : null,
                    ].filter(Boolean).join(" "),
                    gap: 20,
                    alignItems: "start",
                    position: "relative",
                    zIndex: 1,
                  }}>

                    {/* ── Upstream columns (deepest → closest) ── */}
                    {upDepths.length === 0 ? (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
                          <div style={{
                            width: 22, height: 22, borderRadius: 6,
                            background: "rgba(var(--forge-primary-rgb),0.1)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}>
                            <i className="fas fa-arrow-up" style={{ color: ACCENT, fontSize: 9 }} />
                          </div>
                          <span style={{ fontWeight: 700, fontSize: 12, color: "#334155" }}>Upstream</span>
                        </div>
                        <div style={{ border: "1px dashed #e2e8f0", borderRadius: 9, padding: "22px 14px", textAlign: "center", color: "#94a3b8", fontSize: 12 }}>
                          No upstream sources
                        </div>
                      </div>
                    ) : upDepths.map(depth => {
                      const nodes = upstreamByDepth.get(depth) || [];
                      const label = depth === 1 ? "Sources" : depth === maxUpDepth ? `Upstream ×${depth}` : `Upstream ×${depth}`;
                      return (
                        <div
                          key={`up-${depth}`}
                          ref={el => { if (el) colRefs.current.set(`up-col-${depth}`, el); }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
                            <div style={{
                              width: 22, height: 22, borderRadius: 6,
                              background: "rgba(var(--forge-primary-rgb),0.1)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>
                              <i className="fas fa-arrow-up" style={{ color: ACCENT, fontSize: 9 }} />
                            </div>
                            <span style={{ fontWeight: 700, fontSize: 12, color: "#334155" }}>{label}</span>
                            <span style={{ fontSize: 11, color: "#94a3b8" }}>({nodes.length})</span>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {nodes.map(n => (
                              <GraphNode
                                key={n.guid}
                                node={n}
                                direction="upstream"
                                onClick={() => handleNodeClick(n)}
                                nodeRef={el => { if (el) nodeRefs.current.set(`up-${n.guid}`, el); }}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {/* ── Center: selected entity ── */}
                    <div
                      ref={centerRef}
                      style={{
                        background: `linear-gradient(135deg, ${meta.color}10 0%, ${meta.color}06 100%)`,
                        border: `2px solid ${meta.color}`,
                        borderRadius: 14, padding: "22px 20px",
                        boxShadow: `0 4px 20px ${meta.color}20`,
                        textAlign: "center",
                      }}
                    >
                      <div style={{
                        width: 52, height: 52, borderRadius: 13, margin: "0 auto 12px",
                        background: `${meta.color}20`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <i className={`fas ${meta.icon}`} style={{ color: meta.color, fontSize: 20 }} />
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 16, color: "#0f172a", marginBottom: 6 }}>
                        {selected.name}
                      </div>
                      <span style={{
                        padding: "3px 10px", borderRadius: 6,
                        fontSize: 11, fontWeight: 700,
                        background: `${meta.color}20`, color: meta.color,
                        textTransform: "uppercase" as const,
                      }}>
                        {meta.label}
                      </span>
                      {lineageData.entity?.type && (
                        <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 8 }}>
                          {lineageData.entity.type}
                        </div>
                      )}
                      <div style={{
                        display: "flex", justifyContent: "center", gap: 16,
                        marginTop: 14, paddingTop: 12,
                        borderTop: `1px solid ${meta.color}25`,
                      }}>
                        {[
                          { icon: "fa-arrow-up",   val: lineageData.upstream.length,   color: ACCENT },
                          { icon: "fa-arrow-down", val: lineageData.downstream.length, color: DOWN_COLOR },
                        ].map(s => (
                          <div key={s.icon} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <i className={`fas ${s.icon}`} style={{ color: s.color, fontSize: 9 }} />
                            <span style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>{s.val}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── Downstream columns (closest → deepest) ── */}
                    {downDepths.length === 0 ? (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
                          <div style={{
                            width: 22, height: 22, borderRadius: 6,
                            background: `${DOWN_COLOR}12`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}>
                            <i className="fas fa-arrow-down" style={{ color: DOWN_COLOR, fontSize: 9 }} />
                          </div>
                          <span style={{ fontWeight: 700, fontSize: 12, color: "#334155" }}>Downstream</span>
                        </div>
                        <div style={{ border: "1px dashed #e2e8f0", borderRadius: 9, padding: "22px 14px", textAlign: "center", color: "#94a3b8", fontSize: 12 }}>
                          No downstream consumers
                        </div>
                      </div>
                    ) : downDepths.map(depth => {
                      const nodes = downstreamByDepth.get(depth) || [];
                      const label = depth === 1 ? "Consumers" : `Downstream ×${depth}`;
                      return (
                        <div
                          key={`dn-${depth}`}
                          ref={el => { if (el) colRefs.current.set(`dn-col-${depth}`, el); }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
                            <div style={{
                              width: 22, height: 22, borderRadius: 6,
                              background: `${DOWN_COLOR}12`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>
                              <i className="fas fa-arrow-down" style={{ color: DOWN_COLOR, fontSize: 9 }} />
                            </div>
                            <span style={{ fontWeight: 700, fontSize: 12, color: "#334155" }}>{label}</span>
                            <span style={{ fontSize: 11, color: "#94a3b8" }}>({nodes.length})</span>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {nodes.map(n => (
                              <GraphNode
                                key={n.guid}
                                node={n}
                                direction="downstream"
                                onClick={() => handleNodeClick(n)}
                                nodeRef={el => { if (el) nodeRefs.current.set(`dn-${n.guid}`, el); }}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}

                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
