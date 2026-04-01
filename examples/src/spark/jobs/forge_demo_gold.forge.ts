import { defineJob } from "../../../../sdk/cli/src/schema.js";

export default defineJob({
  name: "forge_demo_gold",
  layer: "gold",
  description: "Retail orders gold aggregations: daily_sales, product_performance, regional_metrics",
  tags: ["forge-demo", "retail", "daily", "analytics"],
  params: {
    PARTITION_DATE: {
      type: "string",
      default: "",
      description: "Partition date (yyyy-MM-dd) — set by Airflow data_interval_start",
    },
    GOLD_TABLE: {
      type: "string",
      required: true,
      description: "daily_sales | product_performance | regional_metrics",
    },
  },
  source: {
    type: "silver",
    table: "lakehouse.silver.retail_orders_cleaned",
    filter: "order_date = '{PARTITION_DATE}'",
  },
  partition: {
    column: "PARTITION_DATE",
    hasHour: false,
  },
  output: {
    table: "lakehouse.gold.retail_{GOLD_TABLE}",
  },
  dq: {
    rules: "orchestration/dq/rules/forge_demo_gold.yaml",
    failFast: true,
  },
  triggeredBy: "forge_demo_silver",
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },
});
