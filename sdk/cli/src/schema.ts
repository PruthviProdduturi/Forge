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
  name: z.string(),                          // dataset name, used as last path segment
  version: z.number().int().positive(),      // version number, used as path segment
  path: DataPathSchema,
  format: z.enum(["parquet", "csv", "json", "delta"]).optional(),  // for non-delta sources; delta auto-detected for lakehouse containers
  options: z.record(z.string()).optional(),  // Spark reader options
  filter: z.string().optional(),             // Delta partition filter
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

const DqSchema = z.object({
  rules: z.string(),
  failFast: z.boolean().optional(),
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
  tags: z.array(z.string()).optional(),
  params: z.record(ParamSchema),
  source: SourceSchema,
  partition: PartitionSchema,
  output: OutputSchema,
  dq: DqSchema.optional(),
  resources: ResourcesSchema.optional(),
  triggers: z.array(z.string()).optional(),
  triggeredBy: z.string().optional(),
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
