import { defineJob } from "../../../../../sdk/cli/src/schema.js";

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
    type: "bronze",
    table: "lakehouse.bronze.retail_orders",
    filter: "order_date = '{PARTITION_DATE}'",
  },
  partition: {
    column: "PARTITION_DATE",
    hasHour: false,
  },
  output: {
    table: "lakehouse.silver.retail_orders_cleaned",
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
