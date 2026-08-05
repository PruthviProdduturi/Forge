"use client";

import { useState, useEffect } from "react";

interface ForgeLoaderProps {
  text?: string;
  size?: number;
  fullscreen?: boolean;
}

export function ForgeLoader({
  text = "Loading",
  size = 56,
  fullscreen = true,
}: ForgeLoaderProps) {
  const [dots, setDots] = useState("");

  useEffect(() => {
    if (!fullscreen) return;
    const interval = setInterval(() => {
      setDots((prev) => (prev === "..." ? "" : prev + "."));
    }, 500);
    return () => clearInterval(interval);
  }, [fullscreen]);

  const pr = (opacity: number) =>
    `rgba(var(--forge-primary-rgb, 30,58,95), ${opacity})`;
  const sr = (opacity: number) =>
    `rgba(var(--forge-secondary-rgb, 62,99,147), ${opacity})`;
  const ar = (opacity: number) =>
    `rgba(var(--forge-accent-rgb, 94,140,199), ${opacity})`;

  const primary = "var(--forge-primary, #1e3a5f)";
  const secondary = "var(--forge-secondary, #3e6393)";
  const accent = "var(--forge-accent, #5e8cc7)";

  // Inline loader for non-fullscreen use
  if (!fullscreen) {
    const strokeW = size * 0.085;
    return (
      <div className="forge-loader-inner" suppressHydrationWarning>
        <div
          className="forge-loader-mark"
          style={{ width: size, height: size }}
        >
          <svg
            width={size}
            height={size}
            viewBox="0 0 100 100"
            fill="none"
            aria-hidden="true"
            className="forge-loader-ring"
            style={{ position: "absolute", inset: 0 }}
          >
            <circle
              cx="50"
              cy="50"
              r={43}
              stroke={primary}
              strokeWidth={strokeW * (100 / size)}
              opacity="0.9"
            />
            <path
              d="M 60.7 35.5 L 43.8 31.9 L 32.2 45.6 L 37.3 60.8 L 54.2 64.4 L 65.8 50.7 Z"
              opacity="0.1"
              fill={primary}
            />
            {[
              [60.7, 35.5, 50, 7],
              [43.8, 31.9, 14, 25],
              [32.2, 45.6, 14, 75],
              [37.3, 60.8, 50, 93],
              [54.2, 64.4, 86, 75],
              [65.8, 50.7, 86, 25],
            ].map(([x1, y1, x2, y2], i) => (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={primary}
                strokeWidth={strokeW * 1.1 * (100 / size)}
                strokeLinecap="round"
              />
            ))}
          </svg>
        </div>
        <div className="forge-loader-bar" aria-hidden="true" />
        {text && <span className="forge-loader-text">{text}</span>}
      </div>
    );
  }

  // Fullscreen cinematic loader
  return (
    <div
      className="forge-loader-screen"
      role="status"
      aria-label={text}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
        zIndex: 9999,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 60,
          width: "100%",
          maxWidth: 500,
          padding: 20,
        }}
      >
        {/* Animated rings */}
        <div
          style={{
            position: "relative",
            width: 280,
            height: 280,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {/* Outer glow */}
          <div
            style={{
              position: "absolute",
              inset: -20,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${pr(0.15)} 0%, transparent 70%)`,
              animation: "forge-pulse-glow 3s ease-in-out infinite",
            }}
          />

          {/* Ring 1 — spinning gradient */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background: `conic-gradient(from 0deg, transparent 0deg, transparent 240deg, ${secondary} 270deg, ${primary} 300deg, transparent 330deg, transparent 360deg)`,
              animation: "forge-spin 3s linear infinite",
              filter: "blur(2px)",
              opacity: 0.8,
            }}
          />

          {/* Ring 2 — counter-clockwise */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              margin: 20,
              borderRadius: "50%",
              background: `conic-gradient(from 180deg, transparent 0deg, transparent 240deg, ${primary} 270deg, ${secondary} 300deg, transparent 330deg, transparent 360deg)`,
              animation: "forge-spin-reverse 4s linear infinite",
              filter: "blur(2px)",
              opacity: 0.7,
            }}
          />

          {/* Inner ring — pulsing */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              margin: 40,
              borderRadius: "50%",
              border: `2px solid ${secondary}`,
              animation: "forge-pulse-ring 2s ease-in-out infinite",
              boxShadow: `0 0 20px ${sr(0.4)}, inset 0 0 20px ${sr(0.2)}`,
            }}
          />

          {/* Particle ring */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              margin: 60,
              borderRadius: "50%",
              border: `1px solid ${ar(0.3)}`,
              boxShadow: `0 0 10px ${ar(0.2)}`,
            }}
          />

          {/* Center glass */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              margin: 70,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, rgba(30,41,59,0.6) 0%, rgba(15,23,42,0.8) 100%)",
              boxShadow: `0 0 60px ${pr(0.4)}, 0 0 100px ${sr(0.2)}, inset 0 0 30px ${pr(0.15)}`,
              backdropFilter: "blur(40px)",
              border: `1px solid ${pr(0.3)}`,
              animation: "forge-pulse-center 3s ease-in-out infinite",
            }}
          />

          {/* FORGE wordmark in center */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
              filter: `drop-shadow(0 0 20px ${ar(0.4)}) drop-shadow(0 0 40px ${pr(0.3)})`,
            }}
          >
            <span
              style={{
                fontSize: 44,
                fontWeight: 800,
                letterSpacing: "0.12em",
                fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
                lineHeight: 1,
                backgroundImage: `linear-gradient(180deg, ${primary} 0%, ${secondary} 100%)`,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                WebkitTextFillColor: "transparent",
                color: primary,
              }}
            >
              FORGE
            </span>
          </div>

          {/* Orbiting dots */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              animation: "forge-spin 4s linear infinite",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: -6,
                left: "50%",
                width: 12,
                height: 12,
                marginLeft: -6,
                background: `radial-gradient(circle, ${accent} 0%, ${secondary} 100%)`,
                borderRadius: "50%",
                boxShadow: `0 0 20px ${accent}, 0 0 40px ${ar(0.5)}`,
                animation: "forge-pulse-dot 2s ease-in-out infinite",
              }}
            />
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              margin: 20,
              animation: "forge-spin-reverse 5s linear infinite",
            }}
          >
            <div
              style={{
                position: "absolute",
                bottom: -6,
                left: "50%",
                width: 12,
                height: 12,
                marginLeft: -6,
                background: `radial-gradient(circle, ${secondary} 0%, ${primary} 100%)`,
                borderRadius: "50%",
                boxShadow: `0 0 20px ${secondary}, 0 0 40px ${sr(0.5)}`,
                animation: "forge-pulse-dot 2.5s ease-in-out infinite",
              }}
            />
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              margin: 40,
              animation: "forge-spin 6s linear infinite",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: "50%",
                right: -6,
                width: 12,
                height: 12,
                marginTop: -6,
                background: `radial-gradient(circle, ${accent} 0%, ${secondary} 100%)`,
                borderRadius: "50%",
                boxShadow: `0 0 20px ${accent}, 0 0 40px ${ar(0.5)}`,
                animation: "forge-pulse-dot 3s ease-in-out infinite",
              }}
            />
          </div>
        </div>

        {/* Text + progress bar */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 32,
            width: "100%",
          }}
        >
          <h2
            style={{
              fontSize: 24,
              fontWeight: 300,
              letterSpacing: "0.2em",
              color: "rgba(255,255,255,0.9)",
              textTransform: "uppercase",
              margin: 0,
              minWidth: 240,
              height: 32,
              lineHeight: "32px",
              textAlign: "center",
              textShadow: "0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            {text}
            {dots}
          </h2>

          <div
            style={{
              width: 384,
              maxWidth: "100%",
              height: 6,
              backgroundColor: "rgba(255,255,255,0.1)",
              borderRadius: 9999,
              overflow: "hidden",
              position: "relative",
              boxShadow: "inset 0 1px 3px rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <div
              style={{
                position: "absolute",
                height: "100%",
                width: "60%",
                background: `linear-gradient(90deg, transparent 0%, ${accent} 20%, ${secondary} 50%, ${accent} 80%, transparent 100%)`,
                animation: "forge-slide 2s ease-in-out infinite",
                boxShadow: `0 0 20px ${sr(0.6)}`,
                filter: "blur(1px)",
              }}
            />
            <div
              style={{
                position: "absolute",
                height: "100%",
                width: "40%",
                background: `linear-gradient(90deg, transparent 0%, ${secondary} 50%, transparent 100%)`,
                animation: "forge-slide 2s ease-in-out infinite",
              }}
            />
          </div>
        </div>
      </div>

      <style>{`
        @keyframes forge-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes forge-spin-reverse { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
        @keyframes forge-pulse-ring { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.08); } }
        @keyframes forge-pulse-glow { 0%, 100% { opacity: 0.4; transform: scale(1); } 50% { opacity: 0.8; transform: scale(1.1); } }
        @keyframes forge-pulse-center { 0%, 100% { transform: scale(1); opacity: 0.95; } 50% { transform: scale(1.03); opacity: 1; } }
        @keyframes forge-pulse-dot { 0%, 100% { opacity: 0.6; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.15); } }
        @keyframes forge-slide { 0% { transform: translateX(-100%); opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { transform: translateX(240%); opacity: 0; } }
      `}</style>
    </div>
  );
}
