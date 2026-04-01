import { defineJob } from "../../../../sdk/cli/src/schema.js";

export default defineJob({
  name: "forge_demo_bronze",
  layer: "bronze",
  description: "Daily ingestion of synthetic retail orders into the bronze Delta layer",
  schedule: "0 2 * * *",
  tags: ["forge-demo", "retail", "daily", "synthetic"],
  params: {
    PARTITION_DATE: {
      type: "string",
      default: "",
      description: "Target date (yyyy-MM-dd). Defaults to data_interval_start.",
    },
  },
  source: {
    name: "ForgeDemoRaw",
    version: 1,
    path: {
      container: "raw",
      category: "Demo",
      entity: "Event",
      audience: "Public",
      metricsCohort: "Demo",
      assetName: "ForgeDemo",
    },
    format: "parquet",
  },
  partition: {
    column: "PARTITION_DATE",
    hasHour: false,
  },
  output: {
    name: "ForgeDemoBronze",
    version: 1,
    path: {
      container: "bronze",
      category: "Demo",
      entity: "Event",
      audience: "Internal",
      metricsCohort: "Demo",
      assetName: "ForgeDemo",
    },
  },
  triggers: ["forge_demo_silver"],
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },
});
