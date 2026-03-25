"use client";

import { useCallback, useState } from "react";

interface StratumLogoProps {
  size?: number;
  animate?: "revolve" | "none";
  showName?: boolean;
  onClick?: () => void;
}

export function StratumLogo({
  size = 48,
  animate = "none",
  showName = true,
  onClick,
}: StratumLogoProps) {
  const [revolving, setRevolving] = useState(false);

  const handleClick = useCallback(() => {
    if (animate === "revolve" && !revolving) {
      setRevolving(true);
      setTimeout(() => setRevolving(false), 420);
    }
    onClick?.();
  }, [animate, revolving, onClick]);

  const fontSize = size * 0.55;
  const nameFontSize = size * 0.38;

  return (
    <button
      className="forge-logo-btn"
      onClick={handleClick}
      aria-label="Forge — home"
      type="button"
      style={{ gap: showName ? "0.45rem" : 0 }}
    >
      <span
        className={`forge-logo-mark${revolving ? " revolving" : ""}`}
        style={{ fontSize }}
        aria-hidden="true"
      >
        ▲
      </span>
      {showName && (
        <span className="forge-logo-name" style={{ fontSize: nameFontSize }}>
          Forge
        </span>
      )}
    </button>
  );
}
