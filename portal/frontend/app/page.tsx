"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useTheme } from "../contexts/ThemeContext";
import { apiFetch } from "../utils/api";

const NAV_CARDS = [
  { href: "/pipelines",    icon: "fa-sitemap",      label: "Pipelines",     description: "Browse, monitor and trigger your data pipelines" },
  { href: "/datasets",     icon: "fa-database",     label: "Datasets",      description: "Explore bronze, silver and gold layer datasets" },
  { href: "/lineage",      icon: "fa-share-nodes",  label: "Lineage",       description: "Column-level lineage and upstream impact analysis" },
  { href: "/dq",           icon: "fa-shield-halved",label: "Data Quality",  description: "DQ rules, scores and CRITICAL gate status" },
  { href: "/cost",         icon: "fa-coins",        label: "Cost",          description: "Pipeline compute cost tracking and attribution" },
  { href: "/observability",icon: "fa-chart-line",   label: "Observability", description: "Cluster health, metrics and log explorer" },
];

interface HealthData {
  status: string;
  // true = healthy, false = unreachable, null = cluster-internal (only works in-pod)
  checks: {
    airflow: boolean | null;
    trino: boolean | null;
    spark_connect: boolean | null;
    adls: boolean | null;
  };
}

interface StatusBadge {
  label: string;
  icon: string;
  ok: boolean | null;
}

function getGreeting(name: string): { salutation: string; sub: string } {
  const h = new Date().getHours();
  const first = name.split(" ")[0];
  const salutation =
    h < 12 ? `Good morning, ${first}`
    : h < 17 ? `Good afternoon, ${first}`
    : `Good evening, ${first}`;
  const sub =
    h < 12
      ? "Let's see what your pipelines have been up to overnight."
      : h < 17
      ? "Here's a snapshot of your platform."
      : "Wrapping up for the day? Here's your platform status.";
  return { salutation, sub };
}

function StatusDot({ ok, loading }: { ok: boolean | null; loading: boolean }) {
  const color = loading ? "#94a3b8" : ok === true ? "#059669" : ok === false ? "#ef4444" : "#cbd5e1";
  const glow = !loading && ok !== null;
  return (
    <span style={{
      width: 7, height: 7, borderRadius: "50%",
      background: color, flexShrink: 0, display: "inline-block",
      boxShadow: glow ? `0 0 0 3px ${color}25` : "none",
    }} />
  );
}

export default function HomePage() {
  const { user, role, getToken } = useAuth();
  const { primaryColor } = useTheme();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    apiFetch<HealthData>("/api/health", getToken)
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setHealthLoading(false));
  }, [getToken]);

  const { salutation, sub } = getGreeting(user?.name ?? "there");

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Compute = healthy if either Trino or Spark is up; null only when both are null
  const computeOk: boolean | null = !health ? null
    : health.checks.trino === true || health.checks.spark_connect === true ? true
    : health.checks.trino === false || health.checks.spark_connect === false ? false
    : null;

  const badges: StatusBadge[] = [
    { label: "Compute Cluster", icon: "fa-bolt",               ok: computeOk },
    { label: "Orchestration",   icon: "fa-calendar-check",     ok: health?.checks.airflow    ?? null },
    { label: "Trino",           icon: "fa-database",           ok: health?.checks.trino      ?? null },
    { label: "Spark Connect",   icon: "fa-fire-flame-curved",  ok: health?.checks.spark_connect ?? null },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "transparent" }}>

      {/* ── Hero greeting ──────────────────────────────────────────────── */}
      <div
        style={{
          background: `linear-gradient(135deg, ${primaryColor} 0%, #0f1e2e 100%)`,
          padding: "56px 1.5rem 52px",
        }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{
            fontSize: 12, fontWeight: 600, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "rgba(255,255,255,0.5)",
            marginBottom: 10,
          }}>
            {today}
          </div>
          <h1
            style={{
              fontSize: "clamp(1.8rem, 4vw, 2.8rem)",
              fontWeight: 800,
              color: "#fff",
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
              marginBottom: 10,
            }}
          >
            {salutation}
          </h1>
          <p style={{ fontSize: "1rem", color: "rgba(255,255,255,0.7)", maxWidth: 520, lineHeight: 1.6, margin: 0 }}>
            {sub}
          </p>

          {role && (
            <div
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                marginTop: 20, padding: "5px 12px", borderRadius: 20,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.2)",
                fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.85)",
              }}
            >
              <i className="fas fa-shield-halved" style={{ fontSize: 10 }} />
              {role}
            </div>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 1.5rem 60px" }}>

        {/* ── Platform status ─────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 40, justifyContent: "center" }}>
          {badges.map(s => {
            const color = healthLoading ? "#94a3b8"
              : s.ok === true ? "#059669"
              : s.ok === false ? "#ef4444"
              : "#94a3b8";
            const statusLabel = healthLoading ? "Checking…"
              : s.ok === true ? "Healthy"
              : s.ok === false ? "Unreachable"
              : "In cluster";
            return (
              <div
                key={s.label}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 18px", borderRadius: 10,
                  background: "#fff", border: "1px solid #e2e8f0",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)", fontSize: 13,
                }}
              >
                <StatusDot ok={s.ok} loading={healthLoading} />
                <i className={`fas ${s.icon}`} style={{ color: "#94a3b8", fontSize: 11 }} />
                <span style={{ fontWeight: 700, color: "#334155" }}>{s.label}</span>
                <span style={{ color, fontWeight: 600, fontSize: 12, marginLeft: 4 }}>{statusLabel}</span>
              </div>
            );
          })}
        </div>

        {/* ── Quick launch ────────────────────────────────────────────── */}
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: "0.09em",
          textTransform: "uppercase", color: "#94a3b8", marginBottom: 16,
        }}>
          Quick launch
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}>
          {NAV_CARDS.map(card => (
            <Link key={card.href} href={card.href} style={{ textDecoration: "none" }}>
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  borderTop: "3px solid var(--forge-primary)",
                  borderRadius: 12,
                  padding: "20px 22px",
                  cursor: "pointer",
                  transition: "box-shadow 0.15s ease, transform 0.15s ease",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = "0 6px 20px rgba(var(--forge-primary-rgb),0.15)";
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 4px rgba(0,0,0,0.05)";
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 9,
                    background: "rgba(var(--forge-primary-rgb), 0.08)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    <i className={`fas ${card.icon}`} style={{ color: "var(--forge-primary)", fontSize: 15 }} />
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{card.label}</span>
                  <i className="fas fa-arrow-right" style={{ color: "#cbd5e1", fontSize: 11, marginLeft: "auto" }} />
                </div>
                <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.5, margin: 0 }}>
                  {card.description}
                </p>
              </div>
            </Link>
          ))}
        </div>


      </div>
    </div>
  );
}
