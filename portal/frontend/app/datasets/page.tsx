"use client";

import { useEffect, useState, useMemo } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";

const ACCENT = "var(--forge-primary)";

const LAYER_META: Record<string, { color: string; icon: string; label: string }> = {
  bronze: { color: "#cd7f32", icon: "fa-layer-group", label: "Bronze" },
  silver: { color: "#94a3b8", icon: "fa-database", label: "Silver" },
  gold: { color: "#d4af37", icon: "fa-star", label: "Gold" },
};

interface Dataset {
  name: string;
  layer: "bronze" | "silver" | "gold";
  schema: string;
  row_count: number | null;
  last_updated: string | null;
  size_bytes: number | null;
  has_dq: boolean;
}

function formatRows(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatBytes(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${(n / 1_024).toFixed(1)} KB`;
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

export default function DatasetsPage() {
  const { getToken } = useAuth();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState<"all" | "bronze" | "silver" | "gold">("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    apiFetch<Dataset[]>("/api/datasets", getToken)
      .then(setDatasets)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [getToken]);

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
    all: datasets.length,
    bronze: datasets.filter(d => d.layer === "bronze").length,
    silver: datasets.filter(d => d.layer === "silver").length,
    gold: datasets.filter(d => d.layer === "gold").length,
  }), [datasets]);

  const heroContent = !loading && !error ? (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      {(["bronze", "silver", "gold"] as const).map(layer => (
        <div key={layer} style={{
          background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 10, padding: "8px 18px", display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{
            width: 10, height: 10, borderRadius: "50%",
            background: LAYER_META[layer].color, flexShrink: 0,
          }} />
          <span style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{counts[layer]}</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600, textTransform: "capitalize" }}>{layer}</span>
        </div>
      ))}
    </div>
  ) : undefined;

  return (
    <PageLayout
      icon="fa-database"
      title="Dataset Catalog"
      subtitle="Explore datasets across Bronze, Silver, and Gold layers"
      heroContent={heroContent}
    >
      {/* Tabs + Search */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 4 }}>
          {(["all", "bronze", "silver", "gold"] as const).map(layer => (
            <button
              key={layer}
              onClick={() => setActiveLayer(layer)}
              style={{
                padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 600,
                background: activeLayer === layer ? (layer === "all" ? ACCENT : LAYER_META[layer].color) : "transparent",
                color: activeLayer === layer ? "#fff" : "#64748b",
                transition: "all 0.15s",
              }}
            >
              {layer === "all" ? "All" : LAYER_META[layer].label}
              <span style={{
                marginLeft: 6, fontSize: 11,
                opacity: 0.8,
              }}>({counts[layer]})</span>
            </button>
          ))}
        </div>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <i className="fas fa-magnifying-glass" style={{
            position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
            color: "#94a3b8", fontSize: 13,
          }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search datasets…"
            style={{
              width: "100%", padding: "9px 12px 9px 36px", borderRadius: 10,
              border: "1px solid #e2e8f0", fontSize: 14, background: "#fff",
              outline: "none", boxSizing: "border-box",
            }}
          />
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
          <i className="fas fa-spinner fa-spin" style={{ fontSize: 28, marginBottom: 12, display: "block" }} />
          Loading datasets…
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

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
          <i className="fas fa-inbox" style={{ fontSize: 32, marginBottom: 12, display: "block" }} />
          No datasets found
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}>
          {filtered.map(d => {
            const layerInfo = LAYER_META[d.layer] ?? LAYER_META.bronze;
            return (
              <div
                key={`${d.layer}/${d.name}`}
                style={{
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  borderTop: `3px solid ${layerInfo.color}`,
                  borderRadius: 12,
                  padding: "18px 20px",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{
                      width: 34, height: 34, borderRadius: 8,
                      background: `${layerInfo.color}18`,
                      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                    }}>
                      <i className={`fas ${layerInfo.icon}`} style={{ color: layerInfo.color, fontSize: 14 }} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", wordBreak: "break-word" }}>{d.name}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1, fontFamily: "monospace" }}>{d.schema}</div>
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  <span style={{
                    padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    background: `${layerInfo.color}18`, color: layerInfo.color,
                    textTransform: "uppercase",
                  }}>
                    {layerInfo.label}
                  </span>
                  {d.has_dq && (
                    <span style={{
                      padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                      background: "#dcfce7", color: "#16a34a",
                      display: "flex", alignItems: "center", gap: 4,
                    }}>
                      <i className="fas fa-shield-check" style={{ fontSize: 9 }} />
                      DQ
                    </span>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div style={{ background: "#f8fafc", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", marginBottom: 3 }}>Rows</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{formatRows(d.row_count)}</div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", marginBottom: 3 }}>Size</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{formatBytes(d.size_bytes)}</div>
                  </div>
                  <div style={{ background: "#f8fafc", borderRadius: 8, padding: "8px 10px", gridColumn: "1 / -1" }}>
                    <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", marginBottom: 3 }}>Last Updated</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>{timeAgo(d.last_updated)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageLayout>
  );
}
