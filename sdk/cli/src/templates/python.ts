/**
 * Forge CLI — Python Job Code Generator
 *
 * Renders a complete Python Spark job script from a ForgeJobManifest.
 * The script uses the ForgeJob subclass pattern matching the existing
 * forge_demo_*.py jobs in the Forge platform.
 *
 * Sentinel strings (exact — the CI check compares against these):
 *   # ── FORGE:LOCKED:START:HEADER ──   ... # ── FORGE:LOCKED:END:HEADER ──
 *   # ── FORGE:LOCKED:START:HELPERS ──  ... # ── FORGE:LOCKED:END:HELPERS ──
 *   # ── FORGE:LOCKED:START:SOURCE ──   ... # ── FORGE:LOCKED:END:SOURCE ──
 *   # ── FORGE:BUSINESS_LOGIC:START ──  ... # ── FORGE:BUSINESS_LOGIC:END ──
 *   # ── FORGE:LOCKED:START:WRITE ──    ... # ── FORGE:LOCKED:END:WRITE ──
 */
import type { ForgeJobManifest } from "../schema.js";

export interface ResolvedExternalSource {
  slug: string;
  account: string;
  container: string;
  basePath: string; // leading slash normalised away
}

// ---------------------------------------------------------------------------
// Sentinel constants — referenced by the generate command when extracting /
// re-splicing the business logic block.
// ---------------------------------------------------------------------------
export const SENTINEL = {
  HEADER_START:  "# ── FORGE:LOCKED:START:HEADER ──",
  HEADER_END:    "# ── FORGE:LOCKED:END:HEADER ──",
  HELPERS_START: "    # ── FORGE:LOCKED:START:HELPERS ──",
  HELPERS_END:   "    # ── FORGE:LOCKED:END:HELPERS ──",
  SOURCE_START:  "        # ── FORGE:LOCKED:START:SOURCE ──",
  SOURCE_END:    "        # ── FORGE:LOCKED:END:SOURCE ──",
  BL_START:      "        # ── FORGE:BUSINESS_LOGIC:START ──",
  BL_END:        "        # ── FORGE:BUSINESS_LOGIC:END ──",
  WRITE_START:   "        # ── FORGE:LOCKED:START:WRITE ──",
  WRITE_END:     "        # ── FORGE:LOCKED:END:WRITE ──",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert snake_case → PascalCase  e.g. "nyc_taxi_silver" → "NycTaxiSilver" */
function toPascalCase(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Render the `os.environ.get(...)` lines for each param. */
function renderParams(params: ForgeJobManifest["params"], indent = ""): string {
  return Object.entries(params)
    .map(([name, p]) => {
      const defaultVal = p.default !== undefined ? String(p.default) : "";
      const description = p.description ? `  # ${p.description}` : "";
      if (p.type === "int")
        return `${indent}${name} = int(os.environ.get("${name}", "${defaultVal}"))${description}`;
      if (p.type === "float")
        return `${indent}${name} = float(os.environ.get("${name}", "${defaultVal}"))${description}`;
      if (p.type === "bool")
        return `${indent}${name} = os.environ.get("${name}", "${defaultVal}").lower() in ("1", "true", "yes")${description}`;
      if (p.required && p.default === undefined)
        return `${indent}${name} = os.environ["${name}"]${description}`;
      return `${indent}${name} = os.environ.get("${name}", "${defaultVal}")${description}`;
    })
    .join("\n");
}

/** Render the param summary for the docstring. */
function renderParamDocs(params: ForgeJobManifest["params"]): string {
  return Object.entries(params)
    .map(([name, p]) => {
      const defaultPart = p.default !== undefined ? ` (default: ${p.default})` : "";
      const reqPart = p.required ? " [required]" : "";
      const descPart = p.description ? ` — ${p.description}` : "";
      return `  ${name}: ${p.type}${defaultPart}${reqPart}${descPart}`;
    })
    .join("\n");
}

/**
 * Build the Python f-string snippet for an ADLS path.
 * container, category, etc. are baked in at codegen time as literals.
 * storageAccount (if set) is also a literal; otherwise {self.storage} is the runtime reference.
 */
function adlsPath(name: string, version: number, path: ForgeJobManifest["output"]["path"]): string {
  const { container, category, entity, audience, metricsCohort, assetName, storageAccount } = path;
  const storageExpr = storageAccount ? storageAccount : "{os.environ['FORGE_STORAGE_ACCOUNT']}.dfs.core.windows.net";
  return `abfss://${container}@${storageExpr}/${category}/${entity}/${audience}/${metricsCohort}/${assetName}/v${version}/${name}`;
}

/** Derive the HMS/Trino table name from the manifest. */
function deriveTable(manifest: ForgeJobManifest): string {
  if (manifest.output.table) return manifest.output.table;
  // Use output.name (the asset identifier) not path.assetName (the folder key shared across layers).
  const slug = manifest.output.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${manifest.layer}.${slug}`;
}

/** Render the `_tracker_path()` instance method — layer-specific. */
function renderTrackerPathMethod(manifest: ForgeJobManifest): string {
  const { layer, output } = manifest;
  const base = adlsPath(output.name, output.version, output.path) + "/_tracker";

  if (layer === "bronze") {
    return [
      `    def _tracker_path(self) -> str:`,
      `        """ADLS path for this partition's tracker file."""`,
      `        _year, _month, _day = (int(x) for x in PARTITION_DATE.split("-"))`,
      `        return (`,
      `            f"${base}"`,
      `            f"/{_year}/{_month}/{_day}/{PARTITION_HOUR}/tracker.json"`,
      `        )`,
    ].join("\n");
  }

  // Silver / Gold
  return [
    `    def _tracker_path(self) -> str:`,
    `        """ADLS path for this partition's tracker file."""`,
    `        _dt = datetime.strptime(PARTITION_DATE, "%Y-%m-%d")`,
    `        _date_key = f"{_dt.day:02d}_{_dt.month:02d}_{_dt.year}_{PARTITION_HOUR:02d}"`,
    `        return (`,
    `            f"${base}"`,
    `            f"/{_date_key}/tracker.json"`,
    `        )`,
  ].join("\n");
}

/** Render the `_tracker_exists()` instance method. */
function renderTrackerExistsMethod(): string {
  return [
    `    def _tracker_exists(self) -> bool:`,
    `        """Return True if this partition's tracker already exists in ADLS."""`,
    `        try:`,
    `            _path = self._tracker_path()`,
    `            _jvm  = self.spark.sparkContext._jvm`,
    `            _conf = self.spark.sparkContext._jsc.hadoopConfiguration()`,
    `            _p    = _jvm.org.apache.hadoop.fs.Path(_path)`,
    `            return bool(_p.getFileSystem(_conf).exists(_p))`,
    `        except Exception:`,
    `            return False`,
  ].join("\n");
}

/** Render the `setup()` override — idempotency + restatement guard. */
function renderSetupMethod(manifest: ForgeJobManifest): string {
  const table = deriveTable(manifest);
  const db = manifest.layer;  // e.g. "bronze"
  return [
    `    def setup(self) -> None:`,
    `        self.spark.sql("CREATE DATABASE IF NOT EXISTS ${db}")`,
    `        if not RESTATE and self._tracker_exists():`,
    `            self.log.info(`,
    `                "partition_complete skipping table=${table} "`,
    `                "RESTATE=false — pass RESTATE=true to force rerun",`,
    `            )`,
    `            raise SystemExit(0)`,
    `        if RESTATE:`,
    `            self.log.info("restatement_mode table=${table} tracker=%s", self._tracker_path())`,
  ].join("\n");
}

/** Render the source-read block (8-space indent — inside run()). */
function renderSourceRead(
  manifest: ForgeJobManifest,
  resolvedSource?: ResolvedExternalSource,
  indent = "        "
): string {
  const { source } = manifest;

  // ── Raw path override ─────────────────────────────────────────────────────
  if (source.rawPath) {
    const fmt = source.format ?? "parquet";
    const optionsLines = Object.entries(source.options ?? {})
      .map(([k, v]) => `${indent}    .option("${k}", "${v}")`)
      .join("\n");
    const readLines = fmt === "parquet"
      ? [
          `${indent}raw = (`,
          `${indent}    self.spark.read`,
          optionsLines,
          `${indent}    .parquet(src_path)`,
          `${indent})`,
        ]
      : [
          `${indent}raw = (`,
          `${indent}    self.spark.read`,
          `${indent}    .format("${fmt}")`,
          optionsLines,
          `${indent}    .load(src_path)`,
          `${indent})`,
        ];
    return [
      `${indent}src_path = f"${source.rawPath}"`,
      ...readLines,
      `${indent}self.log.info("source_read path=%s", src_path)`,
    ].filter(Boolean).join("\n");
  }

  // ── External registered source ────────────────────────────────────────────
  // Full ABFS path = abfss://{container}@{account}.dfs.core.windows.net/{basePath}/{sourcePath}
  // {variable} placeholders in sourcePath become Python f-string references at runtime.
  if (resolvedSource && source.sourcePath) {
    const fmt = source.format ?? "parquet";
    const base = resolvedSource.basePath ? `${resolvedSource.basePath}/` : "";
    const fullPath = `abfss://${resolvedSource.container}@${resolvedSource.account}.dfs.core.windows.net/${base}${source.sourcePath}`;
    const optionsLines = Object.entries(source.options ?? {})
      .map(([k, v]) => `${indent}    .option("${k}", "${v}")`)
      .join("\n");

    const readLines = fmt === "parquet"
      ? [
          `${indent}raw = (`,
          `${indent}    self.spark.read`,
          optionsLines,
          `${indent}    .parquet(src_path)`,
          `${indent})`,
        ]
      : [
          `${indent}raw = (`,
          `${indent}    self.spark.read`,
          `${indent}    .format("${fmt}")`,
          optionsLines,
          `${indent}    .load(src_path)`,
          `${indent})`,
        ];

    return [
      `${indent}# Registered source: ${resolvedSource.slug} (configured in Forge portal → Data Sources)`,
      `${indent}src_path = f"${fullPath}"`,
      ...readLines,
      `${indent}self.log.info("source_read source=${resolvedSource.slug} path=%s", src_path)`,
    ].filter(Boolean).join("\n");
  }

  // ── Internal ADLS source ──────────────────────────────────────────────────
  const lakehouseContainers = new Set(["bronze", "silver", "gold"]);
  const isDelta = source.format === "delta" || (source.path && lakehouseContainers.has(source.path.container));
  const fmt = source.format ?? (isDelta ? "delta" : "parquet");
  const srcAdls = adlsPath(source.name, source.version, source.path!);

  const optionsLines = Object.entries(source.options ?? {})
    .map(([k, v]) => `${indent}    .option("${k}", "${v}")`)
    .join("\n");

  const filterLine = source.filter
    ? `${indent}    .filter(f"${source.filter.replace(/\{(\w+)\}/g, "{$1}")}")`
    : "";

  if (fmt === "parquet" && !source.filter) {
    return [
      `${indent}src_path = f"${srcAdls}"`,
      `${indent}raw = (`,
      `${indent}    self.spark.read`,
      optionsLines,
      `${indent}    .parquet(src_path)`,
      `${indent})`,
      `${indent}self.log.info("source_read path=%s", src_path)`,
    ].filter(Boolean).join("\n");
  }

  return [
    `${indent}src_path = f"${srcAdls}"`,
    `${indent}raw = (`,
    `${indent}    self.spark.read`,
    `${indent}    .format("${fmt}")`,
    optionsLines,
    `${indent}    .load(src_path)`,
    filterLine,
    `${indent})`,
    `${indent}self.log.info("source_read path=%s", src_path)`,
  ].filter(Boolean).join("\n");
}

/** Render the write + tracker block (8-space indent — inside run()). */
function renderWrite(manifest: ForgeJobManifest, indent = "        "): string {
  const { output, dq, partition, layer } = manifest;
  const mode = output.mode ?? "overwrite";
  const col = partition.column;
  const table = deriveTable(manifest);
  const outAdls = adlsPath(output.name, output.version, output.path);

  // ── Partition stamping ──────────────────────────────────────────────────
  let partitionStamp: string;
  let partBy: string;
  let pyReplaceWhere: string;
  let trackerPartition: string;

  if (layer === "bronze") {
    const hourExpr = partition.hasHour
      ? `F.hour(F.col("${col}"))`
      : `F.lit(PARTITION_HOUR)`;
    partitionStamp = [
      `${indent}# Stamp partition columns`,
      `${indent}_year, _month, _day = (int(x) for x in PARTITION_DATE.split("-"))`,
      `${indent}df = (`,
      `${indent}    df`,
      `${indent}    .withColumn("__year",  F.lit(_year))`,
      `${indent}    .withColumn("__month", F.lit(_month))`,
      `${indent}    .withColumn("__day",   F.lit(_day))`,
      `${indent}    .withColumn("__hour",  ${hourExpr})`,
      `${indent})`,
    ].join("\n");
    partBy = `"__year", "__month", "__day", "__hour"`;
    pyReplaceWhere = `__year = {_year} AND __month = {_month} AND __day = {_day} AND __hour = {PARTITION_HOUR}`;
    trackerPartition = `{"year": _year, "month": _month, "day": _day, "hour": PARTITION_HOUR}`;
  } else {
    partitionStamp = [
      `${indent}# Build __date partition key: DD_MM_YYYY_HH`,
      `${indent}_dt = datetime.strptime(PARTITION_DATE, "%Y-%m-%d")`,
      `${indent}_date_key = f"{_dt.day:02d}_{_dt.month:02d}_{_dt.year}_{PARTITION_HOUR:02d}"`,
      `${indent}df = df.withColumn("__date", F.lit(_date_key))`,
    ].join("\n");
    partBy = `"__date"`;
    pyReplaceWhere = `__date = '{_date_key}'`;
    trackerPartition = `{"date": _date_key}`;
  }

  // ── Delta write block ────────────────────────────────────────────────────
  // Write to the explicit ADLS path, then register in HMS so Trino/Spark SQL
  // can query via the table name. This ensures data lands in our bronze/silver/
  // gold containers, not the HMS default warehouse directory.
  const [dbName, tblName] = table.split(".");
  const deltaWrite = [
    `${indent}_out_path = f"${outAdls}"`,
    `${indent}(`,
    `${indent}    df.write`,
    `${indent}    .format("delta")`,
    `${indent}    .mode("${mode}")`,
    `${indent}    .option("overwriteSchema", "true")`,
    `${indent}    .option("replaceWhere", f"${pyReplaceWhere}")`,
    `${indent}    .partitionBy(${partBy})`,
    `${indent}    .save(_out_path)`,
    `${indent})`,
    `${indent}self.spark.sql(f"CREATE TABLE IF NOT EXISTS ${table} USING DELTA LOCATION '{_out_path}'"`,
    `${indent})`,
  ].join("\n");

  // ── Tracker write block ──────────────────────────────────────────────────
  const trackerWrite = [
    `${indent}self.log.info("write_complete table=${table} rows=%d", _row_count)`,
    ``,
    `${indent}# Write tracker — source of truth for run history and downstream dependencies`,
    `${indent}_tracker = {`,
    `${indent}    "version":      "v1",`,
    `${indent}    "job":          self.__class__.__name__,`,
    `${indent}    "table":        "${table}",`,
    `${indent}    "partition":    ${trackerPartition},`,
    `${indent}    "status":       "success",`,
    `${indent}    "rows_written": _row_count,`,
    `${indent}    "completed_at": datetime.now(timezone.utc).isoformat(),`,
    `${indent}    "forge_env":    FORGE_ENV,`,
    `${indent}}`,
    `${indent}_tracker_path = self._tracker_path()`,
    `${indent}_jvm  = self.spark.sparkContext._jvm`,
    `${indent}_conf = self.spark.sparkContext._jsc.hadoopConfiguration()`,
    `${indent}_p    = _jvm.org.apache.hadoop.fs.Path(_tracker_path)`,
    `${indent}_out  = _p.getFileSystem(_conf).create(_p, True)`,
    `${indent}_out.write(bytearray(json.dumps(_tracker, indent=2).encode("utf-8")))`,
    `${indent}_out.close()`,
    `${indent}self.log.info("tracker_written path=%s rows=%d", _tracker_path, _row_count)`,
  ].join("\n");

  // ── Row count guard (always first) ──────────────────────────────────────
  const rowCountGuard = [
    `${indent}_row_count = df.count()`,
    `${indent}self.log.info("rows_to_write count=%d", _row_count)`,
    `${indent}if _row_count == 0:`,
    `${indent}    self.log.warning("empty_partition_skipping table=${table}")`,
    `${indent}    return`,
  ].join("\n");

  return [
    rowCountGuard,
    ``,
    partitionStamp,
    ``,
    deltaWrite,
    ``,
    trackerWrite,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Business logic stub + extractor
// ---------------------------------------------------------------------------

const DEFAULT_BL_STUB = `        df = raw  # TODO: transform raw → df`;

export function extractBusinessLogic(existingPy: string): string | null {
  const startIdx = existingPy.indexOf(SENTINEL.BL_START);
  const endIdx   = existingPy.indexOf(SENTINEL.BL_END);
  if (startIdx === -1 || endIdx === -1) return null;
  const block = existingPy.slice(startIdx + SENTINEL.BL_START.length, endIdx);
  return block.replace(/^\n/, "").replace(/\n$/, "");
}

// ---------------------------------------------------------------------------
// Effective params — auto-inject PARTITION_DATE, PARTITION_HOUR, RESTATE
// ---------------------------------------------------------------------------

function buildEffectiveParams(manifest: ForgeJobManifest): ForgeJobManifest["params"] {
  const base = { ...manifest.params };

  if (!base["PARTITION_DATE"]) {
    base["PARTITION_DATE"] = {
      type: "string",
      default: "",
      description: "Partition date (yyyy-MM-dd) — set by Airflow data_interval_start",
    };
  }

  if (!base["PARTITION_HOUR"]) {
    base["PARTITION_HOUR"] = {
      type: "int",
      default: 0,
      description: "Partition hour (0–23) — 0 when date column has no time component",
    };
  }

  // RESTATE=true forces re-run even if tracker already exists
  if (!base["RESTATE"]) {
    base["RESTATE"] = {
      type: "bool",
      default: "false",
      description: "Set true to restate partition even if tracker already exists",
    };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export function generatePython(
  manifest: ForgeJobManifest,
  existingPy?: string,
  resolvedSource?: ResolvedExternalSource
): string {
  const className     = toPascalCase(manifest.name);
  const scheduleStr   = manifest.schedule ?? "triggered (no schedule)";
  const hasDq         = !!manifest.dq;
  const businessLogic = (existingPy ? extractBusinessLogic(existingPy) : null) ?? DEFAULT_BL_STUB;
  const effectiveParams = buildEffectiveParams(manifest);

  const paramLines  = renderParams(effectiveParams, "");
  const paramDocs   = renderParamDocs(effectiveParams);
  const sourceRead  = renderSourceRead(manifest, resolvedSource);
  const writeBlock  = renderWrite(manifest);
  const helpersPM   = renderTrackerPathMethod(manifest);
  const helpersTE   = renderTrackerExistsMethod();
  const helpersSetup = renderSetupMethod(manifest);

  const partitionDoc = manifest.layer === "bronze"
    ? `__year/__month/__day/__hour from ${manifest.partition.column}${manifest.partition.hasHour ? "" : " (hour=PARTITION_HOUR, default 0)"}`
    : `__date = DD_MM_YYYY_HH derived from ${manifest.partition.column}`;

  const dqImport = "";

  // Partition variable extraction — always emitted so source filters can reference
  // _year, _month, _day (all layers) and _date_key (silver/gold) before the write block.
  const runPartitionVars =
    manifest.layer === "bronze"
      ? `        _year, _month, _day = (int(x) for x in PARTITION_DATE.split("-"))\n`
      : [
          `        _year, _month, _day = (int(x) for x in PARTITION_DATE.split("-"))`,
          `        _dt = datetime.strptime(PARTITION_DATE, "%Y-%m-%d")`,
          `        _date_key = f"{_dt.day:02d}_{_dt.month:02d}_{_dt.year}_{PARTITION_HOUR:02d}"`,
          ``,
        ].join("\n");

  return `# ==============================================================
# GENERATED BY FORGE CLI — DO NOT EDIT OUTSIDE THE MARKED BLOCK
# Source: ${manifest.name}.forge.ts  |  Layer: ${manifest.layer}
# Regenerate: forge generate --job ${manifest.name}
# CI check:   forge generate --check --job ${manifest.name}
# ==============================================================
${SENTINEL.HEADER_START}
"""
${manifest.description}

Layer:     ${manifest.layer}
Table:     ${deriveTable(manifest)}
Partition: ${partitionDoc}
Schedule:  ${scheduleStr}
Params:
${paramDocs}
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from pyspark.sql import functions as F

from forge_sdk import ForgeJob
${dqImport}
${SENTINEL.HEADER_END}

${SENTINEL.HEADER_START}
# ---------------------------------------------------------------------------
# Parameters — auto-injected: PARTITION_DATE, PARTITION_HOUR, RESTATE
# ---------------------------------------------------------------------------
FORGE_ENV = os.environ.get("FORGE_ENV", "dev")

${paramLines}
${SENTINEL.HEADER_END}


class ${className}(ForgeJob):
    """${manifest.description}"""

${SENTINEL.HELPERS_START}
${helpersPM}

${helpersTE}

${helpersSetup}
${SENTINEL.HELPERS_END}

    def run(self) -> None:
${runPartitionVars}${SENTINEL.SOURCE_START}
${sourceRead}
${SENTINEL.SOURCE_END}

        # ╔══════════════════════════════════════════╗
        # ║  EDIT THIS BLOCK — business logic only   ║
        # ╚══════════════════════════════════════════╝
${SENTINEL.BL_START}
${businessLogic}
${SENTINEL.BL_END}
        # ════════════════════════════════════════════

${SENTINEL.WRITE_START}
${writeBlock}
${SENTINEL.WRITE_END}


if __name__ == "__main__":
    ${className}().execute()
`;
}
