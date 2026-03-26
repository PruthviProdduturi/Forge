"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";

interface PlatformInfo {
  env: string;
  auth_provider: string;
  platform: {
    airflow_host: string;
    trino_host: string;
    adls_account: string;
    purview_endpoint: string;
    resource_group: string;
  };
}

export default function SettingsPage() {
  const { getToken, role } = useAuth();
  const isAdmin = role === "Admin";

  // ── Platform ─────────────────────────────────────────────────────────────────
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);

  useEffect(() => {
    apiFetch<PlatformInfo>("/api/health", getToken)
      .then(setPlatformInfo)
      .catch(() => {/* non-critical */});
  }, [getToken]);

  // ── AAD config (Admin only) ──────────────────────────────────────────────────
  const [aadProvider, setAadProvider] = useState<"local" | "azure_ad">("local");
  const [aadClientId, setAadClientId] = useState("");
  const [aadTenantId, setAadTenantId] = useState("");
  const [aadSaving, setAadSaving] = useState(false);
  const [aadMsg, setAadMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aadLoaded, setAadLoaded] = useState(false);

  useEffect(() => {
    if (!isAdmin || aadLoaded) return;
    apiFetch<{ auth_provider: string; azure_client_id: string; azure_tenant_id: string }>(
      "/api/platform/auth-config", getToken
    ).then((d) => {
      setAadProvider(d.auth_provider as "local" | "azure_ad");
      setAadClientId(d.azure_client_id ?? "");
      setAadTenantId(d.azure_tenant_id ?? "");
      setAadLoaded(true);
    }).catch(() => setAadLoaded(true));
  }, [isAdmin, aadLoaded, getToken]);

  const handleSaveAad = useCallback(async () => {
    setAadSaving(true);
    setAadMsg(null);
    try {
      await apiFetch("/api/platform/auth-config", getToken, {
        method: "POST",
        body: JSON.stringify({ auth_provider: aadProvider, azure_client_id: aadClientId, azure_tenant_id: aadTenantId }),
      });
      setAadMsg({ ok: true, text: "Saved. Reload the page for users to see the new login flow." });
    } catch (e: unknown) {
      setAadMsg({ ok: false, text: (e as Error).message });
    } finally {
      setAadSaving(false);
    }
  }, [getToken, aadProvider, aadClientId, aadTenantId]);

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "40px 24px 80px" }}>

        {/* Page header */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10, background: "#1e3a5f14",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <i className="fas fa-gear" style={{ color: "#1e3a5f", fontSize: 18 }} />
            </div>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: "#0f172a", margin: 0 }}>Platform Settings</h1>
          </div>
          <p style={{ fontSize: 14, color: "#64748b", margin: 0 }}>
            Platform connection info and authentication configuration.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

          {/* ── Platform Connection ─────────────────────────────────────────────── */}
          <section style={{
            background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0",
            overflow: "hidden",
          }}>
            <div style={{
              padding: "18px 24px", borderBottom: "1px solid #f1f5f9",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <i className="fas fa-server" style={{ color: "#0078d4", fontSize: 15 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>Platform Connection</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>Connected infrastructure endpoints</div>
              </div>
            </div>
            <div style={{ padding: "4px 24px 16px" }}>
              {platformInfo ? (
                <>
                  <PlatformRow
                    label="Environment"
                    value={(platformInfo.env ?? "dev").toUpperCase()}
                    highlight={platformInfo.env === "prod" ? "red" : "green"}
                  />
                  <PlatformRow
                    label="Auth Provider"
                    value={platformInfo.auth_provider === "azure_ad" ? "Azure AD (SSO)" : "Local (admin/admin)"}
                  />
                  <PlatformRow label="Airflow" value={platformInfo.platform?.airflow_host ?? "—"} mono />
                  <PlatformRow label="Trino" value={platformInfo.platform?.trino_host ?? "—"} mono />
                  <PlatformRow label="ADLS Account" value={platformInfo.platform?.adls_account ?? "—"} mono />
                  <PlatformRow
                    label="Purview"
                    value={(platformInfo.platform?.purview_endpoint ?? "").replace("https://", "") || "—"}
                    mono
                  />
                  <PlatformRow label="Resource Group" value={platformInfo.platform?.resource_group ?? "—"} mono />
                </>
              ) : (
                <div style={{ padding: "16px 0", color: "#94a3b8", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: 12 }} />
                  Loading platform info…
                </div>
              )}
            </div>
          </section>

          {/* ── Authentication Configuration ────────────────────────────────────── */}
          <section style={{
            background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0",
            overflow: "hidden",
          }}>
            <div style={{
              padding: "18px 24px", borderBottom: "1px solid #f1f5f9",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <i className="fas fa-shield-halved" style={{ color: "#7c3aed", fontSize: 15 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>Authentication</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>Configure login method for all users</div>
              </div>
            </div>
            <div style={{ padding: "20px 24px" }}>
              {!isAdmin ? (
                <div style={{
                  background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10,
                  padding: "14px 16px", fontSize: 13, color: "#64748b",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <i className="fas fa-lock" />
                  Authentication settings are only available to Admins.
                </div>
              ) : !aadLoaded ? (
                <div style={{ color: "#94a3b8", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: 12 }} />
                  Loading…
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  <div>
                    <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 8 }}>
                      Login method
                    </label>
                    <div style={{ display: "flex", gap: 10 }}>
                      {(["local", "azure_ad"] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setAadProvider(p)}
                          type="button"
                          style={{
                            flex: 1, padding: "10px 14px", borderRadius: 10,
                            border: `2px solid ${aadProvider === p ? "#7c3aed" : "#e2e8f0"}`,
                            background: aadProvider === p ? "#f5f3ff" : "#f8fafc",
                            color: aadProvider === p ? "#7c3aed" : "#64748b",
                            fontSize: 13, fontWeight: 600, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                            transition: "all 0.15s",
                          }}
                        >
                          <i className={`fas ${p === "azure_ad" ? "fa-microsoft" : "fa-user"}`} style={{ fontSize: 13 }} />
                          {p === "azure_ad" ? "Azure AD (SSO)" : "Local (admin/admin)"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {aadProvider === "azure_ad" && (
                    <>
                      <div>
                        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>
                          Azure App Client ID <span style={{ color: "#dc2626" }}>*</span>
                        </label>
                        <input
                          value={aadClientId}
                          onChange={(e) => setAadClientId(e.target.value)}
                          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                          style={{
                            width: "100%", padding: "10px 12px", borderRadius: 10,
                            border: "1.5px solid #e2e8f0", fontSize: 13, fontFamily: "monospace",
                            outline: "none", boxSizing: "border-box", background: "#f8fafc",
                          }}
                        />
                        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                          Azure AD App Registration → Overview → Application (client) ID
                        </div>
                      </div>
                      <div>
                        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>
                          Tenant ID
                        </label>
                        <input
                          value={aadTenantId}
                          onChange={(e) => setAadTenantId(e.target.value)}
                          placeholder="common  (or your tenant GUID)"
                          style={{
                            width: "100%", padding: "10px 12px", borderRadius: 10,
                            border: "1.5px solid #e2e8f0", fontSize: 13, fontFamily: "monospace",
                            outline: "none", boxSizing: "border-box", background: "#f8fafc",
                          }}
                        />
                      </div>
                    </>
                  )}

                  {aadMsg && (
                    <div style={{
                      padding: "10px 14px", borderRadius: 10, fontSize: 13,
                      background: aadMsg.ok ? "#f0fdf4" : "#fef2f2",
                      border: `1px solid ${aadMsg.ok ? "#86efac" : "#fca5a5"}`,
                      color: aadMsg.ok ? "#15803d" : "#dc2626",
                      display: "flex", alignItems: "center", gap: 8,
                    }}>
                      <i className={`fas ${aadMsg.ok ? "fa-circle-check" : "fa-circle-exclamation"}`} />
                      {aadMsg.text}
                    </div>
                  )}

                  <div>
                    <button
                      onClick={handleSaveAad}
                      disabled={aadSaving || (aadProvider === "azure_ad" && !aadClientId.trim())}
                      type="button"
                      style={{
                        padding: "10px 20px", borderRadius: 10, border: "none",
                        background: aadSaving || (aadProvider === "azure_ad" && !aadClientId.trim()) ? "#e2e8f0" : "#7c3aed",
                        color: aadSaving || (aadProvider === "azure_ad" && !aadClientId.trim()) ? "#94a3b8" : "#fff",
                        fontSize: 14, fontWeight: 700, cursor: aadSaving ? "default" : "pointer",
                        display: "flex", alignItems: "center", gap: 8,
                      }}
                    >
                      {aadSaving
                        ? <><i className="fas fa-spinner fa-spin" style={{ fontSize: 12 }} />Saving…</>
                        : <><i className="fas fa-floppy-disk" style={{ fontSize: 12 }} />Save auth config</>
                      }
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}

function PlatformRow({
  label, value, mono = false, highlight,
}: {
  label: string; value: string; mono?: boolean; highlight?: "red" | "green";
}) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "10px 0", borderBottom: "1px solid #f8fafc", gap: 16,
    }}>
      <span style={{ fontSize: 13, color: "#64748b", flexShrink: 0 }}>{label}</span>
      {highlight ? (
        <span style={{
          padding: "2px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700,
          background: highlight === "red" ? "#fee2e2" : "#dcfce7",
          color: highlight === "red" ? "#dc2626" : "#16a34a",
        }}>
          {value}
        </span>
      ) : (
        <span style={{
          fontSize: 13, fontWeight: 500, color: "#0f172a",
          fontFamily: mono ? "monospace" : "inherit",
          wordBreak: "break-all", textAlign: "right",
        }}>
          {value}
        </span>
      )}
    </div>
  );
}
