import { defineJob } from "../../../../sdk/cli/src/schema.js";

export default defineJob({
  name: "nyc_taxi_silver",
  layer: "silver",
  description: "Clean, deduplicate and union all NYC taxi types into a unified silver trips table",
  tags: ["nyc-taxi", "monthly"],
  params: {
    PARTITION_YEAR:  { type: "int", default: 2023 },
    PARTITION_MONTH: { type: "int", default: 1 },
  },
  source: {
    name: "NycTaxiBronze",
    version: 1,
    path: {
      container: "bronze",
      category: "Transport",
      entity: "Trip",
      audience: "Internal",
      metricsCohort: "Rideshare",
      assetName: "NycTaxi",
    },
    filter: "__year = {_year} AND __month = {_month} AND __day = {_day}",
  },
  partition: {
    column: "PARTITION_MONTH",
    hasHour: false,
  },

  output: {
    name: "NycTaxiTrips",
    version: 1,
    path: {
      container: "silver",
      category: "Transport",
      entity: "Trip",
      audience: "Analytics",
      metricsCohort: "Rideshare",
      assetName: "NycTaxi",
    },
  },
  dq: { rules: "orchestration/dq/rules/nyc_taxi_silver.yaml" },
  triggeredBy: "nyc_taxi_bronze",
  triggers: ["nyc_taxi_gold"],
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 3 },
  },
});
