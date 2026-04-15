"""
DAG: nyc_taxi_init
==================
One-time initialisation DAG for the NYC Taxi pipeline.

Registers the NYC Yellow Taxi Azure Open Dataset as a data source in the
Forge portal data_sources registry (POST /api/v1/datasources).  Idempotent —
skips registration if a source named 'nyc-taxi-yellow' already exists (409).

Run this DAG once before triggering nyc_taxi_bronze.  After registration the
source is visible in the portal under Data Sources and its slug 'nyc-taxi-yellow'
can be referenced by any pipeline.

Schedule:   @once (manual trigger)
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

import requests
from airflow import DAG
from airflow.operators.python import PythonOperator

log = logging.getLogger(__name__)

# Portal API — reachable within the cluster at the portal-api service.
_PORTAL_API = "http://portal-api.portal.svc.cluster.local:8080"

_SOURCES = [
    {
        "name": "nyc-taxi-yellow",
        "display_name": "NYC Yellow Taxi (Azure Open Datasets)",
        "description": (
            "NYC TLC Yellow Taxi trip records from Azure Open Datasets. "
            "Public parquet files partitioned by puYear/puMonth. "
            "No auth required — anonymous public access."
        ),
        "source_type": "adls_gen2",
        "config": {
            "account": "azureopendatastorage",
            "container": "nyctlc",
            "base_path": "/yellow",
            "format": "parquet",
        },
        "auth_type": "managed_identity",
        "credential_kv_secret": None,
    },
]


def register_sources() -> None:
    for src in _SOURCES:
        try:
            resp = requests.post(
                f"{_PORTAL_API}/api/v1/datasources",
                json=src,
                headers={"X-User-Email": "airflow@forge.internal", "Content-Type": "application/json"},
                timeout=30,
            )
            if resp.status_code == 201:
                log.info("registered source: %s", src["name"])
            elif resp.status_code == 409:
                log.info("source already registered (skipping): %s", src["name"])
            else:
                raise RuntimeError(
                    f"Unexpected status {resp.status_code} registering '{src['name']}': {resp.text}"
                )
        except requests.exceptions.ConnectionError:
            log.warning(
                "portal-api unreachable — skipping source registration for '%s'. "
                "Register manually via the Data Sources tab in the portal.",
                src["name"],
            )


with DAG(
    dag_id="nyc_taxi_init",
    description="One-time: register NYC Taxi data sources in the Forge portal registry",
    schedule="@once",
    start_date=datetime(2025, 1, 1),
    catchup=False,
    tags=["nyc-taxi", "init", "setup", "data-sources"],
    doc_md=__doc__,
) as dag:

    register = PythonOperator(
        task_id="register_data_sources",
        python_callable=register_sources,
    )
