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
        padding: "52px 0",
        ...style,
      }}
    >
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "0 1.5rem" }}>
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
        marginBottom: 10,
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
        marginBottom: 8,
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
  logo,
  color,
  title,
  body,
}: {
  icon: string;
  logo?: string;
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
        {logo
          ? <img src={logo} width={20} height={20} alt="" aria-hidden="true" style={{ display: "block" }} />
          : <i className={`fas ${icon}`} style={{ color, fontSize: 17 }} aria-hidden="true" />
        }
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
  logo,
  label,
  color,
}: {
  icon?: string;
  logo?: string;
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
      {logo
        ? <img src={logo} width={13} height={13} alt="" aria-hidden="true" style={{ display: "block" }} />
        : icon && <i className={`fas ${icon}`} style={{ fontSize: 11 }} aria-hidden="true" />
      }
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
    <div style={{ minHeight: "100%" }}>
      {/* ── Internal sticky nav ──────────────────────────────────────────────── */}
      <nav
        aria-label="Page sections"
        style={{
          position: "sticky",
          top: 0,
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
          { href: "#architecture", label: "Architecture" },
          { href: "#medallion",  label: "Medallion" },
          { href: "#capabilities", label: "Capabilities" },
          { href: "#stack",      label: "Tech Stack" },
          { href: "#journeys",   label: "User Journeys" },
          { href: "#identity",   label: "Identity & RBAC" },
          { href: "#start",      label: "Get Started" },
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

      {/* ── 1. Hero (inline — rich about-page hero with logo + CTA) ─────────── */}
      <section
        style={{
          background: `linear-gradient(135deg, ${primaryColor} 0%, #0f1e2e 100%)`,
          padding: "56px 1.5rem 48px",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
            <ForgeLogo size={80} animate="none" showName={true} color="#fff" />
          </div>
          <h1
            style={{
              fontSize: "clamp(1.1rem, 3vw, 1.5rem)",
              fontWeight: 700,
              color: "rgba(255,255,255,0.92)",
              marginBottom: 4,
              letterSpacing: "-0.01em",
            }}
          >
            The Core Platform
          </h1>
          <p
            style={{
              fontSize: "1rem",
              color: "rgba(255,255,255,0.65)",
              marginBottom: 24,
              lineHeight: 1.5,
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

      {/* ── 2. Architecture ──────────────────────────────────────────────────── */}
      <Section
        id="architecture"
        bg="linear-gradient(135deg, #f8faff 0%, #eef2f7 100%)"
      >
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <SectionLabel text="Architecture" color={primaryColor} />
          <SectionHeading center>Platform Architecture</SectionHeading>
          <SectionSub center>
            Dual AKS clusters on Azure CNI Overlay. Workload Identity (OIDC) on every pod. All data plane services behind private endpoints.
          </SectionSub>
        </div>

        {/* ── Platform architecture card (native React — mirrors architecture.html) ── */}
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, overflow: "hidden", marginBottom: 28, boxShadow: "0 4px 24px rgba(15,23,42,0.07)" }}>

          {/* Card body */}
          <div style={{ padding: 22 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

              {/* Identity band */}
              <div style={{ borderRadius: 8, padding: "11px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", background: "#eff6ff", border: "1.5px dashed #0078d4" }}>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1.5px", textTransform: "uppercase", color: "#0078d4", minWidth: 90, whiteSpace: "nowrap" }}>Azure AD · Identity</span>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  {["🔐 Workload Identity · OIDC Federation", "👥 AAD Groups → AKS RBAC", "id-forge-spark", "id-forge-trino", "id-forge-airflow", "id-forge-hms", "id-forge-dq", "id-forge-portal"].map(chip => (
                    <span key={chip} style={{ borderRadius: 20, padding: "3px 9px", fontSize: 10, fontWeight: 500, background: "#fff", border: "1px solid #bfdbfe", color: "#1e40af", whiteSpace: "nowrap" }}>{chip}</span>
                  ))}
                </div>
              </div>

              {/* 7-column cluster row */}
              <div style={{ display: "grid", gridTemplateColumns: "120px 44px 1fr 44px 1fr 44px 165px", gap: 0, alignItems: "stretch" }}>

                {/* Client zone */}
                <div style={{ borderRadius: 8, padding: 12, border: "1.5px solid #cbd5e1", background: "#fafafa", display: "flex", flexDirection: "column", gap: 7 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "#64748b" }}>
                    Client<span style={{ display: "block", fontSize: 8.5, fontWeight: 400, letterSpacing: 0, textTransform: "none", opacity: 0.6, marginTop: 2 }}>External</span>
                  </div>
                  {[
                    { name: "Browser",  meta: "AAD · HTTPS",      icon: "fa-globe",       color: "#0078d4" },
                    { name: "Notebook", meta: "VS Code · Jupyter", icon: "fa-laptop-code", color: "#1d4ed8" },
                    { name: "CLI",      meta: "kubectl · az",      icon: "fa-terminal",    color: "#374151" },
                  ].map(s => (
                    <div key={s.name} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 9px", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
                      <div style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: `${s.color}15` }}>
                        <i className={`fas ${s.icon}`} style={{ color: s.color, fontSize: 11 }} />
                      </div>
                      <div><div style={{ fontSize: 11, fontWeight: 600, color: "#1e293b" }}>{s.name}</div><div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace", marginTop: 1 }}>{s.meta}</div></div>
                    </div>
                  ))}
                </div>

                {/* Connector 1 */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "0 2px" }}>
                  <svg width="44" height="28" viewBox="0 0 44 28"><line x1="2" y1="14" x2="34" y2="14" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="3,2"/><polygon points="30,10 42,14 30,18" fill="#94a3b8"/></svg>
                  <div style={{ fontSize: 8, color: "#374151", fontFamily: "monospace", textAlign: "center", fontWeight: 600 }}>HTTPS 443</div>
                  <div style={{ fontSize: 8, color: "#374151", fontFamily: "monospace", textAlign: "center", marginTop: 6, fontWeight: 600 }}>gRPC 15002</div>
                </div>

                {/* Orchestration zone */}
                <div style={{ borderRadius: 8, padding: 12, border: "1.5px solid #16a34a", background: "#f0fdf4", display: "flex", flexDirection: "column", gap: 7 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "#15803d" }}>
                    AKS Orchestration<span style={{ display: "block", fontSize: 8.5, fontWeight: 400, letterSpacing: 0, textTransform: "none", opacity: 0.6, marginTop: 2 }}>aks-forge-orchestration · 10.2.0.0/16 · pods 10.101.0.0/16</span>
                  </div>
                  {[
                    { name: "Portal API", meta: "portal ns · HTTPS 443",  icon: "fa-window-maximize", color: "#107c10", tag: "PUBLIC",   tagBg: "#dcfce7", tagFg: "#15803d" },
                    { name: "Airflow",    meta: "airflow ns · HTTP 8080",  icon: "fa-calendar-check",  logo: "https://cdn.simpleicons.org/apacheairflow/017cee", color: "#017cee", tag: "PUBLIC",   tagBg: "#dcfce7", tagFg: "#15803d" },
                    { name: "DQ Runner", meta: "dq ns · internal",         icon: "fa-shield-halved",   color: "#15803d", tag: "INTERNAL", tagBg: "#f1f5f9", tagFg: "#475569" },
                  ].map(s => (
                    <div key={s.name} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 9px", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
                      <div style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: `${s.color}15` }}>
                        {"logo" in s && s.logo
                          ? <img src={s.logo} width={14} height={14} alt="" style={{ display: "block" }} />
                          : <i className={`fas ${s.icon}`} style={{ color: s.color, fontSize: 11 }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 600, color: "#1e293b" }}>{s.name}</div><div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace", marginTop: 1 }}>{s.meta}</div></div>
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, background: s.tagBg, color: s.tagFg }}>{s.tag}</span>
                    </div>
                  ))}
                </div>

                {/* Connector 2 */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "0 2px" }}>
                  <svg width="44" height="28" viewBox="0 0 44 28"><line x1="2" y1="14" x2="34" y2="14" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="3,2"/><polygon points="30,10 42,14 30,18" fill="#94a3b8"/></svg>
                  <div style={{ fontSize: 8, color: "#374151", fontFamily: "monospace", textAlign: "center", fontWeight: 600 }}>HTTP 8080</div>
                  <div style={{ fontSize: 8, color: "#374151", fontFamily: "monospace", textAlign: "center", marginTop: 6, fontWeight: 600 }}>gRPC 15002</div>
                </div>

                {/* Compute zone */}
                <div style={{ borderRadius: 8, padding: 12, border: "1.5px solid #ea580c", background: "#fff7ed", display: "flex", flexDirection: "column", gap: 7 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "#c2410c" }}>
                    AKS Compute<span style={{ display: "block", fontSize: 8.5, fontWeight: 400, letterSpacing: 0, textTransform: "none", opacity: 0.6, marginTop: 2 }}>aks-forge-compute · 10.1.0.0/16 · pods 10.100.0.0/16</span>
                  </div>
                  {[
                    { name: "Spark Connect",   meta: "spark-system · gRPC 15002",   icon: "fa-bolt",          color: "#e25a1c", tag: "PUBLIC",   tagBg: "#fef3c7", tagFg: "#92400e" },
                    { name: "Spark Executors", meta: "spark-jobs · autoscale",       icon: "fa-bolt",          color: "#c2410c", tag: "DYNAMIC",  tagBg: "#f1f5f9", tagFg: "#475569" },
                    { name: "Trino",           meta: "trino ns · HTTP 8080",         icon: "fa-table-columns", logo: "https://cdn.simpleicons.org/trino/b91c1c", color: "#b91c1c", tag: "PUBLIC",   tagBg: "#fef3c7", tagFg: "#92400e" },
                    { name: "Hive Metastore",  meta: "hive-metastore · Thrift 9083", icon: "fa-sitemap",       color: "#7c3aed", tag: "INTERNAL", tagBg: "#f1f5f9", tagFg: "#475569" },
                  ].map(s => (
                    <div key={s.name} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 9px", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
                      <div style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: `${s.color}15` }}>
                        {"logo" in s && s.logo
                          ? <img src={s.logo} width={14} height={14} alt="" style={{ display: "block" }} />
                          : <i className={`fas ${s.icon}`} style={{ color: s.color, fontSize: 11 }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 600, color: "#1e293b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div><div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace", marginTop: 1 }}>{s.meta}</div></div>
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, background: s.tagBg, color: s.tagFg }}>{s.tag}</span>
                    </div>
                  ))}
                </div>

                {/* Connector 3 */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "0 2px" }}>
                  <svg width="44" height="28" viewBox="0 0 44 28"><line x1="2" y1="14" x2="34" y2="14" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="3,2"/><polygon points="30,10 42,14 30,18" fill="#94a3b8"/></svg>
                  <div style={{ fontSize: 8, color: "#374151", fontFamily: "monospace", textAlign: "center", fontWeight: 600 }}>abfss://</div>
                  <div style={{ fontSize: 8, color: "#374151", fontFamily: "monospace", textAlign: "center", marginTop: 6, fontWeight: 600 }}>PE · RBAC</div>
                </div>

                {/* Data zone */}
                <div style={{ borderRadius: 8, padding: 12, border: "1.5px solid #0891b2", background: "#f0fdfa", display: "flex", flexDirection: "column", gap: 7 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "#0e7490" }}>
                    Data & Secrets<span style={{ display: "block", fontSize: 8.5, fontWeight: 400, letterSpacing: 0, textTransform: "none", opacity: 0.6, marginTop: 2 }}>Private endpoints</span>
                  </div>

                  {/* ADLS Gen2 — special tile with layer chips */}
                  <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 9px", boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <div style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: "#0284c715" }}>
                        <i className="fas fa-database" style={{ color: "#0284c7", fontSize: 11 }} />
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#1e293b" }}>ADLS Gen2</div>
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 4, background: "#e0f2fe", color: "#0369a1", marginLeft: "auto", whiteSpace: "nowrap" }}>PE</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", paddingLeft: 34 }}>
                      {[
                        { label: "bronze", color: "#b45309", bg: "#fef3c7" },
                        { label: "silver", color: "#0369a1", bg: "#e0f2fe" },
                        { label: "gold",   color: "#059669", bg: "#d1fae5" },
                        { label: "code",   color: "#7c3aed", bg: "#ede9fe" },
                        { label: "logs",   color: "#64748b", bg: "#f1f5f9" },
                      ].map(c => (
                        <span key={c.label} style={{ fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 10, background: c.bg, color: c.color }}>{c.label}/</span>
                      ))}
                    </div>
                  </div>

                  {/* Key Vault, PostgreSQL, ACR */}
                  {[
                    { name: "Key Vault",  meta: "RBAC · soft-delete · PE", icon: "fa-key",  color: "#d97706", tag: "HSM",  tagBg: "#fef3c7", tagFg: "#92400e" },
                    { name: "PostgreSQL", meta: "HMS · portal prefs",       icon: "fa-circle-dot", color: "#6366f1", tag: "VNet", tagBg: "#ede9fe", tagFg: "#5b21b6" },
                    { name: "ACR",        meta: "forgeacr · Defender scan", icon: "fa-box",  color: "#0078d4", tag: "PE",   tagBg: "#e0f2fe", tagFg: "#0369a1" },
                  ].map(s => (
                    <div key={s.name} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 9px", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
                      <div style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: `${s.color}15` }}>
                        <i className={`fas ${s.icon}`} style={{ color: s.color, fontSize: 11 }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#1e293b" }}>{s.name}</div>
                        <div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.meta}</div>
                      </div>
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 4, background: s.tagBg, color: s.tagFg, flexShrink: 0 }}>{s.tag}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Cross-zone connections */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 4 }}>
                {[
                  { title: "Portal → Compute",       rows: [["Portal API",      "Trino",        "HTTP 8080"]] },
                  { title: "Airflow → Compute",       rows: [["Airflow Worker",  "Spark Connect","gRPC 15002"], ["Airflow Worker", "Trino", "HTTP 8080"]] },
                  { title: "Compute → Metadata",      rows: [["Trino / Spark",   "HMS",          "Thrift 9083"], ["HMS", "PostgreSQL", "JDBC 5432"]] },
                  { title: "All workloads → Secrets", rows: [["Any pod",         "Azure AD",     "OIDC"], ["Any pod", "Key Vault", "HTTPS 443 PE"]] },
                ].map(card => (
                  <div key={card.title} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "#94a3b8", marginBottom: 7 }}>{card.title}</div>
                    {card.rows.map(([from, to, proto]) => (
                      <div key={from + to} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, padding: "3px 0", borderBottom: "1px solid #f1f5f9" }}>
                        <span style={{ fontWeight: 600, color: "#1e293b", whiteSpace: "nowrap" }}>{from}</span>
                        <span style={{ color: "#94a3b8", fontSize: 9 }}>→</span>
                        <span style={{ fontWeight: 600, color: "#1e293b", whiteSpace: "nowrap" }}>{to}</span>
                        <span style={{ fontFamily: "monospace", fontSize: 9, color: "#94a3b8", marginLeft: "auto" }}>{proto}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* Networking band */}
              <div style={{ borderRadius: 8, padding: "11px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", background: "#f5f0ff", border: "1.5px solid #7c3aed" }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1.5px", textTransform: "uppercase", color: "#7c3aed", minWidth: 90 }}>
                  Networking
                  <div style={{ fontSize: 8.5, fontWeight: 400, letterSpacing: 0, textTransform: "none", opacity: 0.65, marginTop: 2 }}>rg-forge-[alias]-dev · VNet 10.0.0.0/12</div>
                </div>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  {["NSG Compute 10.1.0.0/16", "NSG Orchestration 10.2.0.0/16", "NSG Private Endpoints 10.3.0.0/24", "NSG AppGW 10.4.0.0/24", "Private DNS zones", "Platform Log Analytics", "Route Tables"].map(chip => (
                    <span key={chip} style={{ borderRadius: 8, padding: "3px 9px", fontSize: 10, fontWeight: 500, background: "#fff", border: "1px solid #ddd6fe", color: "#5b21b6", whiteSpace: "nowrap" }}>{chip}</span>
                  ))}
                </div>
              </div>

            </div>
          </div>
        </div>

        {/* ── Dual-cluster design card — dashed border ── */}
        <div style={{
          position: "relative",
          border: "1.5px dashed rgba(30,58,95,0.2)",
          borderRadius: 16,
          padding: "32px 24px 20px",
          marginTop: 16,
          marginBottom: 16,
          background: "#fff",
          boxShadow: "0 2px 20px rgba(15,23,42,0.04)",
        }}>
          {/* Platform label */}
          <div style={{
            position: "absolute", top: -11, left: 20,
            background: "linear-gradient(135deg, #f8faff 0%, #eef2f7 100%)",
            padding: "0 12px", fontSize: 10, fontWeight: 800,
            letterSpacing: "0.12em", color: primaryColor, textTransform: "uppercase",
          }}>▲ FORGE PLATFORM</div>

          {/* Cluster row: Orch | VNet Peering | Compute */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 52px 1fr", alignItems: "stretch", marginBottom: 0 }}>

            {/* Orchestration cluster */}
            <div style={{ border: "1px solid #bbf7d0", borderTop: "3px solid #16a34a", borderRadius: "10px 0 0 10px", padding: "14px 16px", background: "white" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: "#16a34a12", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <i className="fas fa-calendar-check" style={{ color: "#16a34a", fontSize: 11 }} />
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 12.5, color: "#0f172a" }}>Orchestration Cluster</div>
                  <div style={{ fontFamily: "monospace", fontSize: 9, color: "#94a3b8" }}>aks-forge-orch · 10.2.0.0/16 · systempool + workerpool (2–20)</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {[
                  { label: "Airflow 3.1.8 (KubernetesExecutor)", color: "#017cee", icon: "fa-calendar-check", logo: "https://cdn.simpleicons.org/apacheairflow/017cee" },
                  { label: "OpenLineage via Airflow DAG tags", color: "#0ea5e9", icon: "fa-share-nodes" },
                  { label: "Azure Monitor + Managed Grafana", color: "#e6522c", icon: "fa-chart-line" },
                  { label: "Developer Portal (FastAPI + Next.js)", color: "#059669", icon: "fa-window-maximize" },
                ].map(c => (
                  <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", borderRadius: 6, background: `${c.color}08`, borderLeft: `3px solid ${c.color}` }}>
                    {"logo" in c && c.logo
                      ? <img src={c.logo} width={12} height={12} alt="" style={{ display: "block", flexShrink: 0 }} />
                      : <i className={`fas ${c.icon}`} style={{ color: c.color, fontSize: 10, flexShrink: 0 }} />}
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "#1e293b" }}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* VNet Peering connector */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "white", borderTop: "1px solid #e2e8f0", borderBottom: "1px solid #e2e8f0", gap: 3 }}>
              <i className="fas fa-right-left" style={{ color: "#94a3b8", fontSize: 11 }} />
              <span style={{ fontSize: 8, color: "#94a3b8", fontWeight: 700, textAlign: "center", lineHeight: 1.3 }}>VNet<br/>Peering</span>
            </div>

            {/* Compute cluster */}
            <div style={{ border: "1px solid #fed7aa", borderTop: "3px solid #e25a1c", borderRadius: "0 10px 10px 0", padding: "14px 16px", background: "white" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: "#e25a1c12", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <i className="fas fa-bolt" style={{ color: "#e25a1c", fontSize: 11 }} />
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 12.5, color: "#0f172a" }}>Compute Cluster</div>
                  <div style={{ fontFamily: "monospace", fontSize: 9, color: "#94a3b8" }}>aks-forge-compute · 10.1.0.0/16 · systempool + sparkpool (0–20) + trinopool (0–10)</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {[
                  { label: "Spark Operator 2.5.0 + Spark Connect :15002", color: "#e25a1c", icon: "fa-bolt" },
                  { label: "Spark Executors (spark-jobs ns · autoscale to 0)", color: "#f97316", icon: "fa-bolt" },
                  { label: "Trino 480 (coordinator + workers :8080)", color: "#dd00a1", icon: "fa-table-columns", logo: "https://cdn.simpleicons.org/trino/dd00a1" },
                  { label: "Hive Metastore 4.0.0 (Thrift :9083)", color: "#b45309", icon: "fa-sitemap" },
                ].map(c => (
                  <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", borderRadius: 6, background: `${c.color}08`, borderLeft: `3px solid ${c.color}` }}>
                    {"logo" in c && c.logo
                      ? <img src={c.logo} width={12} height={12} alt="" style={{ display: "block", flexShrink: 0 }} />
                      : <i className={`fas ${c.icon}`} style={{ color: c.color, fontSize: 10, flexShrink: 0 }} />}
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "#1e293b" }}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>

        {/* ── Data flow diagram ── */}
        <div style={{ marginBottom: 20 }}>
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
              lineage graph derived from <strong>Airflow DAG tags</strong> (source: / output:) → upstream/downstream impact analysis in the Lineage Explorer
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
              <strong>Airflow 3.1.8</strong> orchestrates every Bronze → Silver → Gold transition via DAGs.
              Each task runs as an isolated Kubernetes pod (KubernetesExecutor). DAG files are deployed to ADLS code/ container via sync-jobs.sh and picked up by Airflow automatically.
            </div>
          </div>
        </div>


      </Section>

      {/* ── 3. Medallion Architecture ────────────────────────────────────────── */}
      <Section id="medallion" bg="#fff">
        <div style={{ textAlign: "center", marginBottom: 28 }}>
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

      {/* ── 4. Capabilities ──────────────────────────────────────────────────── */}
      <Section
        id="capabilities"
        bg="linear-gradient(135deg, #f0f6ff 0%, #eef2f7 100%)"
      >
        <div style={{ textAlign: "center", marginBottom: 28 }}>
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
            body="Apache Spark 4.1.1 via Spark Operator. Spark Connect for interactive development from VS Code or Jupyter — no cluster SSH required."
          />
          <FeatureCard
            icon="fa-table"
            logo="https://cdn.simpleicons.org/trino/dd00a1"
            color="#dd00a1"
            title="Trino 480"
            body="Federated SQL across Delta Lake, Iceberg, and external data sources. Scales horizontally on demand with per-query cost tracking."
          />
          <FeatureCard
            icon="fa-calendar-check"
            logo="https://cdn.simpleicons.org/apacheairflow/017cee"
            color="#017cee"
            title="Airflow 3.1.8"
            body="KubernetesExecutor for isolated task pods. DAG files are deployed to ADLS and picked up by Airflow automatically — no manual upload."
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
            body="OpenLineage events captured for every job. Upstream/downstream impact analysis via Airflow DAG source/output tags."
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
            body="Delta Lake 4.1.0 as the default table format. Apache Iceberg 1.10.1 available as opt-in for specific workloads and external consumers."
          />
        </div>
      </Section>

      {/* ── 5. Tech Stack ────────────────────────────────────────────────────── */}
      <Section id="stack" bg="#fff">
        <div style={{ textAlign: "center", marginBottom: 28 }}>
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
            <ChartPill icon="fa-bolt" label="Spark 4.1.1" color="#e25a1c" />
            <ChartPill icon="fa-layer-group" label="Delta Lake 4.1.0" color="#003366" />
            <ChartPill icon="fa-snowflake" label="Iceberg 1.10.1" color="#2874A6" />
            <ChartPill logo="https://cdn.simpleicons.org/trino/dd00a1" label="Trino 480" color="#dd00a1" />
            <ChartPill logo="https://cdn.simpleicons.org/apacheairflow/017cee" label="Airflow 3.1.8" color="#017cee" />
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
            <ChartPill icon="fa-share-nodes" label="OpenLineage" color="#0ea5e9" />
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
            <ChartPill icon="fa-dharmachakra" label="AKS 1.32" color="#326ce5" />
            <ChartPill icon="fa-hard-drive" label="ADLS Gen2" color="#0078d4" />
            <ChartPill icon="fa-key" label="Azure Key Vault" color="#0078d4" />
            <ChartPill icon="fa-box" label="Container Registry" color="#0078d4" />
          </div>
        </div>
      </Section>


      {/* ── 6. User Journeys ─────────────────────────────────────────────────── */}
      <Section id="journeys" bg="#fff">
        <div style={{ marginBottom: 40 }}>
          <SectionLabel text="User Journeys" color={primaryColor} />
          <SectionHeading>End-to-end flows</SectionHeading>
          <SectionSub>Every primary use case, traced through the platform.</SectionSub>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))", gap: 18 }}>

          {/* Journey 1 */}
          {[
            {
              num: "1", title: "Run a SQL Query via Portal", color: "#0078d4",
              desc: "Via Portal — no direct cluster access needed. Results back to browser.",
              steps: [
                { actor: "User opens Portal → Datasets or query view", detail: "Authenticates via Azure AD (MSAL loginPopup)", tag: "HTTPS 443 · Public LB · Orch cluster" },
                { actor: "Portal API routes query to Trino Coordinator", detail: "Cross-VNet from orch subnet → compute subnet", tag: "HTTP 8080 · 10.2.x.x → 10.1.x.x" },
                { actor: "Coordinator distributes to Worker pods", detail: "Parallel execution — CNI Overlay pod networking", tag: "Internal · pod IPs 10.100.x.x" },
                { actor: "Workers resolve table schema via HMS", detail: "Gets table location on ADLS Gen2", tag: "Thrift 9083 · hive-metastore ns" },
                { actor: "Workers read data from ADLS Gen2", detail: "id-forge-trino — Reader on bronze / silver / gold", tag: "abfss:// · Private Endpoint" },
              ],
              ok: "Results returned to browser via Portal",
            },
            {
              num: "2", title: "Run a Dev Notebook", color: "#ea580c",
              desc: "Direct Spark Connect session from VS Code or Jupyter. No Portal needed.",
              steps: [
                { actor: "Engineer connects from VS Code / Jupyter", detail: "forge_connect() resolves sc://{host}:15002", tag: "gRPC 15002 · Public LB · Compute cluster" },
                { actor: "Spark Connect creates a Driver pod", detail: "Session in spark-system ns · OIDC → id-forge-spark", tag: "spark-system ns · K8s RBAC" },
                { actor: "Driver launches Executor pods on demand", detail: "K8s Role/RoleBinding — driver creates pods in spark-jobs", tag: "spark-jobs ns · autoscale" },
                { actor: "Executors resolve schema via HMS", detail: "Hive catalog for all table references", tag: "Thrift 9083 · internal" },
                { actor: "Executors read / write ADLS Gen2", detail: "id-forge-spark — Contributor on all layers", tag: "abfss:// · Private Endpoint · OIDC" },
              ],
              ok: "DataFrame results streamed to notebook over gRPC",
            },
            {
              num: "3", title: "Deploy & Schedule a Pipeline", color: "#16a34a",
              desc: "All pipelines are manifest-driven — generated, deployed, and live in seconds.",
              steps: [
                { actor: "Engineer writes a .forge.ts manifest", detail: "Defines layer, schedule, DQ rules, output schema", tag: "forge generate → DAG + Spark job + DQ YAML" },
                { actor: "CI/CD runs sync-jobs.sh", detail: "Uploads DAG + Spark job + DQ rules to ADLS code/", tag: "ADLS code/ · Airflow ADLS sync" },
                { actor: "Airflow picks up the DAG automatically", detail: "No manual upload — DAG live within seconds", tag: "Airflow 3.1.8 · KubernetesExecutor" },
                { actor: "Airflow Worker executes SparkKubernetesOperator", detail: "Submits SparkApplication CRD → compute cluster", tag: "SparkApplication · spark-jobs ns" },
                { actor: "DQGateOperator runs quality checks", detail: "CRITICAL violations block pipeline progression", tag: "DQ gate · Spark · ADLS all layers" },
              ],
              ok: "Pipeline live — lineage tracked via Airflow DAG tags",
            },
            {
              num: "4", title: "Explore Data Lineage", color: "#d97706",
              desc: "Trace data from source to gold. Full provenance via Airflow DAG source/output tags.",
              steps: [
                { actor: "Engineer opens Portal → Lineage tab", detail: "Authenticates via Azure AD — no cluster access needed", tag: "HTTPS 443 · Public LB · Orch cluster" },
                { actor: "Portal API queries Airflow DAGs for source/output tags", detail: "id-forge-portal → Airflow REST API", tag: "HTTPS · Airflow API" },
                { actor: "BFS walk builds upstream / downstream lineage graph", detail: "source: and output: DAG tags drive the graph — no external catalog needed", tag: "Airflow DAG tags · Trino HMS" },
                { actor: "Engineer traces data: bronze → silver → gold", detail: "Each hop links to the pipeline that produced it", tag: "Interactive graph · DAG link · timestamp" },
              ],
              ok: "Full data provenance — source to consumer",
            },
          ].map((flow) => (
            <div key={flow.num} style={{ border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{
                padding: "12px 16px", borderBottom: "1px solid #e2e8f0",
                background: `${flow.color}08`, display: "flex", alignItems: "flex-start", gap: 10,
              }}>
                <div style={{
                  width: 26, height: 26, borderRadius: "50%", background: flow.color,
                  color: "#fff", fontWeight: 800, fontSize: 12,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1,
                }}>
                  {flow.num}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: flow.color }}>{flow.title}</div>
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{flow.desc}</div>
                </div>
              </div>
              <div style={{ padding: 16, flex: 1 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {flow.steps.map((step, i) => (
                    <div key={i} style={{ display: "flex", gap: 11, alignItems: "flex-start", position: "relative", marginTop: i > 0 ? 8 : 0 }}>
                      {i < flow.steps.length - 1 && (
                        <div style={{ position: "absolute", left: 13, top: 28, bottom: -4, width: 2, background: "#e2e8f0" }} />
                      )}
                      <div style={{
                        width: 26, height: 26, borderRadius: "50%", border: `2px solid ${flow.color}`,
                        background: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 700, color: flow.color, flexShrink: 0, zIndex: 1,
                      }}>
                        {i + 1}
                      </div>
                      <div style={{ paddingBottom: 4, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>{step.actor}</div>
                        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{step.detail}</div>
                        <span style={{
                          display: "inline-block", fontSize: 9, fontFamily: "monospace",
                          background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 4,
                          padding: "1px 6px", color: "#64748b", marginTop: 4,
                        }}>{step.tag}</span>
                      </div>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 11, alignItems: "flex-start", marginTop: 8 }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: "50%", border: `2px solid #16a34a`,
                      background: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, color: "#16a34a", flexShrink: 0,
                    }}>✓</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#16a34a", paddingTop: 5 }}>{flow.ok}</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 7. Identity & RBAC ───────────────────────────────────────────────── */}
      <Section id="identity" bg="linear-gradient(135deg, #f0f6ff 0%, #eef2f7 100%)">
        <div style={{ marginBottom: 40 }}>
          <SectionLabel text="Identity & RBAC" color={primaryColor} />
          <SectionHeading>Least-privilege workload identities</SectionHeading>
          <SectionSub>
            Each workload has a dedicated Azure Managed Identity with exactly the permissions it needs.
            No shared credentials. No long-lived secrets. OIDC federation throughout.
          </SectionSub>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
          {[
            {
              id: "id-forge-spark", cluster: "Compute cluster", color: "#e25a1c",
              icon: "fa-bolt",
              perms: [
                { res: "ADLS bronze", level: "Contributor", kind: "write" },
                { res: "ADLS silver", level: "Contributor", kind: "write" },
                { res: "ADLS gold",   level: "Contributor", kind: "write" },
                { res: "ADLS code",   level: "Contributor", kind: "write" },
                { res: "Key Vault",   level: "Secrets User", kind: "kv" },
              ],
              note: "code/ covers checkpoints/ prefix",
            },
            {
              id: "id-forge-trino", cluster: "Compute cluster", color: "#b91c1c",
              icon: "fa-table",
              perms: [
                { res: "ADLS bronze", level: "Reader", kind: "read" },
                { res: "ADLS silver", level: "Reader", kind: "read" },
                { res: "ADLS gold",   level: "Reader", kind: "read" },
                { res: "Key Vault",   level: "Secrets User", kind: "kv" },
              ],
              note: "No write access to any layer",
            },
            {
              id: "id-forge-hms", cluster: "Compute cluster", color: "#7c3aed",
              icon: "fa-sitemap",
              perms: [
                { res: "PostgreSQL",  level: "AAD Auth", kind: "db" },
                { res: "Key Vault",   level: "Secrets User", kind: "kv" },
              ],
              note: "No ADLS access — metadata only",
            },
            {
              id: "id-forge-airflow", cluster: "Orch cluster", color: "#017cee",
              icon: "fa-calendar-check",
              perms: [
                { res: "ADLS airflow-logs", level: "Contributor", kind: "write" },
                { res: "ADLS code",         level: "Reader",      kind: "read" },
                { res: "Key Vault",         level: "Secrets User", kind: "kv" },
              ],
              note: "No data layer (bronze/silver/gold) access",
            },
            {
              id: "id-forge-dq", cluster: "Compute cluster", color: "#15803d",
              icon: "fa-shield-halved",
              perms: [
                { res: "ADLS bronze", level: "Contributor", kind: "write" },
                { res: "ADLS silver", level: "Contributor", kind: "write" },
                { res: "ADLS gold",   level: "Contributor", kind: "write" },
                { res: "Key Vault",   level: "Secrets User", kind: "kv" },
              ],
              note: "Writes _dq/ output co-located with data",
            },
            {
              id: "id-forge-portal", cluster: "Orch cluster", color: "#107c10",
              icon: "fa-window-maximize",
              perms: [
                { res: "ADLS airflow-logs", level: "Reader",          kind: "read" },
                { res: "ADLS code",         level: "Contributor",     kind: "write" },
                { res: "Key Vault",         level: "Secrets Officer", kind: "kv" },
              ],
              note: "Datasets via Trino · DQ via Postgres · Lineage via Airflow DAG tags",
            },
          ].map((wi) => {
            const kindColor = (k: string) =>
              k === "write" ? { bg: "#fef3c7", fg: "#92400e", label: "Contributor" } :
              k === "read"  ? { bg: "#dbeafe", fg: "#1e40af", label: "Reader" } :
              k === "kv"    ? { bg: "#dcfce7", fg: "#15803d", label: wi.perms.find(p => p.res === "Key Vault" && p.kind === "kv")?.level ?? "KV" } :
                              { bg: "#f3e8ff", fg: "#6b21a8", label: "AAD Auth" };
            return (
              <div key={wi.id} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
                <div style={{
                  padding: "9px 13px", borderBottom: "1px solid #e2e8f0",
                  background: "#fff", display: "flex", alignItems: "center", gap: 8,
                }}>
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: `${wi.color}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <i className={`fas ${wi.icon}`} style={{ color: wi.color, fontSize: 13 }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: wi.color, fontFamily: "monospace" }}>{wi.id}</div>
                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>{wi.cluster}</div>
                  </div>
                </div>
                {wi.perms.map((p) => {
                  const c = kindColor(p.kind);
                  return (
                    <div key={p.res} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 13px", borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: "#334155" }}>{p.res}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: c.bg, color: c.fg }}>{p.level}</span>
                    </div>
                  );
                })}
                <div style={{ padding: "5px 13px", fontSize: 10, color: "#94a3b8", fontStyle: "italic" }}>{wi.note}</div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 24, padding: "12px 18px", background: "rgba(30,58,95,0.04)", borderRadius: 10, border: "1px solid rgba(30,58,95,0.08)", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <i className="fas fa-lock" style={{ color: primaryColor, fontSize: 13, flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
            All identities use <strong>Azure Workload Identity</strong> (OIDC federation) — no passwords, no client secrets,
            no SAS tokens. K8s injects a short-lived projected service account token; Azure AD exchanges it
            for a scoped access token valid for 1 hour. Each identity has a distinct blast radius.
          </span>
        </div>
      </Section>

      {/* ── 8. Get Started ───────────────────────────────────────────────────── */}
      <section
        id="start"
        style={{
          background: `linear-gradient(135deg, ${primaryColor} 0%, #0f1e2e 100%)`,
          padding: "80px 1.5rem",
        }}
      >
        <div style={{ maxWidth: 1400, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
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
              code={`bash infra/scripts/forge-up.sh \\
  --env dev \\
  --alias <your-alias>

# Full infra + secrets + K8s deploy
# (add --redeploy to skip infra on iterations)`}
            />
            <StepCard
              number={2}
              title="Author a Pipeline"
              code={`# 1. Write a manifest
forge init --name my_pipeline --layer bronze

# 2. Generate Spark job, DAG, and DQ rules
forge generate --job my_pipeline \\
  --manifest-dir src/manifests --dir .

# 3. Deploy DAG to ADLS — Airflow picks it up
FORGE_ENV="dev" OWNER_ALIAS="<your-alias>" \\
  bash infra/scripts/sync-jobs.sh \\
  --job my_pipeline`}
            />
            <StepCard
              number={3}
              title="Query Your Data"
              code={`# Spark Connect (from VS Code / Jupyter)
from pyspark.sql import SparkSession

spark = SparkSession.builder \\
  .remote("sc://forge-compute-<alias>-<env>.<region>.cloudapp.azure.com:15002") \\
  .getOrCreate()

df = spark.read.format("delta") \\
  .load("abfss://gold@<storage>/sales")
df.show()

# Trino CLI (PowerShell)
$token = az account get-access-token \\
  --resource https://management.azure.com/ \\
  --query accessToken -o tsv
trino --server=https://forge-compute-<alias>-<env>.<region>.cloudapp.azure.com \\
      --access-token="$token" --catalog=hive

# Trino UI (browser)
# https://forge-compute-<alias>-<env>.<region>.cloudapp.azure.com/ui/`}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
