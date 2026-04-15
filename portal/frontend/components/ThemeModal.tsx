"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme, DEFAULT_THEME_COLOR } from "../contexts/ThemeContext";

// ── Color math ────────────────────────────────────────────────────────────────

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function hexToHsv(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function isValidHex(v: string) { return /^#[0-9a-fA-F]{6}$/.test(v); }

// ── Picker ────────────────────────────────────────────────────────────────────

interface ThemeModalProps { onClose: () => void; }

export function ThemeModal({ onClose }: ThemeModalProps) {
  const { primaryColor, saveTheme, resetTheme } = useTheme();

  const initHsv = isValidHex(primaryColor) ? hexToHsv(primaryColor) : [210, 1, 0.83];
  const [hue, setHue] = useState(initHsv[0]);
  const [sat, setSat] = useState(initHsv[1]);
  const [val, setVal] = useState(initHsv[2]);
  const [hexInput, setHexInput] = useState(primaryColor);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const hueRef   = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Derived hex
  const [r, g, b] = hsvToRgb(hue, sat, val);
  const currentHex = rgbToHex(r, g, b);
  const hueColor   = rgbToHex(...hsvToRgb(hue, 1, 1));

  // Sync hex input when picker changes
  useEffect(() => { setHexInput(currentHex); }, [currentHex]);

  // ── Gradient canvas drag ────────────────────────────────────────────────────
  const draggingCanvas = useRef(false);

  const handleCanvasPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
    setSat(x);
    setVal(1 - y);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!draggingCanvas.current || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      setSat(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
      setVal(Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)));
    };
    const up = () => { draggingCanvas.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  // ── Hue slider drag ────────────────────────────────────────────────────────
  const draggingHue = useRef(false);

  const handleHuePointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = hueRef.current!.getBoundingClientRect();
    setHue(Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360)));
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!draggingHue.current || !hueRef.current) return;
      const rect = hueRef.current.getBoundingClientRect();
      setHue(Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360)));
    };
    const up = () => { draggingHue.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  // ── Hex input ─────────────────────────────────────────────────────────────
  const handleHexChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setHexInput(v);
    if (isValidHex(v)) {
      const [h, s, vv] = hexToHsv(v);
      setHue(h); setSat(s); setVal(vv);
    }
  }, []);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    setSaving(true);
    try { await saveTheme(currentHex); }
    finally { setSaving(false); onClose(); }
  }, [currentHex, saveTheme, onClose]);

  // ── Reset to default ──────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await resetTheme();
      const [h, s, v] = hexToHsv(DEFAULT_THEME_COLOR);
      setHue(h); setSat(s); setVal(v);
    } finally {
      setResetting(false);
      onClose();
    }
  }, [resetTheme, onClose]);

  // ── Close ─────────────────────────────────────────────────────────────────
  const handleOverlayClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}
      role="dialog" aria-modal="true" aria-label="Theme settings">
      <div className="modal-box" style={{ width: 320 }}>

        <div className="modal-header">
          <span className="modal-title">
            <i className="fas fa-palette" style={{ marginRight: 8, opacity: 0.7 }} />
            Theme Color
          </span>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">
            <i className="fas fa-times" />
          </button>
        </div>

        {/* ── Saturation/Value canvas ── */}
        <div
          ref={canvasRef}
          onPointerDown={(e) => { draggingCanvas.current = true; e.currentTarget.setPointerCapture(e.pointerId); handleCanvasPointer(e); }}
          onPointerMove={(e) => { if (draggingCanvas.current) handleCanvasPointer(e); }}
          style={{
            width: "100%", height: 180, borderRadius: 10,
            position: "relative", cursor: "crosshair", userSelect: "none",
            background: hueColor,
            marginBottom: 12,
          }}
        >
          {/* white-to-transparent left-to-right */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10,
            background: "linear-gradient(to right, #fff, transparent)",
          }} />
          {/* transparent-to-black top-to-bottom */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10,
            background: "linear-gradient(to bottom, transparent, #000)",
          }} />
          {/* cursor */}
          <div style={{
            position: "absolute",
            left: `${sat * 100}%`,
            top:  `${(1 - val) * 100}%`,
            transform: "translate(-50%, -50%)",
            width: 14, height: 14, borderRadius: "50%",
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
            background: currentHex,
            pointerEvents: "none",
          }} />
        </div>

        {/* ── Hue slider ── */}
        <div
          ref={hueRef}
          onPointerDown={(e) => { draggingHue.current = true; e.currentTarget.setPointerCapture(e.pointerId); handleHuePointer(e); }}
          onPointerMove={(e) => { if (draggingHue.current) handleHuePointer(e); }}
          style={{
            width: "100%", height: 14, borderRadius: 7,
            position: "relative", cursor: "ew-resize", userSelect: "none",
            background: "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)",
            marginBottom: 16,
          }}
        >
          <div style={{
            position: "absolute",
            left: `${(hue / 360) * 100}%`,
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 18, height: 18, borderRadius: "50%",
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.3)",
            background: hueColor,
            pointerEvents: "none",
          }} />
        </div>

        {/* ── Preview + hex ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 8,
            background: currentHex,
            border: "2px solid #e2e8f0",
            flexShrink: 0,
          }} />
          <input
            type="text"
            className="color-hex-input"
            value={hexInput}
            onChange={handleHexChange}
            maxLength={7}
            placeholder="#0078d4"
            spellCheck={false}
            aria-label="Hex color value"
            style={{ flex: 1 }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <button
            className="modal-save-btn"
            onClick={handleSave}
            disabled={saving || resetting}
            type="button"
            style={{ flex: 1, width: "auto" }}
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
          <button
            onClick={handleReset}
            disabled={saving || resetting}
            type="button"
            title="Reset to default colour"
            style={{
              padding: "0 14px", borderRadius: 8,
              border: "1px solid #e2e8f0", background: "#f8fafc",
              color: "#64748b", fontSize: 12, fontWeight: 600,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            {resetting ? (
              <span style={{
                width: 12, height: 12,
                border: "2px solid #cbd5e1", borderTopColor: "#64748b",
                borderRadius: "50%", animation: "spin 0.7s linear infinite",
                display: "inline-block",
              }} />
            ) : (
              <i className="fas fa-rotate-left" style={{ fontSize: 11 }} />
            )}
            Reset
          </button>
        </div>

      </div>
    </div>
  );
}
