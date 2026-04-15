"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { ForgeLoader } from "../../components/ForgeLoader";
import { PageLayout } from "../../components/PageLayout";

interface RgCost {
  key: string;
  display_name: string;
  rg: string;
  total_cost: number | null;
  currency: string;
  period_days: number;
  breakdown: { resource_type: string; cost: number }[];
  error?: string;
}

function formatCurrency(n: number, _currency = "USD"): string {
  return "$" + new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function shortResourceType(rt: string): string {
  // "microsoft.containerservice/managedclusters" → "AKS"
  const map: Record<string, string> = {
    "microsoft.containerservice/managedclusters": "AKS",
    "microsoft.compute/virtualmachinescalesets": "VMSS",
    "microsoft.compute/disks": "Disks",
    "microsoft.network/loadbalancers": "Load Balancers",
    "microsoft.network/publicipaddresses": "Public IPs",
    "microsoft.network/virtualnetworks": "VNet",
    "microsoft.storage/storageaccounts": "Storage",
    "microsoft.keyvault/vaults": "Key Vault",
    "microsoft.monitor/accounts": "Monitor",
    "microsoft.operationalinsights/workspaces": "Log Analytics",
  };
  const lower = rt.toLowerCase();
  if (map[lower]) return map[lower];
  const parts = rt.split("/");
  return parts[parts.length - 1] ?? rt;
}

const RG_ICONS: Record<string, string> = {
  compute: "fa-bolt",
  orchestration: "fa-calendar-check",
};

function RgCard({ rg, days }: { rg: RgCost; days: number }) {
  const icon = RG_ICONS[rg.key] ?? "fa-server";
  const maxCost = rg.breakdown.length
    ? Math.max(...rg.breakdown.map((b) => b.cost))
    : 1;

  return (
    <div style={{
      background: "#fff", borderRadius: 16,
      border: "1px solid #e2e8f0",
      borderTop: "3px solid var(--forge-primary)",
      boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
      overflow: "hidden",
    }}>
      {/* Card header */}
      <div style={{ padding: "22px 24px 18px", borderBottom: "1px solid #f1f5f9" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: "rgba(var(--forge-primary-rgb), 0.08)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <i className={`fas ${icon}`} style={{ color: "var(--forge-primary)", fontSize: 15 }} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
              {rg.display_name}
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace", marginTop: 1 }}>
              {rg.rg}
            </div>
          </div>
        </div>

        {rg.error ? (
          <div style={{
            padding: "10px 14px", borderRadius: 9,
            background: "#fef9f0", border: "1px solid #fcd34d",
            fontSize: 12, color: "#92400e", display: "flex", alignItems: "center", gap: 8,
          }}>
            <i className="fas fa-triangle-exclamation" />
            {rg.error}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8" }}>
              Last {days} days
            </div>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
              {rg.total_cost !== null ? formatCurrency(rg.total_cost, rg.currency) : "—"}
            </div>
          </div>
        )}
      </div>

      {/* Breakdown */}
      {rg.breakdown.length > 0 && (
        <div style={{ padding: "16px 24px 20px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8", marginBottom: 12 }}>
            By resource type
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rg.breakdown.map((b) => {
              const pct = maxCost > 0 ? (b.cost / maxCost) * 100 : 0;
              return (
                <div key={b.resource_type}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>
                      {shortResourceType(b.resource_type)}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                      {formatCurrency(b.cost, rg.currency)}
                    </span>
                  </div>
                  <div style={{ height: 5, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      width: `${pct}%`, height: "100%", borderRadius: 3,
                      background: "linear-gradient(90deg, var(--forge-primary), var(--forge-secondary))",
                      transition: "width 0.6s ease",
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CostPage() {
  const { getToken } = useAuth();
  const [rgs, setRgs] = useState<RgCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<RgCost[]>(`/api/cost/by-rg?days=${days}`, getToken)
      .then(setRgs)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [getToken, days]);

  const totalAcrossRgs = rgs
    .filter((r) => r.total_cost !== null)
    .reduce((s, r) => s + (r.total_cost ?? 0), 0);
  const currency = rgs[0]?.currency ?? "GBP";

  const heroContent = (
    <div style={{ display: "flex", gap: 6 }}>
      {[7, 30, 90].map((d) => (
        <button
          key={d}
          onClick={() => setDays(d)}
          type="button"
          style={{
            padding: "5px 14px", borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.3)",
            background: days === d ? "rgba(255,255,255,0.25)" : "transparent",
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          {d}d
        </button>
      ))}
    </div>
  );

  return (
    <PageLayout
      icon="fa-coins"
      title="Cost Explorer"
      subtitle="Azure spend across Forge resource groups"
      heroContent={heroContent}
    >
      {loading && <ForgeLoader text="Loading cost data…" fullscreen={false} />}

      {!loading && error && (
        <div style={{
          background: "#fff", border: "1px solid #fca5a5", borderTop: "3px solid #ef4444",
          borderRadius: 12, padding: "20px 24px", color: "#dc2626", fontSize: 13,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <i className="fas fa-circle-exclamation" />
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Combined total */}
          {rgs.some((r) => r.total_cost !== null) && (
            <div style={{
              display: "inline-flex", flexDirection: "column", gap: 4,
              padding: "16px 24px", background: "#fff", borderRadius: 14,
              border: "1px solid #e2e8f0", boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
              marginBottom: 28,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8" }}>
                Total — last {days} days
              </span>
              <span style={{ fontSize: 32, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
                {formatCurrency(totalAcrossRgs, currency)}
              </span>
              <span style={{ fontSize: 13, color: "#64748b" }}>
                across {rgs.filter((r) => r.total_cost !== null).length} resource group{rgs.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}

          {/* RG cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(440px, 1fr))", gap: 24, marginBottom: 32 }}>
            {rgs.map((rg) => (
              <RgCard key={rg.key} rg={rg} days={days} />
            ))}
          </div>

          {/* Cost per pipeline — coming soon */}
          <div style={{
            background: "#fff", borderRadius: 16,
            border: "1px dashed #cbd5e1",
            padding: "32px 28px",
            display: "flex", alignItems: "center", gap: 20,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12, flexShrink: 0,
              background: "rgba(var(--forge-primary-rgb), 0.06)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <i className="fas fa-sitemap" style={{ color: "var(--forge-primary)", fontSize: 20, opacity: 0.5 }} />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#334155" }}>
                  Cost per Pipeline
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em",
                  padding: "2px 8px", borderRadius: 20,
                  background: "rgba(var(--forge-primary-rgb), 0.08)",
                  color: "var(--forge-primary)",
                }}>
                  Coming soon
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
                Tag your Azure resources with <code style={{ fontFamily: "monospace", background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>pipeline=&lt;name&gt;</code> and
                cost attribution per DAG will appear here automatically.
              </p>
            </div>
          </div>
        </>
      )}
    </PageLayout>
  );
}
