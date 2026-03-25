"use client";

import React from "react";
import Link from "next/link";
import { useTheme } from "../../contexts/ThemeContext";

const CATEGORIES = [
  {
    id: "design",
    label: "Design Reference",
    icon: "fa-compass-drafting",
    description: "The single document that explains what Forge is, how it is designed, and where to go for more detail.",
    docs: [
      {
        slug: "DESIGN",
        title: "Platform Design Reference",
        description: "Principles, two-cluster model, compute, orchestration, lakehouse, developer experience, delivery lifecycle, and full deep-dive index.",
        icon: "fa-compass-drafting",
      },
    ],
  },
  {
    id: "architecture",
    label: "Architecture",
    icon: "fa-layer-group",
    description: "Platform design, component diagrams, and technical deep-dives.",
    docs: [
      {
        slug: "architecture/end-to-end-flow",
        title: "End-to-End Flow",
        description: "Full platform data flow from raw ingestion through bronze, silver, and gold layers to consumers.",
        icon: "fa-arrows-left-right",
      },
      {
        slug: "architecture/environment-promotion",
        title: "Environment Promotion & Dev→Prod Flow",
        description: "Dev vs prod environments, Spark Connect vs Spark Operator, PR workflow, CI/CD gates, and rollback strategy.",
        icon: "fa-code-branch",
      },
      {
        slug: "architecture/compute-architecture",
        title: "Compute Architecture",
        description: "Spark Operator, Spark Connect, and Trino on AKS — node pools, scaling, and job isolation.",
        icon: "fa-microchip",
      },
      {
        slug: "architecture/networking-architecture",
        title: "Networking Architecture",
        description: "VNets, subnets, private endpoints, DNS, and network isolation across clusters.",
        icon: "fa-network-wired",
      },
      {
        slug: "architecture/storage-architecture",
        title: "Storage Architecture",
        description: "ADLS Gen2 layout, Delta Lake integration, and medallion zone access patterns.",
        icon: "fa-database",
      },
      {
        slug: "architecture/orchestration-architecture",
        title: "Orchestration Architecture",
        description: "Airflow scheduler design, DAG execution model, and cross-cluster job submission.",
        icon: "fa-sitemap",
      },
      {
        slug: "architecture/dq-framework",
        title: "Data Quality Framework",
        description: "Rule-based DQ engine, YAML rulesets, validation checks, and failure routing.",
        icon: "fa-shield-halved",
      },
      {
        slug: "architecture/lineage-architecture",
        title: "Lineage Architecture",
        description: "OpenLineage integration, Marquez deployment, and dataset-level lineage tracking.",
        icon: "fa-share-nodes",
      },
      {
        slug: "architecture/observability-architecture",
        title: "Observability Architecture",
        description: "Metrics, logs, and alerting — Azure Monitor, Container Insights, and Grafana.",
        icon: "fa-chart-line",
      },
      {
        slug: "architecture/security-s360",
        title: "Security (S360)",
        description: "Managed identity, RBAC, Key Vault, private networking, and compliance controls.",
        icon: "fa-lock",
      },
      {
        slug: "architecture/developer-portal-architecture",
        title: "Developer Portal Architecture",
        description: "FastAPI backend and Next.js frontend design for the Forge developer portal.",
        icon: "fa-window-maximize",
      },
      {
        slug: "architecture/restatement-architecture",
        title: "Restatement Architecture",
        description: "Data restatement patterns, backfill strategy, and partition-level recovery.",
        icon: "fa-rotate-left",
      },
    ],
  },
  {
    id: "implementation",
    label: "Implementation",
    icon: "fa-wrench",
    description: "Step-by-step guides for provisioning and deploying the full platform.",
    docs: [
      {
        slug: "implementation/00-overview",
        title: "Platform Overview",
        description: "Deployment order, prerequisites, and the end-to-end provisioning checklist.",
        icon: "fa-list-check",
      },
      {
        slug: "implementation/01-acr-setup",
        title: "ACR Setup",
        description: "Provision Azure Container Registry, enable geo-replication, and push base images.",
        icon: "fa-box",
      },
      {
        slug: "implementation/02-image-builds",
        title: "Image Builds",
        description: "Building and tagging Spark, Airflow, and custom platform images for AKS.",
        icon: "fa-hammer",
      },
      {
        slug: "implementation/03-cluster-setup",
        title: "Cluster Setup",
        description: "AKS cluster provisioning, node pool configuration, and add-on enablement.",
        icon: "fa-server",
      },
      {
        slug: "implementation/04-deploy-compute",
        title: "Deploy Compute",
        description: "Helm-based deployment of Spark Operator, Spark Connect, and Trino to the compute cluster.",
        icon: "fa-rocket",
      },
      {
        slug: "implementation/05-deploy-orchestration",
        title: "Deploy Orchestration",
        description: "Deploying Airflow, Marquez, and the observability stack to the orchestration cluster.",
        icon: "fa-gears",
      },
      {
        slug: "implementation/06-cicd",
        title: "CI/CD Pipeline",
        description: "Azure DevOps pipeline definitions for infrastructure and application deployments.",
        icon: "fa-code-branch",
      },
      {
        slug: "implementation/components-versions",
        title: "Components & Versions",
        description: "Version matrix for all platform components — Spark, Trino, Airflow, Marquez, and more.",
        icon: "fa-table-list",
      },
    ],
  },
  {
    id: "guides",
    label: "Guides",
    icon: "fa-book-open",
    description: "Hands-on guides for data engineers and platform engineers.",
    docs: [
      {
        slug: "guides/developer-experience",
        title: "Developer Experience Guide",
        description: "Local development setup, Spark Connect, VS Code integration, and day-to-day workflows.",
        icon: "fa-code",
      },
    ],
  },
];

export default function DocsPage() {
  const { primaryColor } = useTheme();

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      {/* Hero */}
      <div
        style={{
          background: `linear-gradient(135deg, ${primaryColor} 0%, ${primaryColor}cc 100%)`,
          padding: "56px 0 48px",
        }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 1.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: "rgba(255,255,255,0.2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <i className="fas fa-book" style={{ color: "#fff", fontSize: 20 }} aria-hidden="true" />
            </div>
            <h1 style={{ fontSize: "2rem", fontWeight: 800, color: "#fff", margin: 0, letterSpacing: "-0.02em" }}>
              Forge Docs
            </h1>
          </div>
          <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "1.05rem", maxWidth: 560, margin: 0, lineHeight: 1.7 }}>
            Architecture references, implementation guides, and developer resources for the Forge data platform.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
            {CATEGORIES.map((cat) => (
              <a
                key={cat.id}
                href={`#${cat.id}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "6px 14px",
                  borderRadius: 20,
                  background: "rgba(255,255,255,0.15)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: "none",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.25)")
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.15)")
                }
              >
                <i className={`fas ${cat.icon}`} style={{ fontSize: 11 }} aria-hidden="true" />
                {cat.label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Categories */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 1.5rem 64px" }}>
        {CATEGORIES.map((cat) => (
          <section key={cat.id} id={cat.id} style={{ marginBottom: 56 }}>
            {/* Category header */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: `${primaryColor}18`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <i className={`fas ${cat.icon}`} style={{ color: primaryColor, fontSize: 15 }} aria-hidden="true" />
              </div>
              <h2
                style={{
                  fontSize: "1.25rem",
                  fontWeight: 800,
                  color: "#0f172a",
                  margin: 0,
                  letterSpacing: "-0.01em",
                }}
              >
                {cat.label}
              </h2>
              <span
                style={{
                  padding: "2px 10px",
                  borderRadius: 12,
                  background: `${primaryColor}12`,
                  border: `1px solid ${primaryColor}25`,
                  fontSize: 12,
                  fontWeight: 700,
                  color: primaryColor,
                }}
              >
                {cat.docs.length}
              </span>
            </div>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 20, marginLeft: 48 }}>
              {cat.description}
            </p>

            {/* Doc cards */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                gap: 14,
              }}
            >
              {cat.docs.map((doc) => (
                <Link
                  key={doc.slug}
                  href={`/docs/${doc.slug}`}
                  style={{ textDecoration: "none" }}
                >
                  <div
                    style={{
                      background: "#fff",
                      border: "1px solid #e2e8f0",
                      borderRadius: 10,
                      padding: "1.125rem 1.25rem",
                      display: "flex",
                      gap: 14,
                      alignItems: "flex-start",
                      cursor: "pointer",
                      transition: "box-shadow 0.15s, border-color 0.15s, transform 0.1s",
                      height: "100%",
                      boxSizing: "border-box",
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLDivElement;
                      el.style.boxShadow = `0 4px 20px ${primaryColor}18`;
                      el.style.borderColor = `${primaryColor}50`;
                      el.style.transform = "translateY(-1px)";
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLDivElement;
                      el.style.boxShadow = "none";
                      el.style.borderColor = "#e2e8f0";
                      el.style.transform = "translateY(0)";
                    }}
                  >
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 8,
                        background: `${primaryColor}12`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    >
                      <i
                        className={`fas ${doc.icon}`}
                        style={{ color: primaryColor, fontSize: 13 }}
                        aria-hidden="true"
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: "#0f172a",
                          marginBottom: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <span>{doc.title}</span>
                        <i
                          className="fas fa-arrow-right"
                          style={{ color: "#94a3b8", fontSize: 11, flexShrink: 0 }}
                          aria-hidden="true"
                        />
                      </div>
                      <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
                        {doc.description}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
