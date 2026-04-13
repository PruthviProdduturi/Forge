"use client";

import React from "react";
import Link from "next/link";
import { ForgeLogo } from "../../components/ForgeLogo";
import { useTheme } from "../../contexts/ThemeContext";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Ensure a hex color renders legibly on a dark background by lightening it if needed. */
function forceLightHex(hex: string, minL = 70): string {
  const clean = hex.replace(/^#/, "");
  const n = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = ((max + min) / 2) * 100;
  if (l >= minL) return hex;
  // Return white as fallback for very dark colors
  return "#e8f0fb";
}

// ─── Layout primitives ────────────────────────────────────────────────────────

function Section({
  id,
  children,
  bg = "#fff",
  style,
}: {
  id?: string;
  children: React.ReactNode;
  bg?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section
      id={id}
      style={{
        background: bg,
        padding: "80px 0",
        ...style,
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 1.5rem" }}>
        {children}
      </div>
    </section>
  );
}

function SectionLabel({
  text,
  color = "#1e3a5f",
  light = false,
}: {
  text: string;
  color?: string;
  light?: boolean;
}) {
  const c = light ? forceLightHex(color) : color;
  return (
    <div
      style={{
        display: "inline-block",
        padding: "4px 14px",
        borderRadius: 20,
        background: light ? "rgba(255,255,255,0.15)" : `${c}18`,
        border: `1px solid ${light ? "rgba(255,255,255,0.25)" : `${c}30`}`,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: light ? "#e8f0fb" : c,
        marginBottom: 16,
      }}
    >
      {text}
    </div>
  );
}

function SectionHeading({
  children,
  center = false,
  light = false,
}: {
  children: React.ReactNode;
  center?: boolean;
  light?: boolean;
}) {
  return (
    <h2
      style={{
        fontSize: "clamp(1.6rem, 3vw, 2.25rem)",
        fontWeight: 800,
        color: light ? "#fff" : "#0f172a",
        lineHeight: 1.2,
        letterSpacing: "-0.02em",
        textAlign: center ? "center" : undefined,
        marginBottom: 12,
      }}
    >
      {children}
    </h2>
  );
}

function SectionSub({
  children,
  center = false,
  light = false,
}: {
  children: React.ReactNode;
  center?: boolean;
  light?: boolean;
}) {
  return (
    <p
      style={{
        fontSize: "1rem",
        color: light ? "rgba(255,255,255,0.75)" : "#475569",
        lineHeight: 1.75,
        maxWidth: center ? 560 : 640,
        margin: center ? "0 auto" : undefined,
        marginBottom: 0,
      }}
    >
      {children}
    </p>
  );
}

function FeatureCard({
  icon,
  color,
  title,
  body,
}: {
  icon: string;
  color: string;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.85)",
        backdropFilter: "blur(10px)",
        border: "1px solid rgba(30,58,95,0.08)",
        borderRadius: 12,
        padding: "1.375rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        transition: "box-shadow 0.2s",
        boxShadow: "0 2px 12px rgba(30,58,95,0.05)",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: `${color}18`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <i className={`fas ${icon}`} style={{ color, fontSize: 17 }} aria-hidden="true" />
      </div>
      <div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "#0f172a",
            marginBottom: 4,
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 13.5, color: "#64748b", lineHeight: 1.65 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

function ChartPill({
  icon,
  label,
  color,
}: {
  icon?: string;
  label: string;
  color: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "6px 14px",
        borderRadius: 20,
        background: `${color}14`,
        border: `1px solid ${color}30`,
        fontSize: 13,
        fontWeight: 600,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {icon && <i className={`fas ${icon}`} style={{ fontSize: 11 }} aria-hidden="true" />}
      {label}
    </div>
  );
}

function StepCard({
  number,
  title,
  code,
}: {
  number: number;
  title: string;
  code: string;
}) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.1)",
        backdropFilter: "blur(10px)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 12,
        padding: "1.5rem",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.2)",
          color: "#fff",
          fontWeight: 800,
          fontSize: 15,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 12,
          flexShrink: 0,
        }}
      >
        {number}
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: "#fff",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <pre
        style={{
          background: "rgba(0,0,0,0.35)",
          borderRadius: 8,
          padding: "0.75rem 1rem",
          fontSize: 12,
          fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
          color: "#86efac",
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: 0,
          lineHeight: 1.6,
        }}
      >
        {code}
      </pre>
    </div>
  );
}

// ─── Zone cards ───────────────────────────────────────────────────────────────

function ZoneCard({
  color,
  name,
  desc,
  details,
}: {
  color: string;
  name: string;
  desc: string;
  details: string[];
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 180,
        background: "#fff",
        border: `2px solid ${color}30`,
        borderTop: `4px solid ${color}`,
        borderRadius: 10,
        padding: "1.125rem 1rem",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 15, color, marginBottom: 4 }}>
        {name}
      </div>
      <div style={{ fontSize: 13, color: "#475569", marginBottom: 10 }}>{desc}</div>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {details.map((d) => (
          <li
            key={d}
            style={{
              fontSize: 12.5,
              color: "#64748b",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            {d}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── About page ───────────────────────────────────────────────────────────────

export default function AboutPage() {
  const { primaryColor } = useTheme();

  return (
    <div style={{ margin: "0 -1.5rem" }}>
      {/* ── Internal sticky nav ──────────────────────────────────────────────── */}
      <nav
        aria-label="Page sections"
        style={{
          position: "sticky",
          top: 56,
          zIndex: 50,
          background: "var(--forge-light)",
          borderBottom: "1px solid rgba(30,58,95,0.08)",
          padding: "0 1.5rem",
          display: "flex",
          justifyContent: "center",
          gap: 4,
          overflowX: "auto",
        }}
      >
        {[
          { href: "#medallion", label: "Medallion" },
          { href: "#capabilities", label: "Capabilities" },
          { href: "#stack", label: "Tech Stack" },
          { href: "#architecture", label: "Architecture" },
          { href: "#start", label: "Get Started" },
        ].map(({ href, label }) => (
          <a
            key={href}
            href={href}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 500,
              color: "#64748b",
              textDecoration: "none",
              whiteSpace: "nowrap",
              borderBottom: "2px solid transparent",
              transition: "color 0.15s, border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.color = primaryColor;
              (e.currentTarget as HTMLAnchorElement).style.borderBottomColor = primaryColor;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.color = "#64748b";
              (e.currentTarget as HTMLAnchorElement).style.borderBottomColor = "transparent";
            }}
          >
            {label}
          </a>
        ))}
      </nav>

      {/* ── 1. Hero ──────────────────────────────────────────────────────────── */}
      <section
        style={{
          background: `linear-gradient(135deg, ${primaryColor} 0%, #0f1e2e 100%)`,
          padding: "96px 1.5rem 80px",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
            <ForgeLogo size={96} animate="none" showName={true} color="#fff" />
          </div>
          <h1
            style={{
              fontSize: "clamp(1.2rem, 3vw, 1.65rem)",
              fontWeight: 700,
              color: "rgba(255,255,255,0.92)",
              marginBottom: 12,
              letterSpacing: "-0.01em",
            }}
          >
            The Core Data Engineering Platform
          </h1>
          <p
            style={{
              fontSize: "1.05rem",
              color: "rgba(255,255,255,0.65)",
              marginBottom: 36,
              lineHeight: 1.7,
            }}
          >
            Scalable compute. Reliable orchestration. Governed analytics.
          </p>
          <div
            style={{
              display: "flex",
              gap: 12,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <Link
              href="/docs"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "12px 24px",
                borderRadius: 8,
                background: "#fff",
                color: primaryColor,
                fontWeight: 700,
                fontSize: 14.5,
                textDecoration: "none",
                transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "0.9")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "1")}
            >
              <i className="fas fa-book-open" aria-hidden="true" />
              Read the Docs
            </Link>
            <Link
              href="/docs/guides/developer-experience"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "12px 24px",
                borderRadius: 8,
                background: "rgba(255,255,255,0.12)",
                border: "1.5px solid rgba(255,255,255,0.3)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 14.5,
                textDecoration: "none",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.2)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.12)")}
            >
              <i className="fas fa-code" aria-hidden="true" />
              Developer Guide
            </Link>
          </div>
        </div>
      </section>

      {/* ── 2. Medallion Architecture ────────────────────────────────────────── */}
      <Section id="medallion" bg="#fff">
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <SectionLabel text="Medallion Architecture" color={primaryColor} />
          <SectionHeading center>Four layers. One truth.</SectionHeading>
          <SectionSub center>
            Forge organises data across four quality tiers. Every byte enters
            at Bronze and is progressively refined — quality-gated at each
            boundary — until it reaches Gold and is ready for analytics.
          </SectionSub>
        </div>

        {/* Zone flow */}
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "stretch",
            flexWrap: "wrap",
            marginBottom: 20,
          }}
        >
          <ZoneCard
            color="#b45309"
            name="Bronze"
            desc="Raw ingest — as-landed"
            details={[
              "Parquet or Delta on ADLS",
              "Immutable — append only",
              "Full history retained",
              "Schema inferred on read",
            ]}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              color: "#cbd5e1",
              fontSize: 20,
              flexShrink: 0,
              alignSelf: "center",
            }}
            aria-hidden="true"
          >
            →
          </div>
          <ZoneCard
            color="#0284c7"
            name="Silver"
            desc="DQ-gated, schema-enforced"
            details={[
              "Delta Lake format",
              "Schema evolution managed",
              "CRITICAL DQ must pass",
              "Deduplication applied",
            ]}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              color: "#cbd5e1",
              fontSize: 20,
              flexShrink: 0,
              alignSelf: "center",
            }}
            aria-hidden="true"
          >
            →
          </div>
          <ZoneCard
            color="#059669"
            name="Gold"
            desc="Aggregated, SLA-governed"
            details={[
              "Business-ready tables",
              "SLO tracked per dataset",
              "Trino-queryable",
              "Lineage fully recorded",
            ]}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              color: "#cbd5e1",
              fontSize: 20,
              flexShrink: 0,
              alignSelf: "center",
            }}
            aria-hidden="true"
          >
            +
          </div>
          <ZoneCard
            color="#7c3aed"
            name="Sandbox"
            desc="Per-user experimentation"
            details={[
              "30-day TTL automatic purge",
              "No lineage tracking",
              "Full Spark & Trino access",
              "Cost-attributed per user",
            ]}
          />
        </div>
        <p style={{ fontSize: 13, color: "#94a3b8", textAlign: "center" }}>
          Sandbox is an isolated experimentation layer — data written here does
          not flow to Silver or Gold.
        </p>
      </Section>

      {/* ── 3. Capabilities ──────────────────────────────────────────────────── */}
      <Section
        id="capabilities"
        bg="linear-gradient(135deg, #f0f6ff 0%, #eef2f7 100%)"
      >
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <SectionLabel text="Capabilities" color={primaryColor} />
          <SectionHeading center>Everything your data pipelines need</SectionHeading>
          <SectionSub center>
            Forge packages the best open-source data tooling on a production
            Kubernetes substrate, so your team can focus on building pipelines —
            not managing infrastructure.
          </SectionSub>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 16,
          }}
        >
          <FeatureCard
            icon="fa-bolt"
            color="#e25a1c"
            title="Spark 4.1 on Kubernetes"
            body="Apache Spark 4.1.0 via Spark Operator. Spark Connect for interactive development from VS Code or Jupyter — no cluster SSH required."
          />
          <FeatureCard
            icon="fa-table"
            color="#dd00a1"
            title="Trino 480"
            body="Federated SQL across Delta Lake, Iceberg, and external data sources. Scales horizontally on demand with per-query cost tracking."
          />
          <FeatureCard
            icon="fa-calendar-check"
            color="#017cee"
            title="Airflow 3.1"
            body="KubernetesExecutor for isolated task pods. DAGs go live in 30 seconds via git-sync — no deployment pipeline needed."
          />
          <FeatureCard
            icon="fa-triangle-exclamation"
            color="#f59e0b"
            title="Data Quality"
            body="YAML-defined rulesets with schema, content, volume, and freshness checks. CRITICAL failures gate pipeline progression automatically."
          />
          <FeatureCard
            icon="fa-share-nodes"
            color="#7c3aed"
            title="Lineage Tracking"
            body="OpenLineage events captured for every job. Column-level lineage and upstream/downstream impact analysis via Microsoft Purview."
          />
          <FeatureCard
            icon="fa-chart-line"
            color="#059669"
            title="Observability"
            body="Azure Monitor metrics, Azure Managed Grafana dashboards, Log Analytics for logs, and Azure Monitor Alerts. SLOs tracked per pipeline."
          />
          <FeatureCard
            icon="fa-lock"
            color="#0f172a"
            title="S360 Compliant"
            body="Private endpoints only. Workload Identity — no long-lived credentials. Defender for Containers and Storage enabled throughout."
          />
          <FeatureCard
            icon="fa-layer-group"
            color="#003366"
            title="Delta Lake Default"
            body="Delta Lake 4.0 as the default table format. Apache Iceberg 1.6.1 available as opt-in for specific workloads and external consumers."
          />
        </div>
      </Section>

      {/* ── 4. Tech Stack ────────────────────────────────────────────────────── */}
      <Section id="stack" bg="#fff">
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <SectionLabel text="Technology Stack" color={primaryColor} />
          <SectionHeading center>Built on best-in-class open source</SectionHeading>
          <SectionSub center>
            Every component is a battle-tested project with a strong community.
            No vendor lock-in for the data layer — just proven technology, well
            configured.
          </SectionSub>
        </div>

        {/* Core data stack */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#94a3b8",
              marginBottom: 10,
            }}
          >
            Core data stack
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <ChartPill icon="fa-bolt" label="Spark 4.1" color="#e25a1c" />
            <ChartPill icon="fa-layer-group" label="Delta Lake 4.0" color="#003366" />
            <ChartPill icon="fa-snowflake" label="Iceberg 1.6.1" color="#2874A6" />
            <ChartPill icon="fa-table" label="Trino 480" color="#dd00a1" />
            <ChartPill icon="fa-calendar-check" label="Airflow 3.1" color="#017cee" />
          </div>
        </div>

        {/* Observability + Lineage */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#94a3b8",
              marginBottom: 10,
            }}
          >
            Observability &amp; lineage
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <ChartPill icon="fa-share-nodes" label="OpenLineage" color="#f97316" />
            <ChartPill icon="fa-diagram-project" label="Microsoft Purview" color="#0078d4" />
            <ChartPill icon="fa-chart-line" label="Azure Monitor" color="#e6522c" />
            <ChartPill icon="fa-chart-bar" label="Azure Managed Grafana" color="#f46800" />
            <ChartPill icon="fa-file-lines" label="Log Analytics" color="#0078d4" />
          </div>
        </div>

        {/* Azure infrastructure */}
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#94a3b8",
              marginBottom: 10,
            }}
          >
            Hosted on Azure
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <ChartPill icon="fa-dharmachakra" label="AKS 1.29" color="#326ce5" />
            <ChartPill icon="fa-hard-drive" label="ADLS Gen2" color="#0078d4" />
            <ChartPill icon="fa-key" label="Azure Key Vault" color="#0078d4" />
            <ChartPill icon="fa-box" label="Container Registry" color="#0078d4" />
          </div>
        </div>
      </Section>

      {/* ── 5. Architecture ──────────────────────────────────────────────────── */}
      <Section
        id="architecture"
        bg="linear-gradient(135deg, #f8faff 0%, #eef2f7 100%)"
      >
        <div style={{ marginBottom: 40 }}>
          <SectionLabel text="Architecture" color={primaryColor} />
          <SectionHeading>Dual-cluster design</SectionHeading>
          <SectionSub>
            Compute and orchestration are separated into two independent AKS
            clusters — each scales, upgrades, and fails independently.
          </SectionSub>
        </div>

        {/* ── Main platform overview diagram ── */}
        <div style={{
          border: `2px dashed ${primaryColor}35`,
          borderRadius: 18,
          padding: "20px 20px 16px",
          background: `${primaryColor}04`,
          marginBottom: 40,
          position: "relative",
        }}>
          {/* Platform label */}
          <div style={{
            position: "absolute", top: -11, left: 20,
            background: "linear-gradient(135deg, #f8faff 0%, #eef2f7 100%)",
            padding: "0 10px", fontSize: 11, fontWeight: 800,
            letterSpacing: "0.1em", color: primaryColor, textTransform: "uppercase",
          }}>
            ▲ FORGE PLATFORM
          </div>

          {/* Two clusters */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 48px 1fr",
            gap: 0,
            alignItems: "stretch",
            marginBottom: 12,
          }}>
            {/* Compute cluster */}
            <div style={{
              border: "1px solid #e25a1c30", borderTop: "3px solid #e25a1c",
              borderRadius: "10px 0 0 10px", padding: "14px 16px", background: "white",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ width: 26, height: 26, borderRadius: 6, background: "#e25a1c12", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <i className="fas fa-bolt" style={{ color: "#e25a1c", fontSize: 12 }} />
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 13, color: "#0f172a" }}>Compute Cluster</div>
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8" }}>forge-compute</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
                {[
                  { label: "Spark Operator 2.5", color: "#e25a1c", icon: "fa-bolt" },
                  { label: "Spark Connect (gRPC)", color: "#f97316", icon: "fa-plug" },
                  { label: "Trino 480", color: "#dd00a1", icon: "fa-table-columns" },
                  { label: "Hive Metastore 4.0", color: "#b45309", icon: "fa-sitemap" },
                ].map(c => (
                  <div key={c.label} style={{
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "4px 8px", borderRadius: 6, fontSize: 12,
                    background: `${c.color}0c`, borderLeft: `3px solid ${c.color}`,
                  }}>
                    <i className={`fas ${c.icon}`} style={{ color: c.color, fontSize: 11, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: "#1e293b" }}>{c.label}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {["systempool", "sparkpool (0–20)", "trinopool (0–10)"].map(p => (
                  <span key={p} style={{ fontSize: 9.5, color: "#64748b", background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace", border: "1px solid #e2e8f0" }}>{p}</span>
                ))}
              </div>
            </div>

            {/* Middle connector */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "white", borderTop: "1px solid #e2e8f0", borderBottom: "1px solid #e2e8f0", gap: 4 }}>
              <i className="fas fa-right-left" style={{ color: "#94a3b8", fontSize: 12 }} />
              <div style={{ fontSize: 8, color: "#94a3b8", textAlign: "center", fontWeight: 700, lineHeight: 1.3 }}>VNet<br/>Peering</div>
            </div>

            {/* Orchestration cluster */}
            <div style={{
              border: "1px solid #05966930", borderTop: "3px solid #059669",
              borderRadius: "0 10px 10px 0", padding: "14px 16px", background: "white",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ width: 26, height: 26, borderRadius: 6, background: "#05996912", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <i className="fas fa-calendar-check" style={{ color: "#059669", fontSize: 12 }} />
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 13, color: "#0f172a" }}>Orchestration Cluster</div>
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8" }}>forge-orchestration</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
                {[
                  { label: "Airflow 3.1 (KubernetesExecutor)", color: "#017cee", icon: "fa-calendar-check" },
                  { label: "Microsoft Purview (OpenLineage)", color: "#0078d4", icon: "fa-share-nodes" },
                  { label: "Azure Monitor + Managed Grafana", color: "#e6522c", icon: "fa-chart-line" },
                  { label: "Developer Portal (auth-proxy + api + web)", color: "#059669", icon: "fa-window-maximize" },
                ].map(c => (
                  <div key={c.label} style={{
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "4px 8px", borderRadius: 6, fontSize: 12,
                    background: `${c.color}0c`, borderLeft: `3px solid ${c.color}`,
                  }}>
                    <i className={`fas ${c.icon}`} style={{ color: c.color, fontSize: 11, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: "#1e293b" }}>{c.label}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {["systempool", "workerpool (2–20)"].map(p => (
                  <span key={p} style={{ fontSize: 9.5, color: "#64748b", background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace", border: "1px solid #e2e8f0" }}>{p}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Down arrow */}
          <div style={{ textAlign: "center", margin: "4px 0 8px", lineHeight: 1 }}>
            <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <i className="fas fa-arrows-up-down" style={{ color: "#94a3b8", fontSize: 12 }} />
              <span style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.05em" }}>PRIVATE ENDPOINTS</span>
            </div>
          </div>

          {/* ADLS Gen2 */}
          <div style={{
            border: "1px solid #0078d430", borderTop: "3px solid #0078d4",
            borderRadius: 10, padding: "12px 16px", background: "white",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 26, height: 26, borderRadius: 6, background: "#0078d412", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <i className="fas fa-hard-drive" style={{ color: "#0078d4", fontSize: 12 }} />
              </div>
              <div>
                <span style={{ fontWeight: 800, fontSize: 13, color: "#0f172a" }}>ADLS Gen2 Lakehouse</span>
                <span style={{ marginLeft: 8, fontSize: 10, color: "#94a3b8", fontFamily: "monospace" }}>Hierarchical Namespace · Private Endpoints</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {[
                { label: "bronze/", color: "#b45309", tag: "Raw · 2yr" },
                { label: "silver/", color: "#0284c7", tag: "Delta · 2yr" },
                { label: "gold/", color: "#059669", tag: "Delta · 2yr" },
                { label: "sandbox/", color: "#7c3aed", tag: "30-day TTL" },
                { label: "code/", color: "#64748b", tag: "Job artifacts" },
              ].map((z, i) => (
                <React.Fragment key={z.label}>
                  {i > 0 && i < 4 && (
                    <i className="fas fa-arrow-right" style={{ color: "#cbd5e1", fontSize: 10, flexShrink: 0 }} />
                  )}
                  {i === 4 && <span style={{ color: "#e2e8f0", margin: "0 4px" }}>·</span>}
                  <div style={{
                    padding: "4px 10px", borderRadius: 6,
                    background: `${z.color}0d`, border: `1px solid ${z.color}30`,
                  }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: z.color }}>{z.label}</span>
                    <span style={{ fontSize: 10, color: "#64748b", marginLeft: 5 }}>{z.tag}</span>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Security footer */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, padding: "8px 12px", background: "rgba(15,23,42,0.04)", borderRadius: 8 }}>
            <i className="fas fa-lock" style={{ color: "#64748b", fontSize: 11 }} />
            <span style={{ fontSize: 11.5, color: "#64748b" }}>
              All cluster API servers private · Portal and Trino served over HTTPS via ingress-nginx + Let&apos;s Encrypt · Workload Identity throughout · No long-lived credentials · Defender for Containers on ACR
            </span>
          </div>
        </div>

        {/* ── Data flow diagram ── */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 16 }}>
            End-to-end data flow
          </div>
          <div style={{ overflowX: "auto", paddingBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 0, minWidth: 780 }}>
              {[
                { label: "Source", sub: "CSV · Parquet · API · DB", color: "#64748b", icon: "fa-database", detail: "External system" },
                { label: "Bronze", sub: "Append-only ingestion", color: "#b45309", icon: "fa-inbox", detail: "Parquet / native format · Immutable" },
                { label: "DQ Check", sub: "Schema · Content · Volume · Freshness", color: "#f59e0b", icon: "fa-shield-halved", detail: "YAML rulesets run by DQ SDK" },
                { label: "Silver", sub: "Cleaned & validated", color: "#0284c7", icon: "fa-filter", detail: "Delta Lake · Schema enforced" },
                { label: "DQ Gate", sub: "CRITICAL blocks", color: "#dc2626", icon: "fa-circle-stop", detail: "Pipeline halts on CRITICAL failure" },
                { label: "Gold", sub: "Governed & aggregated", color: "#059669", icon: "fa-star", detail: "Delta Lake · SLA-governed · Optimised" },
                { label: "Query", sub: "Trino · Portal · LoomX", color: primaryColor, icon: "fa-magnifying-glass", detail: "Federated SQL · APIs · Analytics" },
              ].map((step, i) => (
                <React.Fragment key={step.label}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 96, flex: 1 }}>
                    <div style={{
                      width: "100%", padding: "10px 8px", borderRadius: 10,
                      background: "white", border: `1px solid ${step.color}30`,
                      borderTop: `3px solid ${step.color}`,
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                      boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                    }}>
                      <div style={{ width: 28, height: 28, borderRadius: 7, background: `${step.color}12`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <i className={`fas ${step.icon}`} style={{ color: step.color, fontSize: 12 }} />
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 12, color: "#0f172a", textAlign: "center" }}>{step.label}</div>
                      <div style={{ fontSize: 10, color: "#64748b", textAlign: "center", lineHeight: 1.3 }}>{step.sub}</div>
                    </div>
                    <div style={{ fontSize: 9.5, color: "#94a3b8", textAlign: "center", marginTop: 6, lineHeight: 1.3, maxWidth: 90 }}>
                      {step.detail}
                    </div>
                  </div>
                  {i < 6 && (
                    <div style={{ display: "flex", alignItems: "center", paddingTop: 16, flexShrink: 0, width: 24, justifyContent: "center" }}>
                      <i className="fas fa-arrow-right" style={{ color: "#cbd5e1", fontSize: 12 }} />
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Lineage strip */}
          <div style={{
            marginTop: 16,
            padding: "8px 16px",
            background: "#7c3aed08",
            border: "1px solid #7c3aed20",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}>
            <i className="fas fa-share-nodes" style={{ color: "#7c3aed", fontSize: 13, flexShrink: 0 }} />
            <div style={{ fontSize: 12, color: "#334155" }}>
              <strong>OpenLineage</strong> events emitted at every Spark job and Airflow task execution →
              captured by <strong>Microsoft Purview</strong> → column-level lineage and upstream/downstream impact analysis available in the Lineage Explorer
            </div>
          </div>
          {/* Airflow orchestration strip */}
          <div style={{
            marginTop: 8,
            padding: "8px 16px",
            background: "#017cee08",
            border: "1px solid #017cee20",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}>
            <i className="fas fa-calendar-check" style={{ color: "#017cee", fontSize: 13, flexShrink: 0 }} />
            <div style={{ fontSize: 12, color: "#334155" }}>
              <strong>Airflow</strong> orchestrates every Bronze → Silver → Gold transition via DAGs.
              Each task runs as an isolated Kubernetes pod (KubernetesExecutor). DAG changes go live in ~30 seconds via git-sync.
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 20,
            flexWrap: "wrap",
            marginBottom: 32,
          }}
        >
          {/* Compute cluster */}
          <div
            style={{
              flex: 1,
              minWidth: 280,
              background: "#fff",
              border: `2px solid ${primaryColor}20`,
              borderTop: `4px solid ${primaryColor}`,
              borderRadius: 12,
              padding: "1.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  background: `${primaryColor}14`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <i className="fas fa-bolt" style={{ color: primaryColor, fontSize: 16 }} aria-hidden="true" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a" }}>
                Compute Cluster
              </div>
            </div>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "0 0 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {[
                "Spark Operator 2.5",
                "Spark Connect server",
                "Trino 480 (coordinator + workers)",
              ].map((item) => (
                <li
                  key={item}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13.5,
                    color: "#334155",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: primaryColor,
                      flexShrink: 0,
                    }}
                  />
                  {item}
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.65 }}>
              Scales independently from orchestration. Spark pools auto-scale to
              zero between jobs, reducing idle compute cost.
            </p>
          </div>

          {/* Orchestration cluster */}
          <div
            style={{
              flex: 1,
              minWidth: 280,
              background: "#fff",
              border: "2px solid #059669" + "20",
              borderTop: "4px solid #059669",
              borderRadius: 12,
              padding: "1.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  background: "#05996918",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <i className="fas fa-calendar-check" style={{ color: "#059669", fontSize: 16 }} aria-hidden="true" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a" }}>
                Orchestration Cluster
              </div>
            </div>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "0 0 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {[
                "Airflow 3.1 (KubernetesExecutor)",
                "Microsoft Purview (lineage)",
                "Azure Monitor + Managed Grafana",
                "Forge Developer Portal (auth-proxy + api + web)",
              ].map((item) => (
                <li
                  key={item}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13.5,
                    color: "#334155",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "#059669",
                      flexShrink: 0,
                    }}
                  />
                  {item}
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.65 }}>
              Platform services isolated from job compute. High-availability
              Airflow schedulers with redundant metadata database.
            </p>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "12px 20px",
            background: "rgba(30,58,95,0.05)",
            borderRadius: 10,
            border: "1px solid rgba(30,58,95,0.1)",
          }}
        >
          <i className="fas fa-lock" style={{ color: primaryColor, fontSize: 14 }} aria-hidden="true" />
          <span style={{ fontSize: 13.5, color: "#475569", fontWeight: 500 }}>
            Portal and Trino served over HTTPS (cert-manager / Let&apos;s Encrypt). Azure
            Workload Identity throughout — zero long-lived credentials.
          </span>
        </div>
      </Section>

      {/* ── 6. Get Started ───────────────────────────────────────────────────── */}
      <section
        id="start"
        style={{
          background: `linear-gradient(135deg, ${primaryColor} 0%, #0f1e2e 100%)`,
          padding: "80px 1.5rem",
        }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <SectionLabel text="Get Started" color={primaryColor} light />
            <SectionHeading center light>
              Start building pipelines today
            </SectionHeading>
            <SectionSub center light>
              Three steps from zero to a running pipeline with full lineage and
              data quality checks.
            </SectionSub>
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <StepCard
              number={1}
              title="Provision Infrastructure"
              code={`az deployment sub create \\
  --location australiaeast \\
  --template-file infra/main.bicep \\
  --parameters @infra/params.json`}
            />
            <StepCard
              number={2}
              title="Author a DAG"
              code={`# Drop your DAG into the dags/ folder.
# It goes live in ~30 seconds via git-sync.

dags/
  my_pipeline.py   ← your DAG here`}
            />
            <StepCard
              number={3}
              title="Query Your Data"
              code={`# Spark Connect (from VS Code / Jupyter)
from pyspark.sql import SparkSession

spark = SparkSession.builder \\
  .remote("sc://forge-compute-prproddu-dev.northcentralus.cloudapp.azure.com:15002") \\
  .getOrCreate()

df = spark.read.format("delta") \\
  .load("abfss://gold@<storage>/sales")
df.show()

# Trino CLI (PowerShell)
$token = az account get-access-token \\
  --resource https://management.azure.com/ \\
  --query accessToken -o tsv
trino --server=https://forge-compute-prproddu-dev.northcentralus.cloudapp.azure.com \\
      --access-token="$token" --catalog=hive

# Trino UI (browser)
# https://forge-compute-prproddu-dev.northcentralus.cloudapp.azure.com/ui/`}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
