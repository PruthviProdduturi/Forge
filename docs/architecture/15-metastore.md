# 15 — Hive Metastore

| Field   | Value         |
|---------|---------------|
| Version | 1.0           |
| Status  | Current       |
| Updated | 2026-03-31    |

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Cross-Cluster Access](#3-cross-cluster-access)
4. [Configuration](#4-configuration)
   - 4.1 [Spark](#41-spark)
   - 4.2 [Trino](#42-trino)
5. [Database](#5-database)
6. [Catalog Structure](#6-catalog-structure)
7. [Table Registration](#7-table-registration)
8. [Lineage Integration](#8-lineage-integration)
9. [Design Decisions](#9-design-decisions)

---

## 1. Overview

Hive Metastore (HMS) is the shared catalog that allows Spark (writer) and Trino (reader) to share table metadata across the Forge platform. Without HMS, Spark writes Delta files to ADLS Gen2 but Trino has no mechanism to discover table schemas, partition layouts, or storage locations.

HMS stores the following per table:

- Table and database names
- Column schemas and data types
- Partition keys and partition metadata
- ADLS storage paths (SerDe location)
- SerDe properties (format, input/output formats)

Delta Lake uses HMS as an external catalog. The actual data files and Delta transaction log remain in ADLS — HMS stores only the pointer and schema. Deleting an HMS entry does not delete the underlying data.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Compute Cluster (AKS)                    │
│                                                                 │
│  ┌──────────────────────┐        ┌──────────────────────────┐  │
│  │   Spark (Spark Op.)  │        │         Trino            │  │
│  │                      │        │                          │  │
│  │  1. Writes Delta     │        │  3. Reads HMS schema     │  │
│  │     to ADLS          │        │     via thrift (LB IP)   │  │
│  │  2. Registers table  │        │  4. Queries Delta files  │  │
│  │     in HMS via       │        │     directly from ADLS   │  │
│  │     thrift (LB IP)   │        │                          │  │
│  └──────────┬───────────┘        └────────────┬─────────────┘  │
│             │                                  │                │
└─────────────┼──────────────────────────────────┼────────────────┘
              │                                  │
              │  thrift://hms-lb-ip:9083          │  thrift://hms-lb-ip:9083
              │                                  │
              ▼                                  │
┌─────────────────────────────────────────────────────────────────┐
│                   Orchestration Cluster (AKS)                   │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              HMS StatefulSet (namespace: metastore)       │  │
│  │                  thrift port 9083                         │  │
│  │            exposed via internal LoadBalancer              │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │                                      │
│  ┌───────────────────────▼───────────────────────────────────┐  │
│  │         PostgreSQL — database: hive_metastore              │  │
│  │      (shared instance with Airflow and portal)            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
              │                                  │
              ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ADLS Gen2                                   │
│                                                                 │
│   abfss://bronze@{storage}.dfs.core.windows.net/               │
│   abfss://silver@{storage}.dfs.core.windows.net/               │
│   abfss://gold@{storage}.dfs.core.windows.net/                 │
│                                                                 │
│   Delta files + _delta_log/ (source of truth for data)         │
└─────────────────────────────────────────────────────────────────┘
```

HMS runs as a StatefulSet in the `metastore` namespace on the orchestration cluster. Its backend is the shared PostgreSQL instance (database: `hive_metastore`), which is the same PostgreSQL instance used for Airflow metadata and portal theme preferences.

---

## 3. Cross-Cluster Access

The compute cluster and orchestration cluster are separate AKS clusters. In-cluster DNS (`.svc.cluster.local`) does not resolve across cluster boundaries.

HMS is exposed via an **internal LoadBalancer** on the orchestration cluster VNet. Both clusters are in the same VNet (or peered VNets), so the compute cluster reaches HMS via the LoadBalancer's private IP on port 9083.

| Client          | Cluster       | HMS address used                                        |
|-----------------|---------------|---------------------------------------------------------|
| Airflow DAGs    | Orchestration | `thrift://hive-metastore.metastore.svc.cluster.local:9083` |
| Spark jobs      | Compute       | `thrift://<hms-lb-ip>:9083` (via Airflow variable `{{ var.value.get('hms_thrift_uri') }}`) |
| Trino           | Compute       | `thrift://<hms-lb-ip>:9083` (configured in lakehouse catalog properties) |

The `hms_thrift_uri` Airflow variable holds the internal LB IP and is injected into SparkApplication manifests at DAG render time. This avoids hardcoding the LB IP across multiple job specs.

---

## 4. Configuration

### 4.1 Spark

The following `sparkConf` block is added to all SparkApplication specs. The `hive.metastore.uris` value is templated via the Airflow variable at DAG render time.

```yaml
sparkConf:
  spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
  spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
  spark.hadoop.hive.metastore.uris: thrift://hive-metastore.metastore.svc.cluster.local:9083
  spark.sql.hive.metastore.version: "3.1.3"
  spark.sql.hive.metastore.jars: builtin
```

> Note: The `hive.metastore.uris` value shown above uses the in-cluster DNS form for illustration. In practice, Spark jobs on the compute cluster receive the LB IP via `{{ var.value.get('hms_thrift_uri') }}`.

`spark.sql.hive.metastore.jars: builtin` tells Spark to use the HMS client libraries bundled with the Spark distribution rather than downloading them at runtime.

### 4.2 Trino

HMS is configured in the `lakehouse` catalog properties file on the compute cluster:

```properties
connector.name=delta_lake
hive.metastore.uri=thrift://hive-metastore.metastore.svc.cluster.local:9083
delta.hide-non-delta-tables=false
hive.metastore-timeout=10s
```

> As with Spark, the actual `hive.metastore.uri` value in the deployed catalog properties uses the internal LB IP, not `.svc.cluster.local`.

`delta.hide-non-delta-tables=false` allows Trino to surface any non-Delta tables present in HMS (e.g., legacy or external tables). `hive.metastore-timeout=10s` sets the upper bound for thrift calls before Trino returns an error rather than hanging.

---

## 5. Database

HMS uses a dedicated database within the shared PostgreSQL instance:

| Property      | Value            |
|---------------|------------------|
| Database name | `hive_metastore` |
| Instance      | Shared PostgreSQL (also hosts `airflow` and `portal` databases) |
| Schema owner  | HMS (manages its own DDL on first start via `initSchema`) |

HMS manages its own schema internally. Key tables include `DBS`, `TBLS`, `COLUMNS_V2`, `PARTITIONS`, `SDS`, and associated metadata tables. These are created and migrated by HMS automatically — do not modify them directly.

---

## 6. Catalog Structure

The `lakehouse` catalog in Trino reflects the medallion layers as HMS databases. All tables are Delta format.

```
lakehouse
├── bronze
│   └── retail_orders              (Delta, partitioned by order_date)
├── silver
│   └── retail_orders_cleaned      (Delta, partitioned by order_date)
├── gold
│   ├── retail_daily_sales
│   ├── retail_product_performance
│   └── retail_regional_metrics
└── _dq
    └── *_results                  (DQ run results, written by forge_dq)
```

Each layer corresponds to an ADLS Gen2 container (`bronze`, `silver`, `gold`). The `_dq` database holds quality check results written by the `forge_dq` framework.

---

## 7. Table Registration

Spark jobs write and register tables in a single operation using `saveAsTable`:

```python
df.write.format("delta") \
    .partitionBy("order_date") \
    .mode("overwrite") \
    .saveAsTable("lakehouse.bronze.retail_orders")
```

This call:
1. Writes Delta files to the ADLS path derived from the catalog/database/table name.
2. Writes the Delta transaction log at `abfss://{layer}@{storage}.dfs.core.windows.net/{table}/_delta_log/`.
3. Registers the table in HMS with the schema, location, and SerDe properties.

**HMS is the pointer; ADLS is the source of truth.** If an HMS entry is dropped, the data and transaction log remain intact in ADLS. The table can be re-registered by running `CREATE TABLE ... LOCATION ...` or by re-running the Spark job.

---

## 8. Lineage Integration

OpenLineage events emitted by Spark and Airflow use HMS table names as dataset identifiers, not raw ADLS paths. This means the lineage graph in Microsoft Purview shows human-readable names:

```
lakehouse.silver.retail_orders_cleaned  →  lakehouse.gold.retail_daily_sales
```

rather than:

```
abfss://silver@{storage}.dfs.core.windows.net/retail_orders_cleaned  →  abfss://gold@...
```

This is a direct consequence of using `saveAsTable` (which registers in HMS) rather than `save` with an explicit path. Jobs that write directly to ADLS paths without HMS registration will appear as ABFS URIs in the lineage graph.

---

## 9. Design Decisions

**Why HMS and not Unity Catalog or another catalog?**

Forge runs on open-source Apache Spark, not Databricks Runtime. Unity Catalog requires Databricks Runtime and cannot be used with the Spark Operator. HMS is the standard open-source catalog for Spark + Trino interoperability, and Delta Lake supports it natively. HMS was chosen for vendor neutrality — no lock-in to Databricks or any other managed platform.

**Why share the PostgreSQL instance?**

A dedicated PostgreSQL instance for HMS alone would be operationally disproportionate given HMS's low write volume (schema registration events, not query-time writes). The shared PostgreSQL instance with database-level isolation provides adequate separation. If HMS schema migration or failover requirements diverge from Airflow's, a separate instance can be provisioned without architectural changes to HMS itself.
