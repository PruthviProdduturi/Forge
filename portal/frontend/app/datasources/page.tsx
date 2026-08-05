"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { apiFetch } from "../../utils/api";
import { PageLayout } from "../../components/PageLayout";
import { ForgeLoader } from "../../components/ForgeLoader";
import { BackendStatus } from "../../components/BackendStatus";

const ACCENT = "var(--forge-primary)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceType = "adls_gen2" | "adx";

interface DataSource {
  id: string;
  name: string;
  display_name: string;
  description: string;
  source_type: SourceType;
  config: Record<string, string>;
  auth_type: string;
  credential_kv_secret: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface FormState {
  name: string;
  display_name: string;
  description: string;
  source_type: SourceType;
  // ADLS Gen2 fields
  adls_account: string;
  adls_container: string;
  adls_base_path: string;
  adls_format: string;
  // ADX fields
  adx_cluster_uri: string;
  adx_database: string;
  adx_client_id: string;
  // Shared
  auth_type: string;
  credential_kv_secret: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  display_name: "",
  description: "",
  source_type: "adls_gen2",
  adls_account: "",
  adls_container: "",
  adls_base_path: "",
  adls_format: "parquet",
  adx_cluster_uri: "",
  adx_database: "",
  adx_client_id: "",
  auth_type: "managed_identity",
  credential_kv_secret: "",
};

function formToPayload(f: FormState) {
  const config =
    f.source_type === "adls_gen2"
      ? {
          account: f.adls_account,
          container: f.adls_container,
          base_path: f.adls_base_path,
          format: f.adls_format,
        }
      : {
          cluster_uri: f.adx_cluster_uri,
          database: f.adx_database,
          client_id: f.adx_client_id,
        };
  return {
    name: f.name,
    display_name: f.display_name,
    description: f.description,
    source_type: f.source_type,
    config,
    auth_type: f.auth_type,
    credential_kv_secret: f.credential_kv_secret || null,
  };
}

function sourceToForm(ds: DataSource): FormState {
  const c = ds.config;
  return {
    name: ds.name,
    display_name: ds.display_name,
    description: ds.description,
    source_type: ds.source_type,
    adls_account: c.account ?? "",
    adls_container: c.container ?? "",
    adls_base_path: c.base_path ?? "",
    adls_format: c.format ?? "parquet",
    adx_cluster_uri: c.cluster_uri ?? "",
    adx_database: c.database ?? "",
    adx_client_id: c.client_id ?? "",
    auth_type: ds.auth_type,
    credential_kv_secret: ds.credential_kv_secret ?? "",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function TypeBadge({ type }: { type: SourceType }) {
  const styles: Record<SourceType, { bg: string; color: string; label: string; icon: string }> = {
    adls_gen2: { bg: "#e0f2fe", color: "#0284c7", label: "ADLS Gen2", icon: "fa-layer-group" },
    adx: { bg: "#f3e8ff", color: "#7c3aed", label: "Azure Data Explorer", icon: "fa-chart-bar" },
  };
  const s = styles[type];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 600,
      background: s.bg, color: s.color,
    }}>
      <i className={`fas ${s.icon}`} style={{ fontSize: 10 }} />
      {s.label}
    </span>
  );
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
        {label}{required && <span style={{ color: "#ef4444", marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#0f172a",
  background: "#fff", boxSizing: "border-box", outline: "none",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle, cursor: "pointer", appearance: "none",
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center",
  paddingRight: 30,
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface ModalProps {
  editing: DataSource | null;
  onClose: () => void;
  onSaved: (ds: DataSource) => void;
  getToken: () => Promise<string | null>;
}

interface TestResult {
  ok: boolean;
  message: string;
  detail?: string;
}

function DataSourceModal({ editing, onClose, onSaved, getToken }: ModalProps) {
  const [form, setForm] = useState<FormState>(editing ? sourceToForm(editing) : EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<FormState>) => {
    setTestResult(null); // clear test result when form changes
    setForm(f => ({ ...f, ...patch }));
  };

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const payload = formToPayload(form);
      const result = await apiFetch<TestResult>("/api/v1/datasources/test", getToken, {
        method: "POST",
        body: JSON.stringify({
          source_type: payload.source_type,
          config: payload.config,
          auth_type: payload.auth_type,
          credential_kv_secret: payload.credential_kv_secret,
        }),
      });
      setTestResult(result);
    } catch (err: unknown) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = formToPayload(form);
      const url = editing ? `/api/v1/datasources/${editing.id}` : "/api/v1/datasources";
      const method = editing ? "PUT" : "POST";
      const result = await apiFetch<DataSource>(url, getToken, {
        method,
        body: JSON.stringify(payload),
      });
      onSaved(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: 16,
    }}>
      <div style={{
        background: "#fff", borderRadius: 16, width: "100%", maxWidth: 580,
        maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
      }}>
        {/* Header */}
        <div style={{
          background: "linear-gradient(135deg, var(--forge-primary) 0%, var(--forge-dark) 100%)",
          padding: "20px 24px", borderRadius: "16px 16px 0 0",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <i className="fas fa-plug" style={{ color: "rgba(255,255,255,0.8)", fontSize: 16 }} />
            <span style={{ color: "#fff", fontWeight: 700, fontSize: 17 }}>
              {editing ? "Edit Data Source" : "Register Data Source"}
            </span>
          </div>
          <button onClick={onClose} style={{
            background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8,
            color: "#fff", width: 32, height: 32, cursor: "pointer", fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <i className="fas fa-xmark" />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "24px" }}>
          {error && (
            <div style={{
              background: "#fff1f2", border: "1px solid #fca5a5", borderRadius: 8,
              padding: "10px 14px", marginBottom: 16, color: "#dc2626", fontSize: 13,
            }}>
              <i className="fas fa-circle-exclamation" style={{ marginRight: 8 }} />
              {error}
            </div>
          )}

          {/* Source type selector (disabled when editing) */}
          <Field label="Source Type" required>
            <div style={{ display: "flex", gap: 10 }}>
              {([["adls_gen2", "fa-layer-group", "ADLS Gen2"], ["adx", "fa-chart-bar", "Azure Data Explorer"]] as const).map(
                ([val, icon, label]) => (
                  <button
                    key={val}
                    type="button"
                    disabled={!!editing}
                    onClick={() => set({ source_type: val as SourceType })}
                    style={{
                      flex: 1, padding: "10px 14px", borderRadius: 10, cursor: editing ? "not-allowed" : "pointer",
                      border: `2px solid ${form.source_type === val ? "var(--forge-primary)" : "#e2e8f0"}`,
                      background: form.source_type === val ? "var(--forge-primary, #1e3a5f)10" : "#f8fafc",
                      color: form.source_type === val ? "var(--forge-primary)" : "#64748b",
                      fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center",
                      gap: 8, transition: "all 0.15s", opacity: editing ? 0.6 : 1,
                    }}
                  >
                    <i className={`fas ${icon}`} />
                    {label}
                  </button>
                )
              )}
            </div>
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Field label="Source Name (slug)" required>
              <input
                value={form.name}
                onChange={e => set({ name: e.target.value })}
                placeholder="sales-raw"
                required
                disabled={!!editing}
                pattern="^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$"
                title="Lowercase letters, numbers, hyphens only"
                style={{ ...inputStyle, opacity: editing ? 0.6 : 1 }}
              />
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                Used in pipeline params. Lowercase, hyphens only.
              </div>
            </Field>
            <Field label="Display Name" required>
              <input
                value={form.display_name}
                onChange={e => set({ display_name: e.target.value })}
                placeholder="Sales Raw Zone"
                required
                style={inputStyle}
              />
            </Field>
          </div>

          <Field label="Description">
            <input
              value={form.description}
              onChange={e => set({ description: e.target.value })}
              placeholder="Brief description of this data source"
              style={inputStyle}
            />
          </Field>

          {/* ADLS Gen2 fields */}
          {form.source_type === "adls_gen2" && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
                color: "#94a3b8", marginBottom: 12, marginTop: 4,
              }}>
                ADLS Gen2 Configuration
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <Field label="Storage Account" required>
                  <input
                    value={form.adls_account}
                    onChange={e => set({ adls_account: e.target.value })}
                    placeholder="forgeadlsprproddudev"
                    required
                    style={inputStyle}
                  />
                </Field>
                <Field label="Container" required>
                  <input
                    value={form.adls_container}
                    onChange={e => set({ adls_container: e.target.value })}
                    placeholder="raw"
                    required
                    style={inputStyle}
                  />
                </Field>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <Field label="Base Path">
                  <input
                    value={form.adls_base_path}
                    onChange={e => set({ adls_base_path: e.target.value })}
                    placeholder="/sales/orders"
                    style={inputStyle}
                  />
                </Field>
                <Field label="Format" required>
                  <select
                    value={form.adls_format}
                    onChange={e => set({ adls_format: e.target.value })}
                    style={selectStyle}
                  >
                    {["parquet", "delta", "csv", "json", "avro"].map(f => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          )}

          {/* ADX fields */}
          {form.source_type === "adx" && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
                color: "#94a3b8", marginBottom: 12, marginTop: 4,
              }}>
                Azure Data Explorer Configuration
              </div>
              <Field label="Cluster URI" required>
                <input
                  value={form.adx_cluster_uri}
                  onChange={e => set({ adx_cluster_uri: e.target.value })}
                  placeholder="https://mycluster.westcentralus.kusto.windows.net"
                  required
                  style={inputStyle}
                />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <Field label="Database" required>
                  <input
                    value={form.adx_database}
                    onChange={e => set({ adx_database: e.target.value })}
                    placeholder="SalesDB"
                    required
                    style={inputStyle}
                  />
                </Field>
                <Field label="Client ID (App Registration)">
                  <input
                    value={form.adx_client_id}
                    onChange={e => set({ adx_client_id: e.target.value })}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    style={inputStyle}
                  />
                </Field>
              </div>
            </>
          )}

          {/* Auth */}
          <div style={{
            fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
            color: "#94a3b8", marginBottom: 12, marginTop: 4,
          }}>
            Authentication
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Field label="Auth Type" required>
              <select
                value={form.auth_type}
                onChange={e => set({ auth_type: e.target.value })}
                style={selectStyle}
              >
                <option value="managed_identity">Managed Identity</option>
                <option value="service_principal">Service Principal</option>
                <option value="sas_token">SAS Token</option>
              </select>
            </Field>
            <Field label="Key Vault Secret Name">
              <input
                value={form.credential_kv_secret}
                onChange={e => set({ credential_kv_secret: e.target.value })}
                placeholder="forge-ds-sales-raw-secret"
                style={inputStyle}
              />
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                Leave blank for managed identity. Name only — secret value stays in KV.
              </div>
            </Field>
          </div>

          {/* Test result banner */}
          {testResult && (
            <div style={{
              background: testResult.ok ? "#f0fdf4" : "#fff1f2",
              border: `1px solid ${testResult.ok ? "#86efac" : "#fca5a5"}`,
              borderRadius: 8, padding: "10px 14px", marginTop: 4,
              color: testResult.ok ? "#16a34a" : "#dc2626", fontSize: 13,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i className={`fas ${testResult.ok ? "fa-circle-check" : "fa-circle-xmark"}`} />
                <strong>{testResult.message}</strong>
              </div>
              {testResult.detail && (
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>{testResult.detail}</div>
              )}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 12 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db",
                background: "#fff", color: "#374151", fontWeight: 600, fontSize: 14, cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || saving}
              style={{
                padding: "9px 18px", borderRadius: 8,
                border: "1px solid #6366f1",
                background: testing ? "#e0e7ff" : "#fff",
                color: "#6366f1", fontWeight: 600, fontSize: 14,
                cursor: testing || saving ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <i className={`fas ${testing ? "fa-spinner fa-spin" : "fa-plug-circle-check"}`} />
              {testing ? "Testing…" : "Test Connection"}
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "9px 22px", borderRadius: 8, border: "none",
                background: saving ? "#94a3b8" : ACCENT, color: "#fff",
                fontWeight: 700, fontSize: 14, cursor: saving ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <i className={`fas ${saving ? "fa-spinner fa-spin" : editing ? "fa-floppy-disk" : "fa-plus"}`} />
              {saving ? "Saving…" : editing ? "Save Changes" : "Register Source"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

function DeleteModal({ ds, onClose, onDeleted, getToken }: {
  ds: DataSource;
  onClose: () => void;
  onDeleted: (id: string) => void;
  getToken: () => Promise<string | null>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/datasources/${ds.id}`, getToken, { method: "DELETE" });
      onDeleted(ds.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100,
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, width: "100%", maxWidth: 420,
        padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: "#fee2e2",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <i className="fas fa-trash" style={{ color: "#dc2626", fontSize: 16 }} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a" }}>Delete Data Source</div>
            <div style={{ fontSize: 13, color: "#64748b" }}>This action cannot be undone</div>
          </div>
        </div>
        <p style={{ fontSize: 14, color: "#374151", margin: "0 0 20px" }}>
          Remove <strong>{ds.display_name}</strong> (<code style={{ fontSize: 12 }}>{ds.name}</code>)?
          Any pipelines referencing this source by name will need to be updated.
        </p>
        {error && (
          <div style={{ background: "#fff1f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 12px", marginBottom: 14, color: "#dc2626", fontSize: 13 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer", color: "#374151" }}>
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              padding: "8px 18px", borderRadius: 8, border: "none",
              background: deleting ? "#94a3b8" : "#dc2626", color: "#fff",
              fontWeight: 700, fontSize: 14, cursor: deleting ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: 7,
            }}
          >
            <i className={`fas ${deleting ? "fa-spinner fa-spin" : "fa-trash"}`} />
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DataSourcesPage() {
  const { getToken } = useAuth();
  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [deleting, setDeleting] = useState<DataSource | null>(null);
  const [search, setSearch] = useState("");
  const [activeType, setActiveType] = useState<"all" | "adls_gen2" | "adx">("all");

  useEffect(() => {
    apiFetch<DataSource[]>("/api/v1/datasources", getToken)
      .then(setSources)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [getToken]);

  const filtered = sources
    .filter(s => activeType === "all" || s.source_type === activeType)
    .filter(s => !search.trim() ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.display_name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase())
    );

  const handleSaved = useCallback((ds: DataSource) => {
    setSources(prev => {
      const idx = prev.findIndex(s => s.id === ds.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = ds;
        return next;
      }
      return [...prev, ds];
    });
    setModalOpen(false);
    setEditing(null);
  }, []);

  const handleDeleted = useCallback((id: string) => {
    setSources(prev => prev.filter(s => s.id !== id));
    setDeleting(null);
  }, []);

  const adlsCount = sources.filter(s => s.source_type === "adls_gen2").length;
  const adxCount = sources.filter(s => s.source_type === "adx").length;

  const heroContent = (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      {[
        { label: "Total", value: loading ? "—" : sources.length, icon: "fa-plug" },
        { label: "ADLS Gen2", value: loading ? "—" : adlsCount, icon: "fa-layer-group" },
        { label: "Kusto", value: loading ? "—" : adxCount, icon: "fa-chart-bar" },
      ].map(s => (
        <div key={s.label} style={{
          background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 10, padding: "8px 18px", display: "flex", alignItems: "center", gap: 8,
        }}>
          <i className={`fas ${s.icon}`} style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }} />
          <span style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{s.value}</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600 }}>{s.label}</span>
        </div>
      ))}
    </div>
  );

  return (
    <PageLayout
      icon="fa-plug"
      title="Data Sources"
      subtitle="Manage registered data sources for bronze ingestion"
      heroContent={heroContent}
    >
        {/* Toolbar */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 4 }}>
            {([["all", "All"], ["adls_gen2", "ADLS Gen2"], ["adx", "Kusto"]] as const).map(([val, label]) => (
              <button key={val} onClick={() => setActiveType(val)} style={{
                padding: "5px 14px", borderRadius: 7, border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 600,
                background: activeType === val ? "var(--forge-primary)" : "transparent",
                color: activeType === val ? "#fff" : "#64748b",
              }}>{label}</button>
            ))}
          </div>
          <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 360 }}>
            <i className="fas fa-magnifying-glass" style={{
              position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
              color: "#94a3b8", fontSize: 14,
            }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sources…"
              style={{
                width: "100%", padding: "9px 14px 9px 40px", borderRadius: 10,
                border: "1px solid #e2e8f0", fontSize: 14, background: "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)", outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <button
            onClick={() => { setEditing(null); setModalOpen(true); }}
            style={{
              padding: "10px 20px", borderRadius: 10, border: "none",
              background: ACCENT, color: "#fff", fontWeight: 700, fontSize: 14,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            }}
          >
            <i className="fas fa-plus" />
            Register Source
          </button>
        </div>

        <div style={{ background: "#fff", border: `1px solid ${error ? "#e2e8f0" : "#e2e8f0"}`, borderTop: `3px solid ${ACCENT}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
          {loading && <ForgeLoader text="Loading data sources…" fullscreen={false} />}

          {error && <BackendStatus error={error} feature="Data Sources" />}

          {!loading && !error && (<>
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "#94a3b8" }}>
              {search || activeType !== "all" ? "No sources match your filters" : "No data sources registered yet"}
            </div>
          ) : (<>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                  {["Source", "Type", "Connection Details", "Auth", "Registered By", ""].map(h => (
                    <th key={h} style={{
                      padding: "10px 16px", textAlign: "left",
                      fontSize: 11, fontWeight: 700, color: "#94a3b8",
                      textTransform: "uppercase", letterSpacing: "0.07em",
                      whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((ds, idx) => (
                  <tr
                    key={ds.id}
                    style={{
                      borderBottom: idx < filtered.length - 1 ? "1px solid #f8fafc" : "none",
                      background: idx % 2 === 0 ? "#fff" : "#fafbfc",
                    }}
                  >
                    <td style={{ padding: "14px 16px" }}>
                      <div style={{ fontWeight: 700, color: "#0f172a", fontSize: 14 }}>{ds.display_name}</div>
                      <div style={{ fontFamily: "monospace", fontSize: 12, color: "#7c3aed", marginTop: 2 }}>
                        {ds.name}
                      </div>
                      {ds.description && (
                        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{ds.description}</div>
                      )}
                    </td>
                    <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                      <TypeBadge type={ds.source_type} />
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 12, color: "#374151" }}>
                      {ds.source_type === "adls_gen2" ? (
                        <div style={{ fontFamily: "monospace", lineHeight: 1.7 }}>
                          <div><span style={{ color: "#94a3b8" }}>account:</span> {ds.config.account}</div>
                          <div><span style={{ color: "#94a3b8" }}>container:</span> {ds.config.container}</div>
                          {ds.config.base_path && <div><span style={{ color: "#94a3b8" }}>path:</span> {ds.config.base_path}</div>}
                          <div><span style={{ color: "#94a3b8" }}>format:</span> {ds.config.format}</div>
                        </div>
                      ) : (
                        <div style={{ fontFamily: "monospace", lineHeight: 1.7 }}>
                          <div style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <span style={{ color: "#94a3b8" }}>cluster:</span> {ds.config.cluster_uri}
                          </div>
                          <div><span style={{ color: "#94a3b8" }}>db:</span> {ds.config.database}</div>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        background: "#f1f5f9", padding: "2px 9px", borderRadius: 10,
                        fontSize: 11, fontWeight: 600, color: "#475569",
                      }}>
                        <i className={`fas ${ds.auth_type === "managed_identity" ? "fa-id-card" : "fa-key"}`} style={{ fontSize: 10 }} />
                        {ds.auth_type === "managed_identity" ? "Managed Identity" : ds.auth_type === "service_principal" ? "Service Principal" : "SAS Token"}
                      </span>
                      {ds.credential_kv_secret && (
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3, fontFamily: "monospace" }}>
                          <i className="fas fa-vault" style={{ marginRight: 4, fontSize: 10 }} />
                          {ds.credential_kv_secret}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>
                      {ds.created_by}
                    </td>
                    <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => { setEditing(ds); setModalOpen(true); }}
                          title="Edit"
                          style={{
                            padding: "5px 10px", borderRadius: 7, border: `1px solid ${ACCENT}`,
                            background: "transparent", color: ACCENT,
                            fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                          }}
                        >
                          <i className="fas fa-pen" style={{ fontSize: 10 }} />
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleting(ds)}
                          title="Delete"
                          style={{
                            padding: "5px 10px", borderRadius: 7, border: "1px solid #fca5a5",
                            background: "transparent", color: "#dc2626",
                            fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                          }}
                        >
                          <i className="fas fa-trash" style={{ fontSize: 10 }} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>)}
        </>)}
        </div>

        {/* Usage hint */}
        {!loading && sources.length > 0 && (
          <div style={{
            marginTop: 24, background: "#f0f9ff", border: "1px solid #bae6fd",
            borderRadius: 10, padding: "14px 18px",
            display: "flex", alignItems: "flex-start", gap: 12,
          }}>
            <i className="fas fa-circle-info" style={{ color: "#0284c7", fontSize: 16, marginTop: 2 }} />
            <div style={{ fontSize: 13, color: "#0369a1", lineHeight: 1.6 }}>
              <strong>Using sources in pipelines:</strong> Reference a source by its <code style={{ background: "#e0f2fe", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>name</code> slug when configuring copy pipelines.
              The pipeline will resolve all connection details and auth automatically.
            </div>
          </div>
        )}

      {modalOpen && (
        <DataSourceModal
          editing={editing}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={handleSaved}
          getToken={getToken}
        />
      )}

      {deleting && (
        <DeleteModal
          ds={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={handleDeleted}
          getToken={getToken}
        />
      )}
    </PageLayout>
  );
}
