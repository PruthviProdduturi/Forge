"""Data models for the Forge asset catalog."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ColumnInfo(BaseModel):
    """A single column in a lakehouse table."""
    name: str
    data_type: str
    nullable: bool = True
    comment: Optional[str] = None


class TableInfo(BaseModel):
    """A table in the Forge lakehouse."""
    name: str
    layer: str                          # bronze | silver | gold
    catalog: str = "delta"
    row_count: Optional[int] = None
    size_bytes: Optional[int] = None
    last_updated: Optional[datetime] = None
    has_dq: bool = False                # whether DQ checks are registered

    @property
    def full_name(self) -> str:
        """Fully-qualified Trino name: delta.<layer>.<table>"""
        return f"{self.catalog}.{self.layer}.{self.name}"


class DatasetInfo(BaseModel):
    """A dataset as returned by the Forge Portal API."""
    name: str
    layer: str
    schema: list[ColumnInfo] = []
    row_count: Optional[int] = None
    last_updated: Optional[str] = None
    size_bytes: Optional[int] = None
    has_dq: bool = False
