import { defineJob } from "../../../../sdk/cli/src/schema.js";

export default defineJob({
  name: "forge_demo_silver",
  layer: "silver",
  description: "Clean and deduplicate retail orders bronze partition into the silver layer",
  tags: ["forge-demo", "retail", "daily"],
  params: {
    PARTITION_DATE: {
      type: "string",
      default: "",
      description: "Partition date (yyyy-MM-dd) — set by Airflow data_interval_start",
    },
  },
  source: {
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
  partition: {
    column: "PARTITION_DATE",
    hasHour: false,
  },
  output: {
    name: "ForgeDemoEvents",
    version: 1,
    path: {
      container: "silver",
      category: "Demo",
      entity: "Event",
      audience: "Analytics",
      metricsCohort: "Demo",
      assetName: "ForgeDemo",
    },
  },
  dq: {
    rules: "orchestration/dq/rules/forge_demo_silver.yaml",
    failFast: true,
  },
  triggeredBy: "forge_demo_bronze",
  triggers: ["forge_demo_gold"],
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },
});
