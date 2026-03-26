"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useAuth } from "../auth/useAuth";
import { apiFetch } from "../utils/api";

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

const PRESET_COLORS = [
  "#1e3a5f", // Forge deep navy (default)
  "#0078d4", // Azure blue
  "#107c10", // Microsoft green
  "#d83b01", // Microsoft orange
  "#5c2d91", // Purple
  "#008272", // Teal
  "#004b1c", // Dark green
  "#32145a", // Dark purple
  "#004e8c", // Deep blue
  "#8764b8", // Light purple
  "#0099bc", // Cyan
  "#e3008c", // Magenta
];

interface SettingsModalProps {
  onClose: () => void;
  platformInfo?: PlatformInfo | null;
}

type Tab = "appearance" | "platform";

export function SettingsModal({ onClose, platformInfo }: SettingsModalProps) {
  const { primaryColor, saveTheme } = useTheme();
  const { getToken, role } = useAuth();
  const isAdmin = role === "Admin";
  const [tab, setTab] = useState<Tab>("appearance");
  const [localColor, setLocalColor] = useState(primaryColor);
  const [hexInput, setHexInput] = useState(primaryColor);
  const [saving, setSaving] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // AAD config form state (Admin only)
  const [aadProvider, setAadProvider] = useState<"local" | "azure_ad">("local");
  const [aadClientId, setAadClientId] = useState("");
  const [aadTenantId, setAadTenantId] = useState("");
  const [aadSaving, setAadSaving] = useState(false);
  const [aadMsg, setAadMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aadLoaded, setAadLoaded] = useState(false);

  // Load current AAD config when Admin opens Platform tab
  useEffect(() => {
    if (tab !== "platform" || !isAdmin || aadLoaded) return;
    apiFetch<{ auth_provider: string; azure_client_id: string; azure_tenant_id: string }>(
      "/api/platform/auth-config", getToken
    ).then((d) => {
      setAadProvider(d.auth_provider as "local" | "azure_ad");
      setAadClientId(d.azure_client_id ?? "");
      setAadTenantId(d.azure_tenant_id ?? "");
      setAadLoaded(true);
    }).catch(() => setAadLoaded(true));
  }, [tab, isAdmin, aadLoaded, getToken]);

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

  // Sync if theme changes externally
  useEffect(() => {
    setLocalColor(primaryColor);
    setHexInput(primaryColor);
  }, [primaryColor]);

  const applyColor = useCallback((color: string) => {
    setLocalColor(color);
    setHexInput(color);
  }, []);

  const handleHexChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setHexInput(val);
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        setLocalColor(val);
      }
    },
    []
  );

  const handleSave = useCallback(async () => {
    if (!/^#[0-9a-fA-F]{6}$/.test(localColor)) return;
    setSaving(true);
    try {
      await saveTheme(localColor);
    } finally {
      setSaving(false);
      onClose();
    }
  }, [localColor, saveTheme, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="modal-box">
        <div className="modal-header">
          <span className="modal-title">
            <i className="fas fa-gear" style={{ marginRight: 8, opacity: 0.7 }} />
            Settings
          </span>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">
            <i className="fas fa-times" />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid #e2e8f0", paddingBottom: 0 }}>
          {([["appearance", "fa-palette", "Appearance"], ["platform", "fa-server", "Platform"]] as const).map(([t, icon, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "6px 14px", borderRadius: "6px 6px 0 0", border: "none",
                background: tab === t ? "#fff" : "transparent",
                borderBottom: tab === t ? "2px solid #0284c7" : "2px solid transparent",
                color: tab === t ? "#0284c7" : "#64748b",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
              }}
              type="button"
            >
              <i className={`fas ${icon}`} style={{ fontSize: 12 }} />
              {label}
            </button>
          ))}
        </div>

        {tab === "platform" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Connection info — always visible */}
            {platformInfo && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8", marginBottom: 8 }}>
                  Connection
                </div>
                <PlatformRow label="Environment" value={(platformInfo.env ?? "dev").toUpperCase()} highlight={platformInfo.env === "prod" ? "red" : "green"} />
                <PlatformRow label="Auth Provider" value={platformInfo.auth_provider === "azure_ad" ? "Azure AD (SSO)" : "Local (admin/admin)"} />
                <PlatformRow label="Airflow" value={platformInfo.platform?.airflow_host ?? "—"} mono />
                <PlatformRow label="Trino" value={platformInfo.platform?.trino_host ?? "—"} mono />
                <PlatformRow label="ADLS" value={platformInfo.platform?.adls_account ?? "—"} mono />
                <PlatformRow label="Purview" value={(platformInfo.platform?.purview_endpoint ?? "").replace("https://", "") || "—"} mono />
              </div>
            )}

            {/* AAD config — Admin only */}
            {isAdmin ? (
              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8", marginBottom: 12 }}>
                  <i className="fas fa-shield-halved" style={{ marginRight: 6 }} />
                  Authentication Configuration
                </div>

                {!aadLoaded ? (
                  <div style={{ color: "#94a3b8", fontSize: 13 }}>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading…
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Provider toggle */}
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#475569", display: "block", marginBottom: 6 }}>
                        Login method
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        {(["local", "azure_ad"] as const).map((p) => (
                          <button
                            key={p}
                            onClick={() => setAadProvider(p)}
                            type="button"
                            style={{
                              flex: 1, padding: "8px 12px", borderRadius: 8,
                              border: `1.5px solid ${aadProvider === p ? "#0284c7" : "#e2e8f0"}`,
                              background: aadProvider === p ? "#e0f2fe" : "#f8fafc",
                              color: aadProvider === p ? "#0284c7" : "#64748b",
                              fontSize: 12, fontWeight: 600, cursor: "pointer",
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                            }}
                          >
                            <i className={`fas ${p === "azure_ad" ? "fa-microsoft" : "fa-user"}`} style={{ fontSize: 11 }} />
                            {p === "azure_ad" ? "Azure AD (SSO)" : "Local (admin/admin)"}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* AAD fields */}
                    {aadProvider === "azure_ad" && (
                      <>
                        <div>
                          <label style={{ fontSize: 12, fontWeight: 600, color: "#475569", display: "block", marginBottom: 4 }}>
                            Azure App Client ID <span style={{ color: "#dc2626" }}>*</span>
                          </label>
                          <input
                            value={aadClientId}
                            onChange={(e) => setAadClientId(e.target.value)}
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                            style={{
                              width: "100%", padding: "8px 10px", borderRadius: 8,
                              border: "1.5px solid #e2e8f0", fontSize: 12, fontFamily: "monospace",
                              outline: "none", boxSizing: "border-box", background: "#f8fafc",
                            }}
                          />
                          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>
                            From your Azure AD App Registration → Overview → Application (client) ID
                          </div>
                        </div>
                        <div>
                          <label style={{ fontSize: 12, fontWeight: 600, color: "#475569", display: "block", marginBottom: 4 }}>
                            Tenant ID
                          </label>
                          <input
                            value={aadTenantId}
                            onChange={(e) => setAadTenantId(e.target.value)}
                            placeholder="common  (or your tenant GUID)"
                            style={{
                              width: "100%", padding: "8px 10px", borderRadius: 8,
                              border: "1.5px solid #e2e8f0", fontSize: 12, fontFamily: "monospace",
                              outline: "none", boxSizing: "border-box", background: "#f8fafc",
                            }}
                          />
                        </div>
                      </>
                    )}

                    {aadMsg && (
                      <div style={{
                        padding: "8px 12px", borderRadius: 8, fontSize: 12,
                        background: aadMsg.ok ? "#f0fdf4" : "#fef2f2",
                        border: `1px solid ${aadMsg.ok ? "#86efac" : "#fca5a5"}`,
                        color: aadMsg.ok ? "#15803d" : "#dc2626",
                      }}>
                        <i className={`fas ${aadMsg.ok ? "fa-circle-check" : "fa-circle-exclamation"}`} style={{ marginRight: 6 }} />
                        {aadMsg.text}
                      </div>
                    )}

                    <button
                      onClick={handleSaveAad}
                      disabled={aadSaving || (aadProvider === "azure_ad" && !aadClientId.trim())}
                      type="button"
                      style={{
                        padding: "9px 16px", borderRadius: 8, border: "none",
                        background: aadSaving || (aadProvider === "azure_ad" && !aadClientId.trim()) ? "#e2e8f0" : "#0284c7",
                        color: aadSaving || (aadProvider === "azure_ad" && !aadClientId.trim()) ? "#94a3b8" : "#fff",
                        fontSize: 13, fontWeight: 700, cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 7,
                      }}
                    >
                      {aadSaving
                        ? <><i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} />Saving…</>
                        : <><i className="fas fa-floppy-disk" style={{ fontSize: 11 }} />Save auth config</>
                      }
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div style={{
                background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8,
                padding: "10px 12px", fontSize: 12, color: "#64748b",
              }}>
                <i className="fas fa-lock" style={{ marginRight: 6 }} />
                Authentication settings are only available to Admins.
              </div>
            )}
          </div>
        )}

        {tab === "appearance" && (
          <>
            <div className="modal-section-label" style={{ marginTop: 0 }}>Theme color</div>
            <div className="color-picker-row">
          <input
            type="color"
            className="color-input"
            value={localColor}
            onChange={(e) => applyColor(e.target.value)}
            aria-label="Color picker"
          />
          <input
            type="text"
            className="color-hex-input"
            value={hexInput}
            onChange={handleHexChange}
            maxLength={7}
            placeholder="#1e3a5f"
            spellCheck={false}
            aria-label="Hex color value"
          />
        </div>

        <div className="color-presets" role="list" aria-label="Preset colors">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              className={`color-preset-dot${localColor.toLowerCase() === c.toLowerCase() ? " active" : ""}`}
              style={{ background: c }}
              onClick={() => applyColor(c)}
              aria-label={c}
              title={c}
              type="button"
              role="listitem"
            />
          ))}
        </div>

        <button
          className="modal-save-btn"
          onClick={handleSave}
          disabled={saving || !/^#[0-9a-fA-F]{6}$/.test(localColor)}
          type="button"
        >
          {saving ? (
            <>
              <span
                style={{
                  width: 14,
                  height: 14,
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  animation: "spin 0.7s linear infinite",
                  display: "inline-block",
                }}
              />
              Saving…
            </>
          ) : (
            <>
              <i className="fas fa-check" />
              Apply Theme
            </>
          )}
        </button>
          </>
        )}
      </div>
    </div>
  );
}

function PlatformRow({
  label,
  value,
  mono = false,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: "red" | "green";
}) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "7px 0", borderBottom: "1px solid #f8fafc", gap: 12,
    }}>
      <span style={{ fontSize: 12, color: "#64748b", flexShrink: 0 }}>{label}</span>
      {highlight ? (
        <span style={{
          padding: "1px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700,
          background: highlight === "prod" ? "#fee2e2" : "#dcfce7",
          color: highlight === "red" ? "#dc2626" : "#16a34a",
        }}>
          {value}
        </span>
      ) : (
        <span style={{
          fontSize: 12, fontWeight: 500, color: "#0f172a",
          fontFamily: mono ? "monospace" : "inherit",
          wordBreak: "break-all", textAlign: "right",
        }}>
          {value}
        </span>
      )}
    </div>
  );
}
