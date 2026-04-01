"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../../auth/useAuth";
import { apiFetch } from "../../../utils/api";

function maskGuid(val: string): string {
  if (!val) return "";
  const parts = val.split("-");
  if (parts.length === 5) return `${parts[0]}-xxxx-xxxx-xxxx-xxxxxxxxxxxx`;
  if (val.length > 8) return `${val.slice(0, 8)}${"x".repeat(Math.min(val.length - 8, 24))}`;
  return val;
}

const MicrosoftIcon = (
  <svg width="18" height="18" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
  </svg>
);

const PROVIDER_CARDS = [
  {
    id: "local" as const,
    title: "Local",
    desc: "Username & password — dev/test only",
    icon: <i className="fas fa-user-lock" style={{ fontSize: 16, color: "#64748b" }} />,
  },
  {
    id: "azure_ad" as const,
    title: "Azure AD (SSO)",
    desc: "Enterprise single sign-on via Microsoft Entra ID",
    icon: MicrosoftIcon,
  },
];

export default function AuthSettingsPage() {
  const { getToken, role, isConnecting } = useAuth();
  const isAdmin = role === "Admin";

  const [provider, setProvider] = useState<"local" | "azure_ad">("local");
  const [clientId, setClientId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingClientId, setEditingClientId] = useState(false);
  const [editingTenantId, setEditingTenantId] = useState(false);

  // Stable ref so the fetch effect doesn't re-run every time getToken changes.
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);

  useEffect(() => {
    if (!isAdmin || loaded) return;
    (async () => {
      const token = await getTokenRef.current();
      if (!token) {
        setLoadError("No active session — please sign out and sign in again.");
        setLoaded(true);
        return;
      }
      try {
        const d = await apiFetch<{ auth_provider: string; azure_client_id: string; azure_tenant_id: string }>(
          "/api/platform/auth-config", getTokenRef.current
        );
        setProvider(d.auth_provider as "local" | "azure_ad");
        setClientId(d.azure_client_id ?? "");
        setTenantId(d.azure_tenant_id ?? "");
        setLoaded(true);
      } catch (e: unknown) {
        setLoadError(e instanceof Error ? e.message : "Failed to load auth config");
        setLoaded(true);
      }
    })();
  }, [isAdmin, loaded]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMsg(null);
    try {
      await apiFetch("/api/platform/auth-config", getToken, {
        method: "POST",
        body: JSON.stringify({ auth_provider: provider, azure_client_id: clientId, azure_tenant_id: tenantId }),
      });
      setMsg({ ok: true, text: "Saved. Users will see the new login flow on next page load." });
      setEditingClientId(false);
      setEditingTenantId(false);
    } catch (e: unknown) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [getToken, provider, clientId, tenantId]);

  const azureActive = provider === "azure_ad";

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Hero */}
      <div style={{
        background: "linear-gradient(135deg, var(--forge-primary) 0%, var(--forge-dark) 100%)",
        padding: "48px 1.5rem 40px",
      }}>
        <div style={{ maxWidth: 700, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 11, background: "rgba(255,255,255,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <i className="fas fa-shield-halved" style={{ color: "#fff", fontSize: 18 }} />
            </div>
            <h1 style={{ fontSize: "clamp(1.6rem,3.5vw,2.2rem)", fontWeight: 800, color: "#fff", margin: 0, letterSpacing: "-0.02em" }}>
              Authentication
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.7)", margin: 0, fontSize: 15 }}>
            Configure the login method for all Forge users.
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 700, margin: "0 auto", padding: "32px 1.5rem 80px" }}>
        {isConnecting || (!role && !loaded) ? (
          <div style={{ color: "#94a3b8", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            <i className="fas fa-spinner fa-spin" />
            Loading…
          </div>
        ) : !isAdmin ? (
          <div style={{
            background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0",
            padding: "32px 24px", display: "flex", alignItems: "center", gap: 12,
            fontSize: 14, color: "#64748b",
          }}>
            <i className="fas fa-lock" style={{ fontSize: 18, color: "#94a3b8" }} />
            Authentication settings are only available to Admins.
          </div>
        ) : !loaded ? (
          <div style={{ color: "#94a3b8", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            <i className="fas fa-spinner fa-spin" />
            Loading…
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {loadError && (
              <div style={{
                padding: "12px 16px", borderRadius: 10, fontSize: 13,
                background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <i className="fas fa-circle-exclamation" />
                Could not load auth config from backend: {loadError}
              </div>
            )}

            {/* Provider cards */}
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", padding: "24px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8", marginBottom: 14 }}>
                Login method
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {PROVIDER_CARDS.map((card) => {
                  const sel = provider === card.id;
                  return (
                    <button
                      key={card.id}
                      onClick={() => setProvider(card.id)}
                      type="button"
                      style={{
                        width: "100%", padding: "14px 16px", borderRadius: 12,
                        border: `2px solid ${sel ? "var(--forge-primary)" : "#e2e8f0"}`,
                        background: sel ? "rgba(var(--forge-primary-rgb), 0.04)" : "#f8fafc",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 14,
                        textAlign: "left", transition: "all 0.15s",
                      }}
                    >
                      <div style={{
                        width: 40, height: 40, borderRadius: 10,
                        background: sel ? "rgba(var(--forge-primary-rgb), 0.1)" : "#f1f5f9",
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      }}>
                        {card.icon}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: sel ? "var(--forge-primary)" : "#0f172a" }}>
                          {card.title}
                        </div>
                        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{card.desc}</div>
                      </div>
                      <div style={{
                        width: 18, height: 18, borderRadius: "50%",
                        border: `2px solid ${sel ? "var(--forge-primary)" : "#cbd5e1"}`,
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      }}>
                        {sel && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--forge-primary)" }} />}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Azure AD credentials */}
            <div style={{
              background: "#fff", borderRadius: 14,
              border: `1px solid ${azureActive ? "rgba(var(--forge-primary-rgb), 0.3)" : "#e2e8f0"}`,
              padding: "24px",
              opacity: azureActive ? 1 : 0.5,
              pointerEvents: azureActive ? "auto" : "none",
              transition: "all 0.2s",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
                {MicrosoftIcon}
                <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--forge-primary)" }}>
                  Azure AD Configuration
                </span>
              </div>

              {/* Client ID */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
                    Application (Client) ID <span style={{ color: "#dc2626" }}>*</span>
                  </label>
                  {clientId && !editingClientId && (
                    <button type="button" onClick={() => setEditingClientId(true)}
                      style={{ fontSize: 12, color: "var(--forge-primary)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                      <i className="fas fa-pen-to-square" style={{ fontSize: 11, marginRight: 4 }} />Edit
                    </button>
                  )}
                </div>
                {editingClientId || !clientId ? (
                  <input value={clientId} onChange={(e) => setClientId(e.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autoFocus={editingClientId}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 9, border: "1.5px solid rgba(var(--forge-primary-rgb), 0.3)", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box", background: "#fff" }} />
                ) : (
                  <div style={{ padding: "10px 12px", borderRadius: 9, border: "1.5px solid #e2e8f0", fontSize: 13, fontFamily: "monospace", background: "#f8fafc", color: "#64748b" }}>
                    {maskGuid(clientId)}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                  App Registration → Overview → Application (client) ID
                </div>
              </div>

              {/* Tenant ID */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Tenant ID</label>
                  {tenantId && !editingTenantId && (
                    <button type="button" onClick={() => setEditingTenantId(true)}
                      style={{ fontSize: 12, color: "var(--forge-primary)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                      <i className="fas fa-pen-to-square" style={{ fontSize: 11, marginRight: 4 }} />Edit
                    </button>
                  )}
                </div>
                {editingTenantId || !tenantId ? (
                  <input value={tenantId} onChange={(e) => setTenantId(e.target.value)}
                    placeholder="common  (or your tenant GUID)" autoFocus={editingTenantId}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 9, border: "1.5px solid rgba(var(--forge-primary-rgb), 0.3)", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box", background: "#fff" }} />
                ) : (
                  <div style={{ padding: "10px 12px", borderRadius: 9, border: "1.5px solid #e2e8f0", fontSize: 13, fontFamily: "monospace", background: "#f8fafc", color: "#64748b" }}>
                    {maskGuid(tenantId)}
                  </div>
                )}
              </div>
            </div>

            {msg && (
              <div style={{
                padding: "12px 16px", borderRadius: 10, fontSize: 13,
                background: msg.ok ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${msg.ok ? "#86efac" : "#fca5a5"}`,
                color: msg.ok ? "#15803d" : "#dc2626",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <i className={`fas ${msg.ok ? "fa-circle-check" : "fa-circle-exclamation"}`} />
                {msg.text}
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={saving || (provider === "azure_ad" && !clientId.trim())}
              type="button"
              style={{
                alignSelf: "flex-start", padding: "11px 24px", borderRadius: 10, border: "none",
                background: saving || (provider === "azure_ad" && !clientId.trim()) ? "#e2e8f0" : "var(--forge-primary)",
                color: saving || (provider === "azure_ad" && !clientId.trim()) ? "#94a3b8" : "#fff",
                fontSize: 14, fontWeight: 700, cursor: saving ? "default" : "pointer",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              {saving
                ? <><i className="fas fa-spinner fa-spin" style={{ fontSize: 12 }} />Saving…</>
                : <><i className="fas fa-floppy-disk" style={{ fontSize: 12 }} />Save</>
              }
            </button>

          </div>
        )}
      </div>
    </div>
  );
}
