"use client";

export default function DatasetsPage() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: 24,
        padding: "2rem",
      }}
    >
      <div style={{ fontSize: 64, opacity: 0.15 }}>
        <i className="fas fa-database" aria-hidden="true" />
      </div>
      <div>
        <h1
          style={{
            fontSize: "2rem",
            fontWeight: 800,
            color: "#0f172a",
            textAlign: "center",
            marginBottom: 12,
          }}
        >
          Dataset Catalog
        </h1>
        <p
          style={{
            color: "#64748b",
            textAlign: "center",
            maxWidth: 480,
            lineHeight: 1.7,
          }}
        >
          Discover and explore datasets across Bronze, Silver, and Gold layers
          with schema, lineage, and quality metrics.
        </p>
      </div>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 20px",
          borderRadius: 20,
          background: "var(--forge-primary, #1e3a5f)14",
          border: "1px solid var(--forge-primary, #1e3a5f)30",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--forge-primary, #1e3a5f)",
        }}
      >
        <i className="fas fa-clock" style={{ fontSize: 12 }} aria-hidden="true" />
        Coming Soon
      </div>
    </div>
  );
}
