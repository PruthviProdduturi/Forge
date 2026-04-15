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
export function PageLayout({ icon, title, subtitle, heroContent, children }: PageLayoutProps) {
  return (
    <div style={{ minHeight: "100%" }}>
      {/* ── Hero ── */}
      <div style={{
        background: "linear-gradient(135deg, var(--forge-primary) 0%, var(--forge-dark) 100%)",
        padding: "56px 1.5rem 52px",
      }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 11,
              background: "rgba(255,255,255,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <i className={`fas ${icon}`} style={{ color: "#fff", fontSize: 18 }} />
            </div>
            <h1 style={{
              fontSize: "clamp(1.8rem, 4vw, 2.8rem)",
              fontWeight: 800,
              color: "#fff",
              margin: 0,
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
            }}>
              {title}
            </h1>
          </div>
          {subtitle && (
            <p style={{ color: "rgba(255,255,255,0.7)", margin: 0, fontSize: 15, maxWidth: 600, lineHeight: 1.6 }}>
              {subtitle}
            </p>
          )}
          {heroContent && (
            <div style={{ marginTop: 20 }}>
              {heroContent}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 1.5rem 60px" }}>
        {children}
      </div>
    </div>
  );
}
