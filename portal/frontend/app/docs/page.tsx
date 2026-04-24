"use client";

import React from "react";
import Link from "next/link";
import { useTheme } from "../../contexts/ThemeContext";

const CATEGORIES = [
  {
    id: "platform",
    label: "Platform",
    icon: "fa-compass-drafting",
    description: "Strategic overview and design principles — start here to understand what Forge is and why it is built the way it is.",
    docs: [
      {
        slug: "platform-brief",
        title: "Platform Brief",
        description: "One-page stakeholder summary — what Forge is, what problems it solves, and how it is structured.",
        icon: "fa-file-lines",
      },
      {
        slug: "DESIGN",
        title: "Platform Design Reference",
        description: "Full design doc — principles, two-cluster model, compute, orchestration, lakehouse, developer experience, and delivery lifecycle.",
        icon: "fa-compass-drafting",
      },
    ],
  },
  {
    id: "architecture",
    label: "Architecture",
    icon: "fa-layer-group",
    description: "Technical deep-dives into every platform component — read in sequence or jump to the area you need.",
    docs: [
      {
        slug: "architecture/01-overview",
        title: "Infrastructure Overview",
        description: "Resource groups, AKS clusters, node pools, networking, managed identities, Key Vault, observability — the complete infrastructure reference.",
        icon: "fa-building",
      },
      {
        slug: "architecture/02-rg-inventory",
        title: "Resource Group Inventory",
        description: "Every Azure resource, which RG it lives in, why it exists, and what uses it.",
        icon: "fa-list-check",
      },
      {
        slug: "architecture/03-networking",
        title: "Networking Architecture",
        description: "VNet layout, subnets, Azure CNI Overlay, private endpoints, DNS resolution, Calico network policies, and NSG rules.",
        icon: "fa-network-wired",
      },
      {
        slug: "architecture/04-security-s360",
        title: "Security & S360 Compliance",
        description: "Workload Identity (OIDC), Key Vault, Defender plans, audit logging, vulnerability management, and full S360 control mapping.",
        icon: "fa-lock",
      },
      {
        slug: "architecture/05-storage",
        title: "Storage Architecture",
        description: "Medallion lakehouse layers (Bronze/Silver/Gold/Sandbox), partitioning standards, run trackers, DQ results, and data contracts.",
        icon: "fa-database",
      },
      {
        slug: "architecture/06-compute",
        title: "Compute Architecture",
        description: "Spark Operator, Spark Connect, Trino, Hive Metastore — node pools, autoscaling, ABFS access, and cost tracking.",
        icon: "fa-microchip",
      },
      {
        slug: "architecture/07-orchestration",
        title: "Orchestration Architecture",
        description: "Airflow KubernetesExecutor, DAG delivery via ADLS, ForgeSparkOperator, ForgeDqGateOperator, and cross-DAG dependencies.",
        icon: "fa-sitemap",
      },
      {
        slug: "architecture/08-observability",
        title: "Observability Architecture",
        description: "Azure Monitor, Container Insights, Managed Grafana, Log Analytics, alert rules, dashboards, and KQL query patterns.",
        icon: "fa-chart-line",
      },
      {
        slug: "architecture/09-dq-framework",
        title: "Data Quality Framework",
        description: "Three-layer DQ engine — auto-profiling, rule-based checks (schema/content/volume/freshness), anomaly detection, and severity gating.",
        icon: "fa-shield-halved",
      },
      {
        slug: "architecture/10-lineage",
        title: "Lineage Architecture",
        description: "OpenLineage emission points, Airflow DAG source/output tag conventions, BFS multi-hop lineage graph, and upstream/downstream impact analysis.",
        icon: "fa-share-nodes",
      },
      {
        slug: "architecture/11-developer-portal",
        title: "Developer Portal Architecture",
        description: "Auth-proxy, FastAPI backend, Next.js frontend — authentication flow, API domains, caching, and deployment model.",
        icon: "fa-window-maximize",
      },
      {
        slug: "architecture/12-end-to-end-flow",
        title: "End-to-End Data Flow",
        description: "Complete walkthrough from developer code to queryable Gold data — system map, ADLS layout changes, and observability during a run.",
        icon: "fa-arrows-left-right",
      },
      {
        slug: "architecture/13-restatement",
        title: "Restatement Architecture",
        description: "Partition tracker, restatement modes, full restatement flow, and the Restatement Registry.",
        icon: "fa-rotate-left",
      },
      {
        slug: "architecture/14-environment-promotion",
        title: "Environment Promotion",
        description: "Dev vs prod, Spark Connect vs Spark Operator, developer journey, CI/CD gates, promotion checklist, and rollback strategy.",
        icon: "fa-code-branch",
      },
      {
        slug: "architecture/15-metastore",
        title: "Hive Metastore Architecture",
        description: "HMS deep-dive — PostgreSQL persistence, cross-cluster access (Spark + Trino), database structure, lineage integration, and design decisions.",
        icon: "fa-table",
      },
    ],
  },
  {
    id: "implementation",
    label: "Implementation",
    icon: "fa-wrench",
    description: "Step-by-step guides for provisioning and deploying the full platform from zero. Follow in order for initial setup; use forge-up.sh for day-to-day deploys.",
    docs: [
      {
        slug: "implementation/00-forge-up",
        title: "forge-up.sh Guide",
        description: "The primary deploy script — phases, flags, skip options, and day-to-day deploy workflow.",
        icon: "fa-rocket",
      },
      {
        slug: "implementation/01-acr-setup",
        title: "ACR Setup",
        description: "Provision Azure Container Registry, enable Defender for Containers, and configure role assignments.",
        icon: "fa-box",
      },
      {
        slug: "implementation/02-image-builds",
        title: "Image Builds",
        description: "Building and pushing custom Spark, Trino, Airflow, and Portal images to ACR.",
        icon: "fa-hammer",
      },
      {
        slug: "implementation/03-cluster-setup",
        title: "Cluster Setup",
        description: "Full Bicep environment deployment — AKS provisioning, workload identity federation, and namespace bootstrap.",
        icon: "fa-server",
      },
      {
        slug: "implementation/04-deploy-compute",
        title: "Deploy Compute Cluster",
        description: "Helm deployment of Spark Operator, Spark Connect, Trino, and Hive Metastore to the compute cluster.",
        icon: "fa-bolt",
      },
      {
        slug: "implementation/05-deploy-orchestration",
        title: "Deploy Orchestration Cluster",
        description: "Helm deployment of Airflow and the Developer Portal to the orchestration cluster.",
        icon: "fa-gears",
      },
      {
        slug: "implementation/06-cicd",
        title: "CI/CD Pipeline",
        description: "Azure DevOps pipeline definitions for infrastructure provisioning and application deployments.",
        icon: "fa-code-branch",
      },
      {
        slug: "implementation/components-versions",
        title: "Components & Versions",
        description: "Version matrix for all platform components — Spark, Trino, Airflow, HMS, Portal, and upgrade policy.",
        icon: "fa-table-list",
      },
      {
        slug: "implementation/networking-reference",
        title: "Networking Reference",
        description: "VNet provisioning reference — subnet CIDRs, NSG rules, private DNS zones, and route tables.",
        icon: "fa-network-wired",
      },
    ],
  },
  {
    id: "guides",
    label: "Guides",
    icon: "fa-book-open",
    description: "Hands-on guides for data engineers working on the platform day-to-day.",
    docs: [
      {
        slug: "guides/developer-experience",
        title: "Developer Experience Guide",
        description: "Cluster access, VS Code + Spark Connect setup, Airflow DAG development, DQ rule authoring, Git workflow, debugging, and forge-cli reference.",
        icon: "fa-code",
      },
    ],
  },
  {
    id: "runbooks",
    label: "Runbooks",
    icon: "fa-triangle-exclamation",
    description: "On-call incident response guides — severity-rated procedures for the most common platform failures.",
    docs: [
      {
        slug: "runbooks/README",
        title: "Runbook Index",
        description: "Quick-reference index of all runbooks, severity ratings, general first steps, and key resource names for on-call.",
        icon: "fa-list",
      },
      {
        slug: "runbooks/01-airflow-down",
        title: "Airflow Down (P1/P2)",
        description: "Scheduler crash, database connectivity failures, and git-sync issues — step-by-step triage and recovery.",
        icon: "fa-calendar-check",
      },
      {
        slug: "runbooks/02-dq-failure",
        title: "DQ Gate Failure (P2/P3)",
        description: "Critical rule failures blocking pipeline progression — root cause triage, rule calibration, and unblocking procedures.",
        icon: "fa-shield-halved",
      },
      {
        slug: "runbooks/03-adls-connectivity",
        title: "ADLS Connectivity (P1)",
        description: "403 errors, role assignment issues, workload identity failures, and private endpoint connectivity problems.",
        icon: "fa-database",
      },
      {
        slug: "runbooks/04-post-deploy-verification",
        title: "Post-Deploy Verification",
        description: "8-step checklist to verify a successful deployment — portal, Airflow, Spark, Trino, DQ, and lineage.",
        icon: "fa-circle-check",
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
        <div style={{ maxWidth: 1400, margin: "0 auto", padding: "0 1.5rem" }}>
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
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "48px 1.5rem 64px" }}>
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
