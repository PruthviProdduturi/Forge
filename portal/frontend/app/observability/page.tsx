"use client";

import { PageLayout } from "../../components/PageLayout";

export default function ObservabilityPage() {
  return (
    <PageLayout
      icon="fa-chart-line"
      title="Observability"
      subtitle="Platform health, cluster metrics, and infrastructure monitoring"
    >
      <div style={{ maxWidth: 500, margin: "60px auto 0", textAlign: "center" }}>
        <div style={{ width: 72, height: 72, borderRadius: 18, background: "rgba(var(--forge-primary-rgb),0.08)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <i className="fas fa-chart-line" style={{ fontSize: 28, color: "var(--forge-primary)", opacity: 0.5 }} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>Coming Soon</div>
        <div style={{ fontSize: 14, color: "#94a3b8", lineHeight: 1.6 }}>
          Grafana dashboards, Azure Monitor metrics, and platform log integration are on the roadmap.
        </div>
      </div>
    </PageLayout>
  );
}
