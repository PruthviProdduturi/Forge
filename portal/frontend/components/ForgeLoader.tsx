"use client";

interface ForgeLoaderProps {
  text?: string;
  size?: number;
  fullscreen?: boolean;
}

/**
 * Full-screen (or inline) loading state using the Forge crosshair ⊙ mark.
 * The outer ring + ticks revolve continuously; the centre dot is fixed.
 * This gives a "targeting lock acquiring" feel that matches the logo's identity.
 */
export function ForgeLoader({
  text = "Connecting to Forge…",
  size = 56,
  fullscreen = true,
}: ForgeLoaderProps) {
  const r = size / 2;
  const strokeW = size * 0.085;
  const tickLen = size * 0.18;
  const dotR   = size * 0.09;

  const content = (
    <div className="forge-loader-inner" suppressHydrationWarning>
      <div className="forge-loader-mark" style={{ width: size, height: size }}>
        {/* Static centre dot */}
        <svg
          width={size}
          height={size}
          viewBox="0 0 100 100"
          fill="none"
          aria-hidden="true"
          style={{ position: "absolute", inset: 0 }}
        >
          <circle cx="50" cy="50" r={dotR * (100 / size)} fill="var(--forge-primary)" />
        </svg>

        {/* Revolving ring + hexagonal ticks */}
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
            cx="50" cy="50"
            r={43}
            stroke="var(--forge-primary)"
            strokeWidth={strokeW * (100 / size)}
            opacity="0.9"
          />
          {/* Inner hexagon */}
          <path
            d="M 60.7 35.5 L 43.8 31.9 L 32.2 45.6 L 37.3 60.8 L 54.2 64.4 L 65.8 50.7 Z"
            opacity="0.1"
            fill="var(--forge-primary)"
          />
          {/* 6 radial ticks */}
          <line x1="60.7" y1="35.5" x2="50" y2="7"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          <line x1="43.8" y1="31.9" x2="14" y2="25"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          <line x1="32.2" y1="45.6" x2="14" y2="75"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          <line x1="37.3" y1="60.8" x2="50" y2="93"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          <line x1="54.2" y1="64.4" x2="86" y2="75"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          <line x1="65.8" y1="50.7" x2="86" y2="25"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
        </svg>
      </div>

      <div className="forge-loader-bar" aria-hidden="true" />
      {text && <span className="forge-loader-text">{text}</span>}
    </div>
  );

  if (!fullscreen) return content;

  return (
    <div className="forge-loader-screen" role="status" aria-label={text}>
      {content}
    </div>
  );
}
