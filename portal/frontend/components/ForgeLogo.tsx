"use client";

import { useCallback, useId, useState } from "react";

interface ForgeLogoProps {
  size?: number;
  animate?: "revolve" | "none";
  showName?: boolean;
  color?: string;
  onClick?: () => void;
}

/**
 * Forge wordmark — no separate icon mark.
 *
 * F  — custom SVG letterform. Bold geometric with chamfered bar ends
 *      (45° cuts on the free tips of each bar) and a top-lit gradient.
 *      Reads as precision-engineered, not off-the-shelf.
 *
 * ⊙  — crosshair O. The unified data node: both clusters converge here.
 *      Circle outline + centre dot + four cardinal ticks.
 *
 * RGE — Inter Semibold, wide tracking, matching cap-height.
 */
export function ForgeLogo({
  size = 48,
  animate = "none",
  showName = true,
  color,
  onClick,
}: ForgeLogoProps) {
  const uid = useId();
  const gradId = `fg-f-grad-${uid.replace(/:/g, "")}`;
  const [animating, setAnimating] = useState(false);

  const handleClick = useCallback(() => {
    if (animate === "revolve" && !animating) {
      setAnimating(true);
      setTimeout(() => setAnimating(false), 420);
    }
    onClick?.();
  }, [animate, animating, onClick]);

  // capH is the visual reference height — every glyph renders at this height.
  // Inter's cap-height is ~0.728 of the em-square, so fontSize = capH / 0.728
  // to make the text cap-height match the SVG glyph height exactly.
  const capH     = size * 0.62;
  const fontSize = capH / 0.728;   // ≈ capH × 1.37 — text cap-height = capH

  return (
    <button
      className="forge-logo-btn"
      onClick={handleClick}
      aria-label="Forge — home"
      type="button"
      style={{
        gap: 0,
        alignItems: "center",
        display: "inline-flex",
        ...(color ? { color } : {}),
      }}
    >
      {showName && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: capH * 0.12,
          }}
        >

          {/* ── F — custom chamfered letterform ─────────────────────── */}
          <svg
            width={capH * 0.66}
            height={capH}
            viewBox="0 0 18 28"
            fill="none"
            aria-hidden="true"
            overflow="visible"
            className="forge-f"
          >
            <defs>
              {/* Top-lit gradient — polished forged steel */}
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="currentColor" stopOpacity="1"   />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.65"/>
              </linearGradient>
            </defs>
            {/*
              Bold F, 33% stroke weight.
              Bar ends have 45° chamfer cuts — a precision-cut letterform.

              Vertical:  x 0–6,  y 0–28
              Top bar:   x 0–17, y 0–7   — chamfer at top-right (17,0)→(18,2)
              Middle bar: x 0–13, y 12–19 — chamfer at top-right (13,12)→(14,14)
            */}
            <path
              d="
                M 0 0
                L 16 0
                L 18 2.5
                L 18 7
                L 6 7
                L 6 12
                L 12 12
                L 14 14.5
                L 14 19
                L 6 19
                L 6 28
                L 0 28
                Z
              "
              fill={`url(#${gradId})`}
            />
            {/* Subtle top-face highlight — catches the light */}
            <path
              d="M 0 0 L 16 0 L 18 2.5 L 18 3.5 L 0 3.5 Z"
              fill="currentColor"
              opacity="0.18"
            />
          </svg>

          {/* ── ⊙ — crosshair O ──────────────────────────────────────── */}
          {/*
            viewBox="0 0 22 22" — square, circle fills it exactly.
            This ensures the circle visual height = capH, matching the F.
            Circle r=10, centre (11,11). Ticks run from the edge inward.
          */}
          <svg
            width={capH}
            height={capH}
            viewBox="0 0 22 22"
            fill="none"
            aria-hidden="true"
            className={`forge-crosshair${animating ? " forge-crosshair-spin" : ""}`}
          >
            <circle cx="11" cy="11" r="9.5"
                    stroke="currentColor" strokeWidth="1.9"/>
            <circle cx="11" cy="11" r="2"
                    fill="currentColor"/>
            {/* Top tick */}
            <line x1="11" y1="1.5" x2="11" y2="5.5"
                  stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
            {/* Bottom tick */}
            <line x1="11" y1="16.5" x2="11" y2="20.5"
                  stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
            {/* Left tick */}
            <line x1="1.5" y1="11" x2="5.5" y2="11"
                  stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
            {/* Right tick */}
            <line x1="16.5" y1="11" x2="20.5" y2="11"
                  stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
          </svg>

          {/* ── RGE — slightly smaller than F⊙, balanced visual weight ── */}
          <span
            style={{
              fontSize: fontSize * 0.88,
              fontWeight: 700,
              fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
              color: "currentColor",
              lineHeight: 1,
            }}
          >
            RGE
          </span>

        </span>
      )}
    </button>
  );
}
