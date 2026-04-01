/**
 * Forge CLI — Python Job Code Generator
 *
 * Renders a complete Python Spark job script from a ForgeJobManifest.
 * The script uses the ForgeJob subclass pattern matching the existing
 * forge_demo_*.py jobs in the Forge platform.
 *
 * Sentinel strings (exact — the CI check compares against these):
 *   # ── FORGE:LOCKED:START:HEADER ──   ... # ── FORGE:LOCKED:END:HEADER ──
 *   # ── FORGE:LOCKED:START:SOURCE ──   ... # ── FORGE:LOCKED:END:SOURCE ──
 *   # ── FORGE:BUSINESS_LOGIC:START ──  ... # ── FORGE:BUSINESS_LOGIC:END ──
 *   # ── FORGE:LOCKED:START:WRITE ──    ... # ── FORGE:LOCKED:END:WRITE ──
 */
import type { ForgeJobManifest } from "../schema.js";

// ---------------------------------------------------------------------------
// Sentinel constants — referenced by the generate command when extracting /
// re-splicing the business logic block.
// ---------------------------------------------------------------------------
export const SENTINEL = {
  HEADER_START: "# ── FORGE:LOCKED:START:HEADER ──",
  HEADER_END: "# ── FORGE:LOCKED:END:HEADER ──",
  SOURCE_START: "# ── FORGE:LOCKED:START:SOURCE ──",
  SOURCE_END: "# ── FORGE:LOCKED:END:SOURCE ──",
  BL_START: "        # ── FORGE:BUSINESS_LOGIC:START ──",
  BL_END: "        # ── FORGE:BUSINESS_LOGIC:END ──",
  WRITE_START: "# ── FORGE:LOCKED:START:WRITE ──",
  WRITE_END: "# ── FORGE:LOCKED:END:WRITE ──",
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

/**
 * Render the `os.environ.get(...)` line(s) for each param.
 * Types other than string are cast appropriately.
 */
function renderParams(
  params: ForgeJobManifest["params"],
  indent = ""
): string {
  return Object.entries(params)
    .map(([name, p]) => {
      const defaultVal =
        p.default !== undefined ? String(p.default) : "";
      const description = p.description ? `  # ${p.description}` : "";
      if (p.type === "int") {
        return `${indent}${name} = int(os.environ.get("${name}", "${defaultVal}"))${description}`;
      }
      if (p.type === "float") {
        return `${indent}${name} = float(os.environ.get("${name}", "${defaultVal}"))${description}`;
      }
      if (p.type === "bool") {
        return `${indent}${name} = os.environ.get("${name}", "${defaultVal}").lower() in ("1", "true", "yes")${description}`;
      }
      // string (and required without default)
      if (p.required && p.default === undefined) {
        return `${indent}${name} = os.environ["${name}"]${description}`;
      }
      return `${indent}${name} = os.environ.get("${name}", "${defaultVal}")${description}`;
    })
    .join("\n");
}

/** Render the param summary line in the docstring. */
function renderParamDocs(params: ForgeJobManifest["params"]): string {
  return Object.entries(params)
    .map(([name, p]) => {
      const defaultPart =
        p.default !== undefined ? ` (default: ${p.default})` : "";
      const reqPart = p.required ? " [required]" : "";
      const descPart = p.description ? ` — ${p.description}` : "";
      return `  ${name}: ${p.type}${defaultPart}${reqPart}${descPart}`;
    })
    .join("\n");
}

/** Render the source-read block (indented for inside a method). */
function renderSourceRead(
  manifest: ForgeJobManifest,
  indent = "        "
): string {
  const { source, params } = manifest;

  if (source.type === "external") {
    const fmt = source.format ?? "parquet";
    const pathTemplate = source.path ?? "";
    // Replace {PARAM} placeholders with f-string expressions
    const pyPath = pathTemplate.replace(/\{(\w+)\}/g, "{$1}");
    const optionsLines = Object.entries(source.options ?? {})
      .map(([k, v]) => `${indent}    .option("${k}", "${v}")`)
      .join("\n");

    if (fmt === "parquet") {
      return [
        `${indent}src_path = (`,
        `${indent}    f"${pyPath}"`,
        `${indent})`,
        `${indent}raw = (`,
        `${indent}    self.spark.read`,
        optionsLines,
        `${indent}    .parquet(src_path)`,
        `${indent})`,
        `${indent}self.log.info("source_read path=%s", src_path)`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    return [
      `${indent}src_path = (`,
      `${indent}    f"${pyPath}"`,
      `${indent})`,
      `${indent}raw = (`,
      `${indent}    self.spark.read`,
      `${indent}    .format("${fmt}")`,
      optionsLines,
      `${indent}    .load(src_path)`,
      `${indent})`,
      `${indent}self.log.info("source_read path=%s", src_path)`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (source.type === "bronze" || source.type === "silver") {
    const pathHelper =
      source.type === "bronze" ? "self.bronze" : "self.silver";
    const table = source.table ?? "";
    // Derive sub-path from HMS table name: "lakehouse.bronze.retail_orders" → "retail/orders"
    const parts = table.split(".");
    const tablePart = parts.slice(2).join(".").replace(/_/g, "/") || parts[parts.length - 1];

    let filterLine = "";
    if (source.filter) {
      // Replace {PARAM} placeholders with f-string expressions
      const pyFilter = source.filter.replace(/\{(\w+)\}/g, "{$1}");
      filterLine = `${indent}    .filter(f"${pyFilter}")`;
    }

    return [
      `${indent}raw = (`,
      `${indent}    self.spark.read`,
      `${indent}    .format("delta")`,
      `${indent}    .load(${pathHelper}("${tablePart}"))`,
      filterLine,
      `${indent})`,
      `${indent}self.log.info("source_read table=${table}")`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `${indent}raw = None  # TODO: configure source`;
}

/** Render the write block (indented for inside a method). */
function renderWrite(
  manifest: ForgeJobManifest,
  indent = "        "
): string {
  const { output, dq, partition } = manifest;
  const mode = output.mode ?? "overwrite";
  const col = partition.column;

  // Always partition by (partition_date, partition_hour).
  // PARTITION_DATE is always set by Airflow.
  // PARTITION_HOUR defaults to 0 when the date column has no time component.
  // When hasHour=true, the hour is extracted from the column; otherwise F.lit(0).
  const hourExpr = partition.hasHour
    ? `F.hour(F.col("${col}"))`
    : `F.lit(0)`;

  const preMutationBlock = [
    `${indent}# Stamp partition columns before write`,
    `${indent}df = (`,
    `${indent}    df`,
    `${indent}    .withColumn("partition_date", F.to_date(F.col("${col}")))`,
    `${indent}    .withColumn("partition_hour", ${hourExpr})`,
    `${indent})`,
    ``,
  ].join("\n");

  const partBy = `"partition_date", "partition_hour"`;
  const pyReplaceWhere = `partition_date = '{PARTITION_DATE}' AND partition_hour = {PARTITION_HOUR}`;

  const writeLines = [
    `${indent}(`,
    `${indent}    df.write`,
    `${indent}    .format("delta")`,
    `${indent}    .mode("${mode}")`,
    `${indent}    .option("overwriteSchema", "true")`,
    `${indent}    .option("replaceWhere", f"${pyReplaceWhere}")`,
    `${indent}    .partitionBy(${partBy})`,
    `${indent}    .saveAsTable("${output.table}")`,
    `${indent})`,
    `${indent}self.log.info("write_complete table=${output.table}")`,
  ].join("\n");

  const fullWrite = preMutationBlock + writeLines;

  if (dq) {
    // Wrap write in @track decorator pattern
    const failFast = dq.failFast !== false ? "True" : "False";
    return [
      `${indent}@track(`,
      `${indent}    dataset="${output.table}",`,
      `${indent}    rules="${dq.rules}",`,
      `${indent}    fail_fast=${failFast},`,
      `${indent})`,
      `${indent}def _write() -> None:`,
      fullWrite
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
      ``,
      `${indent}_write()`,
    ].join("\n");
  }

  return fullWrite;
}

// ---------------------------------------------------------------------------
// Default business logic stub
// ---------------------------------------------------------------------------
const DEFAULT_BL_STUB = `        df = raw  # TODO: transform raw → df`;

// ---------------------------------------------------------------------------
// Extract the business logic block from an existing .py file
// ---------------------------------------------------------------------------
export function extractBusinessLogic(existingPy: string): string | null {
  const startIdx = existingPy.indexOf(SENTINEL.BL_START);
  const endIdx = existingPy.indexOf(SENTINEL.BL_END);
  if (startIdx === -1 || endIdx === -1) return null;
  // Everything between the sentinels (exclusive), trimming trailing newline
  const block = existingPy.slice(
    startIdx + SENTINEL.BL_START.length,
    endIdx
  );
  // Strip leading/trailing blank lines but keep indented content
  return block.replace(/^\n/, "").replace(/\n$/, "");
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Build the effective params map for code generation.
 *
 * The generator guarantees that PARTITION_DATE is always present, and
 * PARTITION_HOUR is added for hour-granularity jobs.  If the manifest
 * author has already declared these params they are left unchanged; if
 * they are absent they are injected with sensible defaults so the
 * generated Python always compiles correctly.
 */
function buildEffectiveParams(
  manifest: ForgeJobManifest
): ForgeJobManifest["params"] {
  const base = { ...manifest.params };

  if (!base["PARTITION_DATE"]) {
    base["PARTITION_DATE"] = {
      type: "string",
      default: "",
      description: "Partition date (yyyy-MM-dd) — set by Airflow data_interval_start",
    };
  }

  // PARTITION_HOUR is always injected. Defaults to 0 for date-only columns.
  if (!base["PARTITION_HOUR"]) {
    base["PARTITION_HOUR"] = {
      type: "int",
      default: 0,
      description: "Partition hour (0–23) — 0 when date column has no time component",
    };
  }

  return base;
}

/**
 * Generate a complete Python Spark job script from a manifest.
 *
 * @param manifest       Validated ForgeJobManifest
 * @param existingPy     If provided, the existing .py content — the business
 *                       logic block is extracted and preserved.
 */
export function generatePython(
  manifest: ForgeJobManifest,
  existingPy?: string
): string {
  const className = toPascalCase(manifest.name);
  const scheduleStr = manifest.schedule ?? "triggered (no schedule)";
  const hasDq = !!manifest.dq;

  // Extract or default the business logic block
  const businessLogic =
    (existingPy ? extractBusinessLogic(existingPy) : null) ??
    DEFAULT_BL_STUB;

  // Effective params — auto-injects PARTITION_DATE (and PARTITION_HOUR for hourly)
  const effectiveParams = buildEffectiveParams(manifest);

  const paramLines = renderParams(effectiveParams, "");
  const paramDocs = renderParamDocs(effectiveParams);
  const sourceRead = renderSourceRead(manifest);
  const writeBlock = renderWrite(manifest);

  const dqImport = hasDq
    ? `
try:
    from forge_dq import track
except ImportError:
    import functools

    def track(**kwargs):  # type: ignore[misc]
        """No-op fallback when forge_dq is not installed."""
        def decorator(fn):
            @functools.wraps(fn)
            def wrapper(*args, **kw):
                return fn(*args, **kw)
            return wrapper
        return decorator
`
    : "";

  const paramSection =
    Object.keys(effectiveParams).length > 0
      ? `\n${paramLines}\n`
      : "";

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
Table:     ${manifest.output.table}
Partition: ${manifest.partition.column} → (partition_date, partition_hour) — hour=${manifest.partition.hasHour ? "extracted from column" : "0 (date-only)"}
Schedule:  ${scheduleStr}
Params:
${paramDocs}
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

from pyspark.sql import functions as F

from forge_sdk import ForgeJob
${dqImport}
${SENTINEL.HEADER_END}

${SENTINEL.HEADER_START}
# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------
FORGE_ENV = os.environ.get("FORGE_ENV", "dev")
${paramSection}${SENTINEL.HEADER_END}


class ${className}(ForgeJob):
    """${manifest.description}"""

    def run(self) -> None:
        # ── Source read ──
        ${SENTINEL.SOURCE_START}
${sourceRead}
        ${SENTINEL.SOURCE_END}

        # ╔══════════════════════════════════════════╗
        # ║  EDIT THIS BLOCK — business logic only   ║
        # ╚══════════════════════════════════════════╝
${SENTINEL.BL_START}
${businessLogic}
${SENTINEL.BL_END}
        # ════════════════════════════════════════════

        # ── Write ──
        ${SENTINEL.WRITE_START}
${writeBlock}
        ${SENTINEL.WRITE_END}


if __name__ == "__main__":
    ${className}().execute()
`;
}
