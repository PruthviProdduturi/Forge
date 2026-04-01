import { defineJob } from "../../../../sdk/cli/src/schema.js";

export default defineJob({
  name: "nyc_taxi_bronze",
  layer: "bronze",
  description: "Daily ingestion of NYC TLC trip data from Azure Open Datasets, partitioned by pickup date",
  schedule: "0 2 * * *",
  tags: ["nyc-taxi", "daily", "open-datasets"],
  params: {
    // PARTITION_DATE is auto-injected by the generator (yyyy-MM-dd, set from Airflow data_interval_start)
    TAXI_TYPE: { type: "string", default: "yellow", description: "yellow | green | fhv | hvfhv" },
  },
  source: {
    type: "external",
    path: "wasbs://nyctlc@azureopendatastore.blob.core.windows.net/{TAXI_TYPE}/*.parquet",
    format: "parquet",
    options: { mergeSchema: "true" },
  },

  // The generator derives:
  //   partitionBy(["pickup_datetime"])
  //   replaceWhere "pickup_datetime = '{PARTITION_DATE}'"
  partition: {
    column: "pickup_datetime",
    hasHour: false,
  },

  output: {
    table: "lakehouse.bronze.nyc_taxi",
  },

  triggers: ["nyc_taxi_silver"],
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },
});
