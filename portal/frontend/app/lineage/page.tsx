"use client";

import { useState, useCallback } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";

const ACCENT = "#7c3aed";

interface SearchResult {
  id: string;
  name: string;
  type: string;
  qualified_name: string;
  description: string;
}

interface LineageNode {
  guid: string;
  name: string;
  type: string;
  qualified_name: string;
}

interface LineageData {
  entity: {
    name: string;
    type: string;
    qualified_name: string;
  } | null;
  upstream: LineageNode[];
  downstream: LineageNode[];
}

function NodeCard({ node, direction }: { node: LineageNode; direction: "upstream" | "downstream" }) {
  const isUp = direction === "upstream";
  const color = isUp ? "#3b82f6" : "#8b5cf6";
  return (
    <div style={{
      background: "#fff", border: "1px solid #e2e8f0",
      borderLeft: `3px solid ${color}`, borderRadius: 10,
      padding: "12px 16px", marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <i className={`fas ${isUp ? "fa-arrow-up" : "fa-arrow-down"}`} style={{ color, fontSize: 11 }} />
        <span style={{ fontWeight: 600, color: "#0f172a", fontSize: 14 }}>{node.name}</span>
        <span style={{
          marginLeft: "auto", padding: "1px 7px", borderRadius: 6,
          fontSize: 10, fontWeight: 600, background: `${color}15`, color,
        }}>
          {node.type || "Dataset"}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace", wordBreak: "break-all" }}>
        {node.qualified_name || node.guid}
      </div>
    </div>
  );
}

export default function LineagePage() {
  const { getToken } = useAuth();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

  const [selectedEntity, setSelectedEntity] = useState<SearchResult | null>(null);
  const [lineageData, setLineageData] = useState<LineageData | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageError, setLineageError] = useState<string | null>(null);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSearchResults(null);
    setSelectedEntity(null);
    setLineageData(null);
    try {
      const results = await apiFetch<SearchResult[]>(
        `/api/lineage/search?q=${encodeURIComponent(query.trim())}`,
        getToken
      );
      setSearchResults(results);
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, [query, getToken]);

  const handleSelect = useCallback(async (entity: SearchResult) => {
    setSelectedEntity(entity);
    setLineageLoading(true);
    setLineageError(null);
    setLineageData(null);
    try {
      const data = await apiFetch<LineageData>(
        `/api/lineage/${encodeURIComponent(entity.qualified_name || entity.id)}`,
        getToken
      );
      setLineageData(data);
    } catch (e: unknown) {
      setLineageError(e instanceof Error ? e.message : "Failed to load lineage");
    } finally {
      setLineageLoading(false);
    }
  }, [getToken]);

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
              <i className="fas fa-share-nodes" style={{ color: "#fff", fontSize: 18 }} />
            </div>
            <h1 style={{ fontSize: "clamp(1.6rem,3.5vw,2.2rem)", fontWeight: 800, color: "#fff", margin: 0, letterSpacing: "-0.02em" }}>
              Lineage Explorer
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.7)", margin: 0, fontSize: 15 }}>
            Trace upstream and downstream dependencies from Microsoft Purview
          </p>

          {/* Search bar */}
          <div style={{ display: "flex", gap: 8, marginTop: 24, maxWidth: 560 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <i className="fas fa-magnifying-glass" style={{
                position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
                color: "rgba(255,255,255,0.5)", fontSize: 14,
              }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSearch()}
                placeholder="Search for a dataset…"
                style={{
                  width: "100%", padding: "12px 14px 12px 42px",
                  borderRadius: 10, border: "1px solid rgba(255,255,255,0.25)",
                  background: "rgba(255,255,255,0.12)", color: "#fff",
                  fontSize: 14, outline: "none", boxSizing: "border-box",
                }}
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={searching || !query.trim()}
              style={{
                padding: "12px 20px", borderRadius: 10, border: "none",
                background: searching ? "rgba(255,255,255,0.2)" : "#fff",
                color: searching ? "rgba(255,255,255,0.6)" : ACCENT,
                fontSize: 14, fontWeight: 700, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8,
                whiteSpace: "nowrap",
              }}
            >
              <i className={`fas ${searching ? "fa-spinner fa-spin" : "fa-search"}`} style={{ fontSize: 12 }} />
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 1.5rem 60px" }}>
        {searchError && (
          <div style={{
            background: "#fff", border: "1px solid #fca5a5", borderTop: "3px solid #ef4444",
            borderRadius: 12, padding: "16px 20px", color: "#dc2626", marginBottom: 20,
          }}>
            <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
            {searchError}
          </div>
        )}

        {/* Search results */}
        {searchResults !== null && !selectedEntity && (
          <div style={{ marginBottom: 28 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, letterSpacing: "0.09em",
              textTransform: "uppercase", color: "#94a3b8", marginBottom: 12,
            }}>
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
            </div>
            {searchResults.length === 0 && (
              <div style={{ color: "#64748b", fontSize: 14, padding: "20px 0" }}>
                No datasets found matching your query.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {searchResults.map(r => (
                <div
                  key={r.id}
                  onClick={() => handleSelect(r)}
                  style={{
                    background: "#fff", border: "1px solid #e2e8f0",
                    borderTop: `3px solid ${ACCENT}`, borderRadius: 10,
                    padding: "14px 18px", cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                    transition: "box-shadow 0.15s",
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.1)"}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 8,
                      background: `${ACCENT}15`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <i className="fas fa-table" style={{ color: ACCENT, fontSize: 13 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: "#0f172a", fontSize: 14 }}>{r.name}</div>
                      {r.description && (
                        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{r.description}</div>
                      )}
                      <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace", marginTop: 2, wordBreak: "break-all" }}>
                        {r.qualified_name}
                      </div>
                    </div>
                    <span style={{
                      padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                      background: `${ACCENT}15`, color: ACCENT,
                    }}>
                      {r.type || "DataSet"}
                    </span>
                    <i className="fas fa-arrow-right" style={{ color: "#cbd5e1", fontSize: 12 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lineage view */}
        {selectedEntity && (
          <div>
            <button
              onClick={() => { setSelectedEntity(null); setLineageData(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 12px", borderRadius: 8, border: "1px solid #e2e8f0",
                background: "#fff", color: "#64748b", fontSize: 13, cursor: "pointer",
                marginBottom: 20,
              }}
            >
              <i className="fas fa-arrow-left" style={{ fontSize: 11 }} />
              Back to results
            </button>

            {/* Selected entity header */}
            <div style={{
              background: "#fff", border: "1px solid #e2e8f0",
              borderTop: `3px solid ${ACCENT}`, borderRadius: 12,
              padding: "20px 24px", marginBottom: 28,
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: `${ACCENT}15`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <i className="fas fa-table" style={{ color: ACCENT, fontSize: 16 }} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a" }}>{selectedEntity.name}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace", marginTop: 2 }}>
                    {selectedEntity.qualified_name}
                  </div>
                </div>
                <span style={{
                  marginLeft: "auto", padding: "3px 10px", borderRadius: 8,
                  fontSize: 12, fontWeight: 600, background: `${ACCENT}15`, color: ACCENT,
                }}>
                  {selectedEntity.type || "DataSet"}
                </span>
              </div>
            </div>

            {lineageLoading && (
              <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>
                <i className="fas fa-spinner fa-spin" style={{ fontSize: 24, marginBottom: 10, display: "block" }} />
                Loading lineage from Purview…
              </div>
            )}

            {lineageError && (
              <div style={{
                background: "#fff", border: "1px solid #fca5a5", borderTop: "3px solid #ef4444",
                borderRadius: 12, padding: "16px 20px", color: "#dc2626",
              }}>
                <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
                {lineageError}
              </div>
            )}

            {lineageData && !lineageLoading && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                {/* Upstream */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 7, background: "#eff6ff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <i className="fas fa-arrow-up" style={{ color: "#3b82f6", fontSize: 11 }} />
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Upstream</span>
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>({lineageData.upstream.length})</span>
                  </div>
                  {lineageData.upstream.length === 0 ? (
                    <div style={{ color: "#94a3b8", fontSize: 13, padding: "12px 0" }}>
                      No upstream sources found
                    </div>
                  ) : (
                    lineageData.upstream.map(n => (
                      <NodeCard key={n.guid} node={n} direction="upstream" />
                    ))
                  )}
                </div>

                {/* Downstream */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 7, background: "#f5f3ff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <i className="fas fa-arrow-down" style={{ color: "#8b5cf6", fontSize: 11 }} />
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Downstream</span>
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>({lineageData.downstream.length})</span>
                  </div>
                  {lineageData.downstream.length === 0 ? (
                    <div style={{ color: "#94a3b8", fontSize: 13, padding: "12px 0" }}>
                      No downstream consumers found
                    </div>
                  ) : (
                    lineageData.downstream.map(n => (
                      <NodeCard key={n.guid} node={n} direction="downstream" />
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!searching && searchResults === null && !selectedEntity && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
            <div style={{ fontSize: 56, opacity: 0.15, marginBottom: 16 }}>
              <i className="fas fa-share-nodes" />
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#334155", marginBottom: 8 }}>
              Search for a dataset to view its lineage
            </div>
            <div style={{ fontSize: 13, color: "#94a3b8", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
              Enter a dataset name above to see its upstream sources and downstream consumers from Microsoft Purview.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
