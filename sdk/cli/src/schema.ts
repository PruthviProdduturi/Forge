/**
 * Forge CLI — Job Manifest Schema
 *
 * Defines the TypeScript type for a .forge.ts manifest file and validates it
 * at runtime with Zod.  The `defineJob()` function is the sole entry point for
 * manifest authors; it performs no runtime work (just returns the object) but
 * provides full IntelliSense and type-checking.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema (runtime validation)
// ---------------------------------------------------------------------------

const ParamSchema = z.object({
  type: z.enum(["string", "int", "float", "bool"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  source: z.enum(["env", "configmap", "airflow_var"]).optional(),
  description: z.string().optional(),
});

const DataPathSchema = z.object({
  container: z.string(),          // ADLS container (e.g. "bronze", "silver", "gold", "Publish", "raw")
  category: z.string(),           // e.g. "Transport"
  entity: z.string(),             // e.g. "Trip"
  audience: z.string(),           // e.g. "Internal"
  metricsCohort: z.string(),      // e.g. "Rideshare"
  assetName: z.string(),          // e.g. "NycTaxi"
  storageAccount: z.string().optional(),  // override for cross-account reads; defaults to self.storage
});

const SourceSchema = z.object({
  name: z.string(),                          // dataset name, used as last path segment / logical identifier
  version: z.number().int().positive(),      // version number, used as path segment / logical identifier
  // Internal ADLS source — one of path OR registeredSource is required.
  path: DataPathSchema.optional(),
  // External registered source — slug must match a data source registered in the Forge portal.
  // forge generate fetches account/container/basePath from the portal API at codegen time.
  // sourcePath is the sub-path appended after basePath; use {variable} placeholders for runtime
  // values (e.g. {_year}, {_month}) — they become Python f-string references.
  registeredSource: z.string().optional(),
  sourcePath: z.string().optional(),
  // Full ABFS path template, e.g. "abfss://code@{self.storage}/path/puYear={_year}/*.parquet". Overrides path/registeredSource.
  rawPath: z.string().optional(),
  format: z.enum(["parquet", "csv", "json", "delta"]).optional(),  // for non-delta sources; delta auto-detected for lakehouse containers
  options: z.record(z.string()).optional(),  // Spark reader options
  filter: z.string().optional(),             // Delta partition filter (internal sources only)
}).superRefine((src, ctx) => {
  const hasPath = !!src.path;
  const hasExternal = !!src.registeredSource;
  if (!hasPath && !hasExternal && !src.rawPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "source requires either 'path' (internal ADLS) or 'registeredSource' (portal-registered external source)",
    });
  }
  if (src.registeredSource && !src.sourcePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourcePath"],
      message: "sourcePath is required when registeredSource is set — e.g. \"puYear={_year}/puMonth={_month}/*.parquet\"",
    });
  }
});

const PartitionSchema = z.object({
  column: z.string(),
  // hasHour: if the date column contains time (timestamp), the hour component
  // is extracted and used as the partition hour. If false (date-only column),
  // PARTITION_HOUR defaults to 0. Both cases always produce (date, hour) partitions.
  hasHour: z.boolean().default(false),
});

const OutputSchema = z.object({
  name: z.string(),                          // dataset name, last path segment
  version: z.number().int().positive(),      // version number, path segment
  path: DataPathSchema,
  mode: z.enum(["overwrite", "append"]).optional(),
  table: z.string().optional(),              // HMS/Trino table name; derived as "lakehouse.{layer}.{assetName.toLowerCase()}" if omitted
});

const DqRuleSchema = z.object({
  name: z.string(),
  type: z.string(),          // row_count, not_null, accepted_values, min_value, max_value, etc.
  column: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  values: z.array(z.string()).optional(),
  severity: z.enum(["critical", "warning"]).default("critical"),
  description: z.string().optional(),
});

const DqSchema = z.object({
  rules: z.array(DqRuleSchema),
  failFast: z.boolean().optional().default(true),
});

const ResourcesSchema = z.object({
  driver: z
    .object({
      cores: z.number().int().positive().optional(),
      memory: z.string().optional(),
    })
    .optional(),
  executor: z
    .object({
      cores: z.number().int().positive().optional(),
      memory: z.string().optional(),
      instances: z.number().int().positive().optional(),
    })
    .optional(),
});

export const ForgeJobManifestSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "name must be snake_case"),
  layer: z.enum(["bronze", "silver", "gold"]),
  description: z.string(),
  schedule: z.string().optional(),
  // startDate: ISO date string "YYYY-MM-DD". Airflow will schedule runs from this date.
  // Set catchup: true to backfill all missed slots since startDate.
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD").optional(),
  // endDate: ISO date string "YYYY-MM-DD". Airflow will not schedule runs after this date.
  // Use to cap a bounded backfill or decommission a pipeline without deleting the DAG.
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD").optional(),
  // catchup: if true, Airflow runs all missed slots since startDate (backfill).
  // Combined with maxActiveRuns to control parallelism — e.g. startDate=2024-01-01,
  // maxActiveRuns=10 → runs 10 days in parallel until caught up.
  catchup: z.boolean().optional(),
  // maxActiveRuns: max concurrent DAG runs (default 3). Use higher values for fast backfill.
  maxActiveRuns: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  params: z.record(ParamSchema),
  source: SourceSchema,
  partition: PartitionSchema,
  output: OutputSchema,
  dq: DqSchema.optional(),
  resources: ResourcesSchema.optional(),
  triggers: z.array(z.string()).optional(),
  triggeredBy: z.string().optional(),
  // DAG execution settings — all optional, sensible defaults applied per layer if omitted.
  retries: z.number().int().min(0).max(10).optional(),
  retryDelayMinutes: z.number().int().positive().optional(),
  executionTimeoutHours: z.number().positive().optional(),
  slaHours: z.number().positive().optional(),
});

// ---------------------------------------------------------------------------
// TypeScript type (inferred from Zod schema)
// ---------------------------------------------------------------------------

export type ForgeJobManifest = z.infer<typeof ForgeJobManifestSchema>;

// ---------------------------------------------------------------------------
// Public entry point for manifest authors
// ---------------------------------------------------------------------------

/**
 * Define a Forge job manifest.
 *
 * Use this function as the default export of a `<name>.forge.ts` file:
 *
 * ```ts
 * import { defineJob } from "@forge/cli/schema";
 *
 * export default defineJob({
 *   name: "my_job",
 *   layer: "silver",
 *   ...
 * });
 * ```
 *
 * The function returns the manifest unchanged; its sole purpose is to
 * provide TypeScript type-checking and IntelliSense in your editor.
 */
export function defineJob(manifest: ForgeJobManifest): ForgeJobManifest {
  return manifest;
}
