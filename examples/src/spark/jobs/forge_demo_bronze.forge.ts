import { defineJob } from "../../../../../sdk/cli/src/schema.js";

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
    type: "external",
    path: "synthetic://retail-orders/{PARTITION_DATE}",
    format: "parquet",
  },
  partition: {
    column: "PARTITION_DATE",
    hasHour: false,
  },
  output: {
    table: "lakehouse.bronze.retail_orders",
  },
  triggers: ["forge_demo_silver"],
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },
});
