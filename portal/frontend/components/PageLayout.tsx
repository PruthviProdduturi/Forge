"use client";

import { ReactNode } from "react";

interface PageLayoutProps {
  /** FontAwesome icon class e.g. "fa-sitemap" */
  icon: string;
  title: string;
  subtitle?: string;
  /** Optional stat pills / controls rendered inside the hero below the subtitle */
  heroContent?: ReactNode;
  children: ReactNode;
  /**
   * When true the page outer div uses height:100% + flex-column so the content
   * area fills exactly the remaining viewport (no whole-page scroll).
   * Each child is responsible for its own overflow/scroll.
   */
  fullHeight?: boolean;
}

/**
 * Shared page shell — ensures every page has an identical hero height,
 * gradient, icon/title treatment, and scroll behaviour.
 *
 * Usage:
 *   <PageLayout icon="fa-sitemap" title="Pipelines" subtitle="Monitor your pipelines">
 *     {content}
 *   </PageLayout>
 */
export function PageLayout({ icon, title, subtitle, heroContent, children, fullHeight }: PageLayoutProps) {
  return (
    <div style={fullHeight ? { display: "flex", flexDirection: "column", height: "100%" } : { minHeight: "100%" }}>
      {/* ── Hero ── */}
      <div style={{
        background: "linear-gradient(135deg, var(--forge-primary) 0%, var(--forge-dark) 100%)",
        padding: "48px 1.5rem 48px",
      }}>
        <div style={{ maxWidth: 1400, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: "rgba(255,255,255,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <i className={`fas ${icon}`} style={{ color: "#fff", fontSize: 17 }} />
            </div>
            <h1 style={{
              fontSize: "2rem",
              fontWeight: 800,
              color: "#fff",
              margin: 0,
              letterSpacing: "-0.02em",
              lineHeight: 1.2,
            }}>
              {title}
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.7)", margin: "0 0 0 54px", fontSize: 14, maxWidth: 560, lineHeight: 1.6 }}>
            {subtitle ?? ""}
          </p>
          {/* Always reserve heroContent height so all pages share identical hero height */}
          <div style={{ marginTop: 20, minHeight: 36, marginLeft: 54 }}>
            {heroContent}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={fullHeight
        ? { flex: 1, overflow: "hidden", maxWidth: 1400, width: "100%", margin: "0 auto", padding: "16px 1.5rem 24px", boxSizing: "border-box" }
        : { maxWidth: 1400, margin: "0 auto", padding: "28px 1.5rem 60px" }}>
        {children}
      </div>
    </div>
  );
}
