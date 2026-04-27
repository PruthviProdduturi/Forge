"use client";

import { useCallback, useId, useState } from "react";

export type FoundryMark  = "crosshair" | "gear" | "hex" | "flame";
export type FoundryNMark = "none" | "node";
export type FoundryRMark = "none" | "route";

interface FoundryLogoProps {
  size?: number;
  animate?: "revolve" | "none";
  showName?: boolean;
  color?: string;
  /** O mark variant */
  mark?: FoundryMark;
  /** N mark variant */
  nMark?: FoundryNMark;
  /** R mark variant */
  rMark?: FoundryRMark;
  onClick?: () => void;
}

/**
 * Foundry wordmark  —  F  ⊙  U  [N]  D  [R]  Y
 *
 * mark="crosshair" — ⊙  crosshair O, spins on click
 * mark="gear"      — ⚙  8-tooth gear, spins on click
 * mark="hex"       — ⬡  hex mold cavity, spins on click
 * mark="flame"     — 🔥 stylised flame, pulses on click
 *
 * nMark="node"     — N drawn as 4-node network graph, spins on click
 * rMark="route"    — R drawn as stem + arch + arrow leg, pulses on click
 */
export function FoundryLogo({
  size     = 48,
  animate  = "none",
  showName = true,
  color,
  mark     = "crosshair",
  nMark    = "none",
  rMark    = "none",
  onClick,
}: FoundryLogoProps) {
  const uid    = useId();
  const gradId = `fy-f-${uid.replace(/:/g, "")}`;
  const [animating, setAnimating] = useState(false);

  const handleClick = useCallback(() => {
    if (animate === "revolve" && !animating) {
      setAnimating(true);
      setTimeout(() => setAnimating(false), 440);
    }
    onClick?.();
  }, [animate, animating, onClick]);

  const capH     = size * 0.62;
  const fontSize = capH / 0.728;
  const textStyle = {
    fontSize:   fontSize * 0.88,
    fontWeight: 700 as const,
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    color:      "currentColor" as const,
    lineHeight: 1,
  };

  const isFlame   = mark === "flame";
  const oClass    = isFlame
    ? `foundry-mark${animating ? " foundry-flame-pulse" : ""}`
    : `forge-crosshair${animating ? " forge-crosshair-spin" : ""}`;
  const nClass    = `forge-crosshair${animating ? " forge-crosshair-spin" : ""}`;
  const rClass    = `foundry-mark${animating ? " foundry-flame-pulse" : ""}`;

  return (
    <button
      className="forge-logo-btn"
      onClick={handleClick}
      aria-label="Foundry — home"
      type="button"
      style={{ gap: 0, alignItems: "center", display: "inline-flex", ...(color ? { color } : {}) }}
    >
      {showName && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: capH * 0.12 }}>

          {/* ── F — chamfered letterform ─────────────────────────────── */}
          <svg width={capH * 0.66} height={capH} viewBox="0 0 18 28"
            fill="none" aria-hidden="true" overflow="visible" className="forge-f">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="currentColor" stopOpacity="1"    />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.65" />
              </linearGradient>
            </defs>
            <path d="M 0 0 L 16 0 L 18 2.5 L 18 7 L 6 7 L 6 12 L 12 12 L 14 14.5 L 14 19 L 6 19 L 6 28 L 0 28 Z"
              fill={`url(#${gradId})`} />
            <path d="M 0 0 L 16 0 L 18 2.5 L 18 3.5 L 0 3.5 Z"
              fill="currentColor" opacity="0.18" />
          </svg>

          {/* ── O mark ───────────────────────────────────────────────── */}
          <svg width={capH} height={capH} viewBox="0 0 22 22"
            fill="none" aria-hidden="true" className={oClass} style={{ overflow: "visible" }}>
            {mark === "crosshair" && <>
              <circle cx="11" cy="11" r="9.5" stroke="currentColor" strokeWidth="1.9" />
              <circle cx="11" cy="11" r="2" fill="currentColor" />
              <line x1="11" y1="1.5"  x2="11" y2="5.5"  stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <line x1="11" y1="16.5" x2="11" y2="20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <line x1="1.5"  y1="11" x2="5.5"  y2="11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <line x1="16.5" y1="11" x2="20.5" y2="11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </>}
            {mark === "gear" && <>
              <path fillRule="evenodd" fill="currentColor" d="
                M 9.14 4.04  L 9.84 1.57  L 12.16 1.57 L 12.86 4.04
                L 14.6  4.77 L 16.85 3.51 L 18.49 5.15 L 17.23 7.4
                L 17.96 9.14 L 20.43 9.84 L 20.43 12.16 L 17.96 12.86
                L 17.23 14.6 L 18.49 16.85 L 16.85 18.49 L 14.6 17.23
                L 12.86 17.96 L 12.16 20.43 L 9.84 20.43 L 9.14 17.96
                L 7.4  17.23 L 5.15 18.49 L 3.51 16.85 L 4.77 14.6
                L 4.04 12.86 L 1.57 12.16 L 1.57 9.84  L 4.04 9.14
                L 4.77 7.4   L 3.51 5.15  L 5.15 3.51  L 7.4  4.77 Z
                M 13.5 11 A 2.5 2.5 0 1 1 8.5 11 A 2.5 2.5 0 1 1 13.5 11 Z" />
            </>}
            {mark === "hex" && <>
              <polygon points="11,1.5 19.7,6.25 19.7,15.75 11,20.5 2.3,15.75 2.3,6.25"
                stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" fill="none" />
              <circle cx="11" cy="11" r="2" fill="currentColor" />
            </>}
            {mark === "flame" && <>
              <path fill="currentColor" d="
                M 11 1.5
                C 17.5 6.5, 18.5 14.5, 14.5 17.5
                C 16.5 14.5, 14.0 11.5, 11 15.5
                C 8.0  11.5,  5.5 14.5,  7.5 17.5
                C 3.5  14.5,  4.5  6.5, 11 1.5 Z" />
              <ellipse cx="11" cy="13.5" rx="2" ry="2.8" fill="currentColor" opacity="0.28" />
            </>}
          </svg>

          {/* ── U ────────────────────────────────────────────────────── */}
          <span style={textStyle}>U</span>

          {/* ── N mark or plain N ─────────────────────────────────────── */}
          {nMark === "node" ? (
            /*
              N as network graph — N-shaped strokes with proper ring+dot nodes.
              viewBox 0 0 16 22. Nodes drawn last so they sit on top of lines.
              Each node: outer ring (stroke-only circle) + inner filled dot —
              matches the visual language of real network/graph diagrams.
              Spins on click.
            */
            <svg width={capH * (16/22)} height={capH} viewBox="0 0 16 22"
              fill="none" aria-hidden="true" className={nClass} style={{ overflow: "visible" }}>
              {/* Strokes — drawn first, nodes sit on top */}
              <line x1="3" y1="4"  x2="3"  y2="18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="13" y1="4" x2="13" y2="18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="3" y1="4"  x2="13" y2="18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              {/* Nodes: outer ring + inner dot (×4 corners) */}
              {([[ 3, 4], [13, 4], [3, 18], [13, 18]] as [number,number][]).map(([cx, cy], i) => (
                <g key={i}>
                  <circle cx={cx} cy={cy} r="3.2" stroke="currentColor" strokeWidth="1.3" fill="none" opacity="0.55" />
                  <circle cx={cx} cy={cy} r="1.4" fill="currentColor" />
                </g>
              ))}
            </svg>
          ) : (
            <span style={textStyle}>N</span>
          )}

          {/* ── D ────────────────────────────────────────────────────── */}
          <span style={textStyle}>D</span>

          {/* ── R mark or plain R ─────────────────────────────────────── */}
          {rMark === "route" ? (
            /*
              R as route mark — stroke-only letterform: stem + arch + arrow leg.
              viewBox 0 0 14 22: stem at x=2, arch from (2,2) curving to (12,6) back to (2,10),
              leg from (2,10) to (12,20) with a two-stroke arrowhead.
              Pulses on click (doesn't spin — spinning an R letterform looks wrong).
            */
            <svg width={capH * (14/22)} height={capH} viewBox="0 0 14 22"
              fill="none" aria-hidden="true" className={rClass} style={{ overflow: "visible" }}>
              {/* Stem */}
              <line x1="2" y1="2" x2="2" y2="20"
                stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
              {/* Arch */}
              <path d="M 2 2 C 13 2, 13 10, 2 10"
                stroke="currentColor" strokeWidth="2.1" fill="none" strokeLinecap="round" />
              {/* Leg */}
              <line x1="2" y1="10" x2="12" y2="20"
                stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
              {/* Arrowhead — two strokes back from tip */}
              <line x1="12" y1="20" x2="8"  y2="18"
                stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <line x1="12" y1="20" x2="10" y2="16"
                stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          ) : (
            <span style={textStyle}>R</span>
          )}

          {/* ── Y ────────────────────────────────────────────────────── */}
          <span style={textStyle}>Y</span>

        </span>
      )}
    </button>
  );
}
