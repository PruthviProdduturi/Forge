#!/usr/bin/env node
/**
 * Forge CLI — entry point
 *
 * Commands:
 *   forge generate [--job <name>] [--dir <path>] [--check]
 *   forge init --name <name> --layer <bronze|silver|gold>
 */
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { loadManifest, validateManifest, generateJob, generateManifestStub } from "./generate.js";

const program = new Command();

program
  .name("forge")
  .description("Forge Platform — job scaffolding CLI")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// forge generate
// ---------------------------------------------------------------------------
program
  .command("generate")
  .description(
    "Generate Python job, Airflow DAG, and DQ rules from a .forge.ts manifest"
  )
  .option(
    "--job <name>",
    "Job name (snake_case). Looks for <name>.forge.ts in --manifest-dir."
  )
  .option(
    "--manifest <path>",
    "Direct path to a .forge.ts manifest file (overrides --job)"
  )
  .option(
    "--manifest-dir <path>",
    "Directory to search for .forge.ts files",
    "examples/src/spark/jobs"
  )
  .option(
    "--dir <path>",
    "Root output directory (examples/ subdirs used for output)",
    "examples"
  )
  .option(
    "--check",
    "Diff mode: exit 1 if generated output differs from committed files"
  )
  .option("--verbose", "Print detailed status for every file")
  .action(async (opts) => {
    // Resolve manifest path(s)
    let manifestPaths: string[] = [];

    if (opts.manifest) {
      manifestPaths = [path.resolve(opts.manifest)];
    } else if (opts.job) {
      const candidatePath = path.resolve(
        opts.manifestDir,
        `${opts.job}.forge.ts`
      );
      if (!fs.existsSync(candidatePath)) {
        console.error(`[forge] Manifest not found: ${candidatePath}`);
        process.exit(1);
      }
      manifestPaths = [candidatePath];
    } else {
      // Process all .forge.ts files in manifestDir
      const dir = path.resolve(opts.manifestDir);
      if (!fs.existsSync(dir)) {
        console.error(`[forge] Manifest directory not found: ${dir}`);
        process.exit(1);
      }
      manifestPaths = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".forge.ts"))
        .map((f) => path.join(dir, f));

      if (manifestPaths.length === 0) {
        console.error(`[forge] No .forge.ts files found in ${dir}`);
        process.exit(1);
      }
    }

    const outputDir = path.resolve(opts.dir);
    const check: boolean = opts.check ?? false;
    const verbose: boolean = opts.verbose ?? false;

    let anyStale = false;

    for (const manifestPath of manifestPaths) {
      try {
        const raw = await loadManifest(manifestPath);
        const manifest = validateManifest(raw);
        const upToDate = await generateJob(manifest, { outputDir, check, verbose });
        if (!upToDate) anyStale = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[forge] Error processing ${manifestPath}:\n  ${msg}`);
        process.exit(1);
      }
    }

    if (check && anyStale) {
      console.error(
        "\n[forge check] FAILED — one or more generated files are stale.\n" +
          "Run `forge generate` to regenerate, then commit the results."
      );
      process.exit(1);
    }

    if (check && !anyStale) {
      console.log("[forge check] PASSED — all generated files are up to date.");
    }
  });

// ---------------------------------------------------------------------------
// forge init
// ---------------------------------------------------------------------------
program
  .command("init")
  .description("Create a new .forge.ts manifest stub")
  .requiredOption("--name <name>", "Job name (snake_case, e.g. my_dataset_silver)")
  .requiredOption(
    "--layer <layer>",
    "Medallion layer: bronze | silver | gold"
  )
  .option(
    "--manifest-dir <path>",
    "Directory to write the manifest into",
    "examples/src/spark/jobs"
  )
  .action((opts) => {
    const { name, layer, manifestDir } = opts;

    // Validate name
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      console.error(
        `[forge] Invalid job name "${name}" — must be snake_case (e.g. my_dataset_silver)`
      );
      process.exit(1);
    }

    // Validate layer
    if (!["bronze", "silver", "gold"].includes(layer)) {
      console.error(
        `[forge] Invalid layer "${layer}" — must be bronze, silver, or gold`
      );
      process.exit(1);
    }

    const outDir = path.resolve(manifestDir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${name}.forge.ts`);

    if (fs.existsSync(outPath)) {
      console.error(`[forge] Manifest already exists: ${outPath}`);
      process.exit(1);
    }

    const stub = generateManifestStub(
      name,
      layer as "bronze" | "silver" | "gold"
    );
    fs.writeFileSync(outPath, stub, "utf-8");
    console.log(`[forge init] CREATED  ${outPath}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Edit ${outPath} with your job details`);
    console.log(
      `  2. Run: forge generate --job ${name} --dir examples`
    );
    console.log(`  3. Implement your transforms in the FORGE:BUSINESS_LOGIC block`);
    console.log(`  4. Add CI step: forge generate --check --job ${name}`);
  });

program.parse(process.argv);
