import { defineJob } from "../../../../../sdk/cli/src/schema.js";

export default defineJob({
  name: "nyc_taxi_gold",
  layer: "gold",
  description: "NYC taxi gold aggregations: daily_summary, hourly_demand, zone_stats, payment_summary",
  tags: ["nyc-taxi", "monthly", "analytics"],
  params: {
    PARTITION_YEAR:  { type: "int",    default: 2023 },
    PARTITION_MONTH: { type: "int",    default: 1 },
    GOLD_TABLE:      { type: "string", required: true, description: "daily_summary | hourly_demand | zone_stats | payment_summary" },
  },
  source: {
    type: "silver",
    table: "lakehouse.silver.nyc_taxi_trips",
    filter: "PARTITION_YEAR = {PARTITION_YEAR} AND PARTITION_MONTH = {PARTITION_MONTH}",
  },
  partition: {
    column: "PARTITION_MONTH",
    granularity: "day",
  },

  output: {
    table: "lakehouse.gold.nyc_taxi_{GOLD_TABLE}",
  },
  triggeredBy: "nyc_taxi_silver",
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },
});
