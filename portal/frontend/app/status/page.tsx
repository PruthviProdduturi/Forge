"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";

interface Pod {
  name: string;
  phase: string;
  ready: boolean;
  error?: string;
}

interface OrchestraStatus {
  reachable: boolean;
  namespaces?: Record<string, Pod[]>;
  error?: string;
}

interface NodePool {
  name: string;
  provisioning_state: string;
  vm_size: string;
  count: number | null;
  min_count: number | null;
  max_count: number | null;
  mode: string;
}

interface AzureClusterStatus {
  reachable: boolean;
  provisioning_state?: string;
  kubernetes_version?: string;
  fqdn?: string;
  node_pools?: NodePool[];
  error?: string;
}

interface WorkloadProbe {
  name: string;
  reachable: boolean;
  status_code?: number;
  error?: string;
}

interface StatusData {
  env: string;
  orchestration_cluster: OrchestraStatus;
  compute_cluster: {
    azure_resource: AzureClusterStatus;
    workload_probes: WorkloadProbe[];
  };
}

function PhaseChip({ phase, ready }: { phase: string; ready: boolean }) {
  const running = phase === "Running";
  const color = running && ready ? "#16a34a" : running ? "#ca8a04" : phase === "Succeeded" ? "#0284c7" : "#dc2626";
  const bg    = running && ready ? "#dcfce7" : running ? "#fef9c3" : phase === "Succeeded" ? "#e0f2fe" : "#fee2e2";
  return (
    <span style={{ padding: "1px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700, background: bg, color }}>
      {phase}
    </span>
  );
}

function StateChip({ state }: { state: string }) {
  const ok = state === "Succeeded";
  return (
    <span style={{ padding: "1px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700,
      background: ok ? "#dcfce7" : "#fef9c3", color: ok ? "#16a34a" : "#ca8a04" }}>
      {state}
    </span>
  );
}

export default function StatusPage() {
  const { getToken } = useAuth();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<string | null>(null);

  const fetchStatus = useCallback(() => {
    setLoading(true);
    apiFetch<StatusData>("/api/status", getToken)
      .then(setStatus)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [getToken]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleClearFailed = useCallback(async () => {
    setClearing(true);
    setClearResult(null);
    try {
      const result = await apiFetch<{ deleted: number; namespaces: string[] }>(
        "/api/status/clear-failed",
        getToken,
        { method: "DELETE" },
      );
      setClearResult(`Cleared ${result.deleted} failed pod${result.deleted !== 1 ? "s" : ""}`);
      setTimeout(fetchStatus, 1500);
    } catch (e: unknown) {
      setClearResult(e instanceof Error ? e.message : "Failed to clear pods");
    } finally {
      setClearing(false);
    }
  }, [getToken, fetchStatus]);

  const orch    = status?.orchestration_cluster;
  const compute = status?.compute_cluster;

  // Count failed pods across all orch namespaces
  const failedCount = orch?.namespaces
    ? Object.values(orch.namespaces).flat().filter(p => p.phase === "Failed").length
    : 0;

  return (
    <PageLayout
      icon="fa-server"
      title="Cluster Status"
      subtitle="Live AKS pod and node pool health for orchestration and compute clusters"
    >
      <div style={{ maxWidth: 1300, margin: "0 auto" }}>
        {/* Toolbar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          {clearResult && (
            <span style={{ fontSize: 12, color: clearResult.startsWith("Cleared") ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
              {clearResult}
            </span>
          )}
          {failedCount > 0 && (
            <button
              onClick={handleClearFailed}
              disabled={clearing}
              style={{
                display: "flex", alignItems: "center", gap: 7,
                padding: "6px 14px", borderRadius: 8,
                background: "#fef2f2", border: "1px solid #fca5a5",
                color: "#dc2626", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}
            >
              <i className={`fas ${clearing ? "fa-spinner fa-spin" : "fa-trash-can"}`} style={{ fontSize: 11 }} />
              {clearing ? "Clearing…" : `Clear ${failedCount} failed pod${failedCount !== 1 ? "s" : ""}`}
            </button>
          )}
          <button
            onClick={fetchStatus}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 14px", borderRadius: 8,
              background: "#fff", border: "1px solid #e2e8f0",
              color: "#64748b", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >
            <i className={`fas ${loading ? "fa-spinner fa-spin" : "fa-rotate-right"}`} style={{ fontSize: 11 }} />
            Refresh
          </button>
        </div>

        {loading && !status && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "#94a3b8", fontSize: 13 }}>
            <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
            Querying cluster status…
          </div>
        )}
        {error && (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "14px 18px", color: "#dc2626", fontSize: 13, marginBottom: 16 }}>
            <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />{error}
          </div>
        )}

        {/* Side-by-side panels */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
          {/* ── Orchestration cluster ── */}
          {orch && (
            <Section title="Orchestration Cluster" icon="fa-sitemap" subtitle="Airflow · Portal · Monitoring — in-cluster K8s API">
              {!orch.reachable ? (
                <div style={{ padding: "16px", color: "#94a3b8", fontSize: 13 }}>
                  <i className="fas fa-circle-xmark" style={{ marginRight: 6, color: "#f87171" }} />
                  {orch.error ?? "In-cluster API unavailable"}
                </div>
              ) : (
                Object.entries(orch.namespaces ?? {}).map(([ns, pods]) => (
                  <div key={ns} style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8", marginBottom: 8 }}>
                      {ns}
                      <span style={{ marginLeft: 6, fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "#cbd5e1" }}>
                        ({pods.length} pod{pods.length !== 1 ? "s" : ""})
                      </span>
                    </div>
                    {pods.length === 0 ? (
                      <div style={{ fontSize: 12, color: "#94a3b8", paddingLeft: 4 }}>No pods</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto" }}>
                        {pods.map((pod, i) => (
                          <div key={i} style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "7px 10px", background: "#fff",
                            border: "1px solid #f1f5f9", borderRadius: 7,
                          }}>
                            <span style={{
                              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                              background: pod.ready ? "#4ade80" : pod.phase === "Succeeded" ? "#60a5fa" : "#f87171",
                            }} />
                            <span style={{ flex: 1, minWidth: 0, fontFamily: "monospace", fontSize: 11, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {pod.name}
                            </span>
                            {pod.phase && <PhaseChip phase={pod.phase} ready={pod.ready} />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </Section>
          )}

          {/* ── Compute cluster ── */}
          {compute && (
            <Section title="Compute Cluster" icon="fa-microchip" subtitle="Spark · Trino · Hive Metastore — Azure AKS API">
              {!compute.azure_resource.reachable ? (
                <div style={{ padding: "16px", color: "#94a3b8", fontSize: 13 }}>
                  <i className="fas fa-circle-info" style={{ marginRight: 6, color: "#60a5fa" }} />
                  {compute.azure_resource.error ?? "Azure resource API unavailable"}
                </div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
                    {[
                      { label: "Provisioning", value: compute.azure_resource.provisioning_state ?? "—" },
                      { label: "K8s Version",  value: compute.azure_resource.kubernetes_version  ?? "—" },
                      { label: "Hostname",     value: compute.azure_resource.fqdn               ?? "—" },
                    ].map(s => (
                      <div key={s.label} style={{ background: "#f8fafc", borderRadius: 8, padding: "8px 12px", border: "1px solid #e2e8f0" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#94a3b8", marginBottom: 3 }}>{s.label}</div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a", wordBreak: "break-all" }}>{s.value}</div>
                      </div>
                    ))}
                  </div>

                  {(compute.azure_resource.node_pools ?? []).length > 0 && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8", marginBottom: 8 }}>Node Pools</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {(compute.azure_resource.node_pools ?? []).map(pool => (
                          <div key={pool.name} style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "10px 12px", background: "#fff",
                            border: "1px solid #f1f5f9", borderRadius: 8,
                          }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 12, color: "#0f172a" }}>{pool.name}</div>
                              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{pool.vm_size} · {pool.mode}</div>
                            </div>
                            <div style={{ fontSize: 12, color: "#64748b", textAlign: "right" }}>
                              {pool.count !== null ? `${pool.count} node${pool.count !== 1 ? "s" : ""}` : "—"}
                              {pool.min_count !== null && pool.max_count !== null && (
                                <div style={{ fontSize: 10, color: "#94a3b8" }}>{pool.min_count}–{pool.max_count} autoscale</div>
                              )}
                            </div>
                            <StateChip state={pool.provisioning_state} />
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {compute.workload_probes.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8", marginBottom: 8 }}>Workload Probes</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {compute.workload_probes.map(p => (
                          <div key={p.name} style={{
                            display: "flex", alignItems: "center", gap: 6,
                            padding: "5px 12px", borderRadius: 7,
                            background: p.reachable ? "#dcfce7" : "#fef2f2",
                            border: `1px solid ${p.reachable ? "#86efac" : "#fca5a5"}`,
                          }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.reachable ? "#16a34a" : "#dc2626", flexShrink: 0 }} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: p.reachable ? "#16a34a" : "#dc2626" }}>{p.name}</span>
                            {p.status_code && <span style={{ fontSize: 11, color: "#64748b" }}>{p.status_code}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </Section>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

function Section({ title, icon, subtitle, children }: {
  title: string; icon: string; subtitle: string; children: React.ReactNode;
}) {
  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(var(--forge-primary-rgb),0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <i className={`fas ${icon}`} style={{ color: "var(--forge-primary)", fontSize: 13 }} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a" }}>{title}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{subtitle}</div>
        </div>
      </div>
      <div style={{ padding: "14px 18px 18px" }}>{children}</div>
    </div>
  );
}
