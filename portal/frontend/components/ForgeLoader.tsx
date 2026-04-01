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

        {/* Revolving ring + ticks */}
        <svg
          width={size}
          height={size}
          viewBox="0 0 100 100"
          fill="none"
          aria-hidden="true"
          className="forge-loader-ring"
          style={{ position: "absolute", inset: 0 }}
        >
          {/* Outer ring — drawn as two arcs so the gap between ticks is clear */}
          <circle
            cx="50" cy="50"
            r={43}
            stroke="var(--forge-primary)"
            strokeWidth={strokeW * (100 / size)}
            opacity="0.9"
          />
          {/* Top tick */}
          <line x1="50" y1="7"  x2="50" y2="20"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          {/* Bottom tick */}
          <line x1="50" y1="80" x2="50" y2="93"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          {/* Left tick */}
          <line x1="7"  y1="50" x2="20" y2="50"
            stroke="var(--forge-primary)" strokeWidth={strokeW * 1.1 * (100 / size)} strokeLinecap="round" />
          {/* Right tick */}
          <line x1="80" y1="50" x2="93" y2="50"
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
