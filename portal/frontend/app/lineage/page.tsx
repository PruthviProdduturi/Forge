"use client";

import { useState, useCallback } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";
import { ForgeLoader } from "../../components/ForgeLoader";

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
  const colorVar = isUp ? "var(--forge-primary)" : "var(--forge-secondary)";
  const bgVar = isUp
    ? "rgba(var(--forge-primary-rgb), 0.08)"
    : "rgba(var(--forge-secondary-rgb), 0.08)";

  return (
    <div style={{
      background: "#fff", border: "1px solid #e2e8f0",
      borderLeft: `3px solid ${colorVar}`, borderRadius: 10,
      padding: "12px 16px", marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <i className={`fas ${isUp ? "fa-arrow-up" : "fa-arrow-down"}`} style={{ color: colorVar, fontSize: 11 }} />
        <span style={{ fontWeight: 600, color: "#0f172a", fontSize: 14 }}>{node.name}</span>
        <span style={{
          marginLeft: "auto", padding: "1px 7px", borderRadius: 6,
          fontSize: 10, fontWeight: 600, background: bgVar, color: colorVar,
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
        `/api/lineage/${entity.qualified_name || entity.id}`,
        getToken
      );
      setLineageData(data);
    } catch (e: unknown) {
      setLineageError(e instanceof Error ? e.message : "Failed to load lineage");
    } finally {
      setLineageLoading(false);
    }
  }, [getToken]);

  const heroContent = (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 14px", borderRadius: 20,
        background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
        fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.9)",
      }}>
        <i className="fas fa-circle" style={{ fontSize: 7, color: "#4ade80" }} />
        Microsoft Purview
      </div>
      {selectedEntity && (
        <>
          <i className="fas fa-chevron-right" style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }} />
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 14px", borderRadius: 20,
            background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.3)",
            fontSize: 12, fontWeight: 600, color: "#fff",
          }}>
            <i className="fas fa-table" style={{ fontSize: 10 }} />
            {selectedEntity.name}
          </div>
          {lineageData && (
            <>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 14px", borderRadius: 20,
                background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
                fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)",
              }}>
                <i className="fas fa-arrow-up" style={{ fontSize: 9 }} />
                {lineageData.upstream.length} upstream
              </div>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 14px", borderRadius: 20,
                background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
                fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)",
              }}>
                <i className="fas fa-arrow-down" style={{ fontSize: 9 }} />
                {lineageData.downstream.length} downstream
              </div>
            </>
          )}
        </>
      )}
      {searchResults !== null && !selectedEntity && (
        <>
          <i className="fas fa-chevron-right" style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }} />
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 14px", borderRadius: 20,
            background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
            fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)",
          }}>
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
          </div>
        </>
      )}
    </div>
  );

  return (
    <PageLayout
      icon="fa-share-nodes"
      title="Lineage Explorer"
      subtitle="Trace upstream and downstream dependencies from Microsoft Purview"
      heroContent={heroContent}
    >
      {/* Main card — search + results/empty in one */}
      {!selectedEntity && (
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderTop: "3px solid var(--forge-primary)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", marginBottom: 24 }}>
          {/* Search row */}
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #f1f5f9" }}>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ position: "relative", flex: 1 }}>
                <i className="fas fa-magnifying-glass" style={{
                  position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
                  color: "#94a3b8", fontSize: 14,
                }} />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleSearch()}
                  placeholder="Search for a dataset by name…"
                  style={{
                    width: "100%", padding: "10px 14px 10px 42px",
                    borderRadius: 9, border: "1px solid #e2e8f0",
                    fontSize: 14, outline: "none", background: "#f8fafc",
                    boxSizing: "border-box", color: "#0f172a",
                  }}
                />
              </div>
              <button
                onClick={handleSearch}
                disabled={searching || !query.trim()}
                style={{
                  padding: "10px 22px", borderRadius: 9,
                  border: "none", background: "var(--forge-primary)",
                  color: "#fff", fontSize: 14, fontWeight: 600,
                  cursor: searching || !query.trim() ? "not-allowed" : "pointer",
                  opacity: !query.trim() ? 0.5 : 1,
                  display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap",
                }}
              >
                <i className={`fas ${searching ? "fa-spinner fa-spin" : "fa-search"}`} style={{ fontSize: 12 }} />
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
          </div>

          {/* Content below search */}
          {searchError && (
            <div style={{ padding: "16px 24px", color: "#dc2626", fontSize: 13, borderBottom: "1px solid #fca5a5", background: "#fef2f2" }}>
              <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
              {searchError}
            </div>
          )}

          {!searching && searchResults === null && !searchError && (
            <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#334155", marginBottom: 6 }}>No lineage selected</div>
              <div style={{ fontSize: 13 }}>Enter a dataset name above to explore upstream sources and downstream consumers.</div>
            </div>
          )}

          {searchResults !== null && (
            <>
              <div style={{ padding: "12px 24px 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "#94a3b8" }}>
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
              </div>
              {searchResults.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>
                  No datasets found matching your query.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 24px 20px" }}>
                  {searchResults.map(r => (
              <div
                key={r.id}
                onClick={() => handleSelect(r)}
                style={{
                  background: "#fff", border: "1px solid #e2e8f0",
                  borderTop: "3px solid var(--forge-primary)", borderRadius: 10,
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
                    background: "rgba(var(--forge-primary-rgb), 0.08)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <i className="fas fa-table" style={{ color: "var(--forge-primary)", fontSize: 13 }} />
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
                    background: "rgba(var(--forge-primary-rgb), 0.08)", color: "var(--forge-primary)",
                  }}>
                    {r.type || "DataSet"}
                  </span>
                  <i className="fas fa-arrow-right" style={{ color: "#cbd5e1", fontSize: 12 }} />
                </div>
                  </div>
                ))}
                </div>
              )}
            </>
          )}
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
            borderTop: "3px solid var(--forge-primary)", borderRadius: 12,
            padding: "20px 24px", marginBottom: 28,
            boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: "rgba(var(--forge-primary-rgb), 0.08)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <i className="fas fa-table" style={{ color: "var(--forge-primary)", fontSize: 16 }} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a" }}>{selectedEntity.name}</div>
                <div style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace", marginTop: 2 }}>
                  {selectedEntity.qualified_name}
                </div>
              </div>
              <span style={{
                marginLeft: "auto", padding: "3px 10px", borderRadius: 8,
                fontSize: 12, fontWeight: 600,
                background: "rgba(var(--forge-primary-rgb), 0.08)", color: "var(--forge-primary)",
              }}>
                {selectedEntity.type || "DataSet"}
              </span>
            </div>
          </div>

          <div style={{ background: "#fff", border: `1px solid ${lineageError ? "#fca5a5" : "#e2e8f0"}`, borderTop: `3px solid ${lineageError ? "#ef4444" : "var(--forge-primary)"}`, borderRadius: 12, padding: lineageLoading || lineageError ? 0 : 24, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
            {lineageLoading && <ForgeLoader text="Loading lineage from Purview…" fullscreen={false} />}

            {lineageError && (
              <div style={{ padding: "16px 20px", color: "#dc2626" }}>
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
                    width: 28, height: 28, borderRadius: 7,
                    background: "rgba(var(--forge-primary-rgb), 0.1)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <i className="fas fa-arrow-up" style={{ color: "var(--forge-primary)", fontSize: 11 }} />
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Upstream</span>
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>({lineageData.upstream.length})</span>
                </div>
                {lineageData.upstream.length === 0 ? (
                  <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "24px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
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
                    width: 28, height: 28, borderRadius: 7,
                    background: "rgba(var(--forge-secondary-rgb), 0.1)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <i className="fas fa-arrow-down" style={{ color: "var(--forge-secondary)", fontSize: 11 }} />
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Downstream</span>
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>({lineageData.downstream.length})</span>
                </div>
                {lineageData.downstream.length === 0 ? (
                  <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "24px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
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
        </div>
      )}

    </PageLayout>
  );
}
