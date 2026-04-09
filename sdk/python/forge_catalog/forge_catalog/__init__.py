"""
forge-catalog: Forge Asset Catalog SDK

Lightweight discovery layer for the Forge lakehouse.  No PySpark dependency —
install this in any environment (notebooks, CI scripts, future SDKs) to browse
and search data assets before building new pipelines or contracts.

Quick start::

    import os
    os.environ["FORGE_COMPUTE_HOST"] = "forge-compute-prproddudev.westcentralus.cloudapp.azure.com"
    os.environ["FORGE_PORTAL_URL"]   = "https://forge-portal-dev.westcentralus.cloudapp.azure.com"

    from forge_catalog import ForgeCatalog

    catalog = ForgeCatalog()

    # What tables exist?
    for t in catalog.tables():
        print(t.layer, t.name, t.row_count)

    # What columns does silver.orders have?
    for col in catalog.schema("silver", "orders"):
        print(col.name, col.data_type)

    # Search for anything orders-related
    matches = catalog.search("orders")

Public API:
    ForgeCatalog  — main client (Trino + Portal API backed)
    TableInfo     — table metadata model
    ColumnInfo    — column metadata model
    DatasetInfo   — portal dataset model
"""
from forge_catalog.catalog import ForgeCatalog
from forge_catalog.models import ColumnInfo, DatasetInfo, TableInfo

__version__ = "1.0.0"

__all__ = [
    "ForgeCatalog",
    "TableInfo",
    "ColumnInfo",
    "DatasetInfo",
]
