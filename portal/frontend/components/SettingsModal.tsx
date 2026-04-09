"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";

interface PlatformInfo {
  env: string;
  platform: {
    airflow_host: string;
    trino_host: string;
    adls_account: string;
    purview_endpoint: string;
    resource_group: string;
    subscription_id: string;
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
  const [tab, setTab] = useState<Tab>("appearance");
  const [localColor, setLocalColor] = useState(primaryColor);
  const [hexInput, setHexInput] = useState(primaryColor);
  const [saving, setSaving] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

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

  const p = platformInfo?.platform;
  const subId = p?.subscription_id;

  const trinoUrl = p?.trino_host ? `https://${p.trino_host}` : null;
  const adlsUrl = subId && p?.adls_account && p?.resource_group
    ? `https://portal.azure.com/#resource/subscriptions/${subId}/resourceGroups/${p.resource_group}/providers/Microsoft.Storage/storageAccounts/${p.adls_account}/overview`
    : null;
  const purviewUrl = p?.purview_endpoint || null;
  const rgUrl = subId && p?.resource_group
    ? `https://portal.azure.com/#resource/subscriptions/${subId}/resourceGroups/${p.resource_group}/overview`
    : null;

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
            {platformInfo ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8", marginBottom: 8 }}>
                  Connection
                </div>
                <PlatformRow label="Environment" value={(platformInfo.env ?? "dev").toUpperCase()} highlight={platformInfo.env === "prod" ? "red" : "green"} />
                <PlatformRow label="Airflow" value={p?.airflow_host ?? "—"} mono />
                <PlatformRow label="Trino" value={p?.trino_host ?? "—"} mono href={trinoUrl ?? undefined} />
                <PlatformRow label="ADLS" value={p?.adls_account ?? "—"} mono href={adlsUrl ?? undefined} />
                <PlatformRow label="Purview" value={(p?.purview_endpoint ?? "").replace("https://", "") || "—"} mono href={purviewUrl ?? undefined} />
                <PlatformRow label="Resource Group" value={p?.resource_group ?? "—"} href={rgUrl ?? undefined} />
              </div>
            ) : (
              <div style={{ color: "#94a3b8", fontSize: 12 }}>
                <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading…
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
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: "red" | "green";
  href?: string;
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
          background: highlight === "red" ? "#fee2e2" : "#dcfce7",
          color: highlight === "red" ? "#dc2626" : "#16a34a",
        }}>
          {value}
        </span>
      ) : href && value !== "—" ? (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{
          fontSize: 12, fontWeight: 500, color: "#0284c7",
          fontFamily: mono ? "monospace" : "inherit",
          wordBreak: "break-all", textAlign: "right",
          textDecoration: "none", display: "flex", alignItems: "center", gap: 4,
        }}>
          {value}
          <i className="fas fa-arrow-up-right-from-square" style={{ fontSize: 9, opacity: 0.7, flexShrink: 0 }} />
        </a>
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
