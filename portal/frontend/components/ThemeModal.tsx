"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";

const PRESET_COLORS = [
  "#1e3a5f", "#0078d4", "#107c10", "#d83b01",
  "#5c2d91", "#008272", "#004b1c", "#32145a",
  "#004e8c", "#8764b8", "#0099bc", "#e3008c",
];

interface ThemeModalProps {
  onClose: () => void;
}

export function ThemeModal({ onClose }: ThemeModalProps) {
  const { primaryColor, saveTheme } = useTheme();
  const [localColor, setLocalColor] = useState(primaryColor);
  const [hexInput, setHexInput] = useState(primaryColor);
  const [saving, setSaving] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalColor(primaryColor);
    setHexInput(primaryColor);
  }, [primaryColor]);

  const applyColor = useCallback((color: string) => {
    setLocalColor(color);
    setHexInput(color);
  }, []);

  const handleHexChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setHexInput(val);
    if (/^#[0-9a-fA-F]{6}$/.test(val)) setLocalColor(val);
  }, []);

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

  const handleOverlayClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
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
      aria-label="Theme settings"
    >
      <div className="modal-box">
        <div className="modal-header">
          <span className="modal-title">
            <i className="fas fa-palette" style={{ marginRight: 8, opacity: 0.7 }} />
            Theme Color
          </span>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">
            <i className="fas fa-times" />
          </button>
        </div>

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
              <span style={{
                width: 14, height: 14,
                border: "2px solid rgba(255,255,255,0.4)",
                borderTopColor: "#fff", borderRadius: "50%",
                animation: "spin 0.7s linear infinite",
                display: "inline-block",
              }} />
              Saving…
            </>
          ) : (
            <>
              <i className="fas fa-check" />
              Apply Theme
            </>
          )}
        </button>
      </div>
    </div>
  );
}
