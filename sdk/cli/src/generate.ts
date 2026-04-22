/**
 * Forge CLI — generate command implementation
 *
 * Orchestrates:
 *  1. Dynamic import of a .forge.ts manifest file
 *  2. Zod validation of the manifest
 *  3. Code generation (Python job, Airflow DAG, optional DQ YAML)
 *  4. File writes or --check diff comparison
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { ForgeJobManifestSchema, type ForgeJobManifest } from "./schema.js";
import { generatePython, type ResolvedExternalSource } from "./templates/python.js";
import { generateDag, dagFolder } from "./templates/dag.js";
import { generateDqYaml } from "./templates/dq.js";

// ---------------------------------------------------------------------------
// Load + validate manifest
// ---------------------------------------------------------------------------

/**
 * Dynamically import a .forge.ts manifest and return the default export.
 *
 * Requires that the file has a default export produced by `defineJob()`.
 */
export async function loadManifest(
  manifestPath: string
): Promise<unknown> {
  const absPath = path.resolve(manifestPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Manifest not found: ${absPath}`);
  }
  // Dynamic import — works with tsx / ts-node at runtime
  const mod = await import(pathToFileURL(absPath).href);
  const exported = mod.default ?? mod;
  if (!exported || typeof exported !== "object") {
    throw new Error(
      `Manifest at ${absPath} must have a default export from defineJob()`
    );
  }
  return exported;
}

/**
 * Validate a raw manifest object with Zod.
 * Throws a descriptive error on failure.
 */
export function validateManifest(raw: unknown): ForgeJobManifest {
  const result = ForgeJobManifestSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.errors
      .map((e) => `  • ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Manifest validation failed:\n${messages}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// External source resolution (portal API fetch)
// ---------------------------------------------------------------------------

/**
 * Fetch a registered data source's connection config from the Forge portal API.
 *
 * Portal URL resolution order:
 *   1. FORGE_PORTAL_URL env var  (explicit override)
 *   2. Derived from FORGE_ENV → https://forge-portal-{env}.westcentralus.cloudapp.azure.com
 *   3. Default to dev public endpoint
 */
export async function resolveExternalSource(
  slug: string
): Promise<ResolvedExternalSource> {
  const forgeEnv   = (process.env["FORGE_ENV"]     ?? "dev").toLowerCase();
  const ownerAlias = (process.env["OWNER_ALIAS"]   ?? "").toLowerCase();
  const location   = (process.env["FORGE_LOCATION"] ?? "northcentralus").toLowerCase();
  // DNS label matches forge-up.sh: forge-portal-{alias}-{env} (alias has trailing dash when set)
  const aliasPrefix = ownerAlias ? `${ownerAlias}-` : "";
  const label      = `forge-portal-${aliasPrefix}${forgeEnv}`;
  const derivedUrl = `https://${label}.${location}.cloudapp.azure.com`;
  const portalUrl  = process.env["FORGE_PORTAL_URL"] ?? derivedUrl;

  // Acquire an MS Graph token via az CLI — always available after `az login`,
  // no consent required on the portal app registration.
  // The portal auth proxy accepts Graph tokens and extracts user identity from claims.
  let bearerToken = "";
  try {
    bearerToken = execSync(
      `az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    // az CLI not installed or not logged in — fall through, will get 401 below.
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;

  let sources: Array<{ name: string; config: Record<string, string> }>;
  try {
    const resp = await fetch(`${portalUrl}/api/v1/datasources`, { headers });
    if (resp.status === 401) {
      throw new Error(
        `Authentication required. Ensure you are logged into Azure:\n` +
        `    az login\n` +
        `  Then re-run forge generate.`
      );
    }
    if (!resp.ok) {
      throw new Error(`Portal returned HTTP ${resp.status}`);
    }
    sources = await resp.json() as typeof sources;
  } catch (err) {
    if (String(err).includes("Authentication required")) throw err;
    throw new Error(
      `Cannot reach Forge portal at ${portalUrl}.\n` +
      `  Ensure you are connected to the network or override the URL with:\n` +
      `    FORGE_PORTAL_URL=<url> forge generate --job ...\n` +
      `  Original error: ${err}`
    );
  }

  const ds = sources.find((s) => s.name === slug);
  if (!ds) {
    throw new Error(
      `Data source '${slug}' is not registered in the Forge portal (${portalUrl}).\n` +
      `  Register it first: portal → Data Sources → Add Source.`
    );
  }

  const account   = ds.config["account"] ?? "";
  const container = ds.config["container"] ?? "";
  const basePath  = (ds.config["base_path"] ?? "").replace(/^\/|\/$/g, ""); // strip leading/trailing slashes

  if (!account || !container) {
    throw new Error(
      `Data source '${slug}' is missing 'account' or 'container' in its config. ` +
      `Check the registration in the Forge portal.`
    );
  }

  return { slug, account, container, basePath };
}

// ---------------------------------------------------------------------------
// Output path resolution
// ---------------------------------------------------------------------------

export interface GeneratedPaths {
  pythonJob: string;
  dag: string;
  dqRules: string | null;
}

/**
 * Resolve all output file paths for a manifest.
 *
 * @param manifest  Validated manifest
 * @param outputDir Root output directory (defaults to the examples directory)
 */
export function resolveOutputPaths(
  manifest: ForgeJobManifest,
  outputDir: string
): GeneratedPaths {
  return {
    pythonJob: path.join(outputDir, "jobs", `${manifest.name}.py`),
    dag: path.join(outputDir, "dags", `${manifest.name}_dag.py`),
    dqRules: manifest.dq
      ? path.join(outputDir, "dq", `${manifest.name}.yaml`)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Diff helper (used by --check)
// ---------------------------------------------------------------------------

function normaliseNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function isDifferent(a: string, b: string): boolean {
  return normaliseNewlines(a) !== normaliseNewlines(b);
}

// ---------------------------------------------------------------------------
// Generate + write (or check)
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** Root directory for output files (e.g. examples/) */
  outputDir: string;
  /** If true, compare generated content with existing files; exit 1 if stale */
  check?: boolean;
  /** If true, emit verbose status messages */
  verbose?: boolean;
}

/**
 * Generate all artefacts for a manifest and either write them to disk or
 * compare them against committed files (--check mode).
 *
 * @returns true if all files are up to date (or written successfully)
 */
export async function generateJob(
  manifest: ForgeJobManifest,
  options: GenerateOptions
): Promise<boolean> {
  const { outputDir, check = false, verbose = false } = options;

  const paths = resolveOutputPaths(manifest, outputDir);

  // Resolve external source config from portal API if needed
  let resolvedSource: ResolvedExternalSource | undefined;
  if (manifest.source.registeredSource) {
    resolvedSource = await resolveExternalSource(manifest.source.registeredSource);
    if (verbose) {
      console.log(
        `[forge generate] RESOLVED source '${resolvedSource.slug}' → ` +
        `abfss://${resolvedSource.container}@${resolvedSource.account}.dfs.core.windows.net/${resolvedSource.basePath}`
      );
    }
  }

  // Read existing Python content to preserve business logic
  let existingPy: string | undefined;
  if (fs.existsSync(paths.pythonJob)) {
    existingPy = fs.readFileSync(paths.pythonJob, "utf-8");
  }

  // Generate content
  const ownerAlias = (process.env["OWNER_ALIAS"] ?? "").toLowerCase() || undefined;
  const pythonContent = generatePython(manifest, existingPy, resolvedSource);
  const { content: dagContent } = generateDag(manifest, ownerAlias);
  const dqContent = paths.dqRules ? generateDqYaml(manifest) : null;

  let allUpToDate = true;

  if (check) {
    // ── Check mode: compare and report ──
    const checks: Array<{ label: string; path: string; generated: string }> = [
      { label: "Python job", path: paths.pythonJob, generated: pythonContent },
      { label: "Airflow DAG", path: paths.dag, generated: dagContent },
    ];
    if (paths.dqRules && dqContent) {
      checks.push({
        label: "DQ rules",
        path: paths.dqRules,
        generated: dqContent,
      });
    }

    for (const { label, path: filePath, generated } of checks) {
      if (!fs.existsSync(filePath)) {
        console.error(
          `[forge check] MISSING  ${label}: ${filePath}\n` +
            `  Run: forge generate --job ${manifest.name}`
        );
        allUpToDate = false;
        continue;
      }
      const existing = fs.readFileSync(filePath, "utf-8");
      if (isDifferent(existing, generated)) {
        console.error(
          `[forge check] STALE    ${label}: ${filePath}\n` +
            `  Run: forge generate --job ${manifest.name}`
        );
        allUpToDate = false;
      } else if (verbose) {
        console.log(`[forge check] OK       ${label}: ${filePath}`);
      }
    }
  } else {
    // ── Write mode ──
    const writes: Array<{ label: string; path: string; content: string; skipIfExists?: boolean }> = [
      { label: "Python job", path: paths.pythonJob, content: pythonContent },
      { label: "Airflow DAG", path: paths.dag, content: dagContent },
    ];
    if (paths.dqRules && dqContent) {
      // DQ rules are only written once — never overwritten (manual curation)
      writes.push({
        label: "DQ rules",
        path: paths.dqRules,
        content: dqContent,
        skipIfExists: true,
      });
    }

    for (const { label, path: filePath, content, skipIfExists } of writes) {
      if (skipIfExists && fs.existsSync(filePath)) {
        if (verbose) {
          console.log(`[forge generate] SKIP    ${label}: ${filePath} (already exists)`);
        }
        continue;
      }
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      console.log(`[forge generate] WROTE   ${label}: ${filePath}`);
    }
  }

  return allUpToDate;
}

// ---------------------------------------------------------------------------
// Manifest stub (used by `forge init`)
// ---------------------------------------------------------------------------

export function generateManifestStub(
  name: string,
  layer: "bronze" | "silver" | "gold"
): string {
  const scheduleLine =
    layer === "bronze"
      ? `  schedule: "0 2 * * *",  // Daily at 02:00 UTC`
      : layer === "silver"
      ? `  // schedule omitted — this job is triggered by upstream`
      : `  // schedule omitted — this job is triggered by upstream`;

  const sourcePart =
    layer === "bronze"
      ? `  source: {
    // Register your data source in the Forge portal (Data Sources tab) first,
    // then reference its slug here. forge generate fetches the connection details
    // (account, container, basePath) from the portal at codegen time.
    // sourcePath is appended after basePath; use {variable} placeholders for
    // runtime values (e.g. {_year}, {_month}, {PARTITION_DATE}).
    registeredSource: "<portal-data-source-slug>",
    sourcePath: "<sub-path>/{PARTITION_DATE}/*.parquet",
    name: "${name}",
    version: 1,
    format: "parquet",
    options: { mergeSchema: "true" },
  },`
      : layer === "silver"
      ? `  source: {
    type: "bronze",
    table: "lakehouse.bronze.<source_table>",
    filter: "partition_date = '{PARTITION_DATE}'",
  },`
      : `  source: {
    type: "silver",
    table: "lakehouse.silver.<source_table>",
    filter: "partition_date = '{PARTITION_DATE}'",
  },`;

  const dqPart =
    layer !== "bronze"
      ? `  dq: {
    rules: "orchestration/dq/rules/${name}.yaml",
    failFast: true,
  },\n  `
      : "  ";

  const triggeredByPart =
    layer === "silver"
      ? `  triggeredBy: "<upstream_bronze_dag_id>",\n  `
      : layer === "gold"
      ? `  triggeredBy: "<upstream_silver_dag_id>",\n  `
      : "";

  // Date column convention: use a real column name from the source data
  const partitionColumnHint =
    layer === "bronze" ? "event_date" : "event_date";

  return `import { defineJob } from "@forge/cli/schema";

export default defineJob({
  name: "${name}",
  layer: "${layer}",
  description: "TODO: describe what this job does",
  ${scheduleLine}
  tags: ["${layer}"],

  // PARTITION_DATE (and PARTITION_HOUR for hourly jobs) are automatically
  // injected by the generator — declare additional job-specific params here.
  params: {},

${sourcePart}

  // The generator derives partitionBy and replaceWhere from this block.
  // hasHour: false → __date = DD_MM_YYYY_00  (silver/gold) or __hour = PARTITION_HOUR literal (bronze)
  // hasHour: true  → hour extracted from the column itself (timestamp columns)
  partition: {
    column: "${partitionColumnHint}",  // date/timestamp column in your data
    hasHour: false,                    // true if column includes a time component to extract
  },

  output: {
    table: "lakehouse.${layer}.${name}",
  },

  ${dqPart}${triggeredByPart}resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },
});
`;
}
