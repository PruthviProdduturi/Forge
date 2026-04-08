"""
forge_sdk.storage.adls — Thin ADLS Gen2 client for non-Spark operations.

Use :class:`ADLSClient` for lightweight file-system operations that do not
require a full SparkSession: existence checks, metadata reads, small file
uploads, and directory listings.

For bulk Spark reads/writes, use ``spark.read``/``spark.write`` directly
with paths from :mod:`forge_sdk.storage.paths`.

Authentication uses :class:`azure.identity.DefaultAzureCredential`, which
resolves to **Workload Identity** on AKS pods and ``az login`` credentials
during local development — no static secrets required.
"""
from __future__ import annotations

import logging
from typing import Iterator

from azure.identity import DefaultAzureCredential
from azure.storage.filedatalake import DataLakeServiceClient, FileSystemClient

from forge_sdk.config.platform import PlatformConfig

logger = logging.getLogger(__name__)


class ADLSClient:
    """
    Thin wrapper around ``azure-storage-file-datalake`` for non-Spark ADLS
    operations.

    Uses :class:`~azure.identity.DefaultAzureCredential` (Workload Identity
    on AKS, ``az login`` locally).  A single
    :class:`~azure.storage.filedatalake.DataLakeServiceClient` is created
    lazily on first use and reused for the lifetime of the instance.

    Args:
        config: Platform configuration. Defaults to
                :meth:`~forge_sdk.config.platform.PlatformConfig.from_env`.

    Example::

        from forge_sdk.storage.adls import ADLSClient

        client = ADLSClient()
        if client.exists("silver", "crm/orders_cleaned/_delta_log"):
            print("Delta table already initialised")
    """

    def __init__(self, config: PlatformConfig | None = None) -> None:
        self.config = config or PlatformConfig.from_env()
        self._credential = DefaultAzureCredential()
        self._service_client: DataLakeServiceClient | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @property
    def _client(self) -> DataLakeServiceClient:
        """Lazily initialised DataLakeServiceClient."""
        if self._service_client is None:
            account_url = (
                f"https://{self.config.adls_account}.dfs.core.windows.net"
            )
            self._service_client = DataLakeServiceClient(
                account_url=account_url,
                credential=self._credential,
            )
        return self._service_client

    def _fs(self, container: str) -> FileSystemClient:
        return self._client.get_file_system_client(file_system=container)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def exists(self, container: str, path: str) -> bool:
        """Check whether a file or directory exists.

        Args:
            container: Container name (bronze | silver | gold | …).
            path:      Path within the container.

        Returns:
            ``True`` if the path exists; ``False`` otherwise.
        """
        try:
            self._fs(container).get_file_client(path).get_file_properties()
            return True
        except Exception:
            # Attempt directory check if file check failed
            try:
                self._fs(container).get_directory_client(path).get_directory_properties()
                return True
            except Exception:
                return False

    def list_paths(
        self,
        container: str,
        path: str,
        recursive: bool = False,
    ) -> list[str]:
        """List files and directories under a path.

        Args:
            container: Container name.
            path:      Directory path to list.
            recursive: If ``True``, list all descendants recursively.

        Returns:
            Sorted list of path strings relative to the container root.
        """
        fs = self._fs(container)
        paths: list[str] = [
            p.name
            for p in fs.get_paths(path=path, recursive=recursive)
        ]
        return sorted(paths)

    def read_text(self, container: str, path: str) -> str:
        """Read a small text file and return its content as a string.

        Not intended for large files — use Spark for anything beyond a few MB.

        Args:
            container: Container name.
            path:      File path within the container.

        Returns:
            UTF-8 decoded file content.

        Raises:
            azure.core.exceptions.ResourceNotFoundError: If the path does not exist.
        """
        file_client = self._fs(container).get_file_client(path)
        download = file_client.download_file()
        content: bytes = download.readall()
        return content.decode("utf-8")

    def write_text(self, container: str, path: str, content: str) -> None:
        """Write a string to a file, creating parent directories as needed.

        Overwrites any existing file at the given path.

        Args:
            container: Container name.
            path:      Destination file path within the container.
            content:   UTF-8 string to write.
        """
        data = content.encode("utf-8")
        file_client = self._fs(container).get_file_client(path)
        file_client.upload_data(data, overwrite=True, length=len(data))
        logger.debug("Wrote %d bytes to %s/%s", len(data), container, path)

    def delete(self, container: str, path: str) -> None:
        """Delete a file or directory (recursively).

        A best-effort delete: if the path does not exist, the call is silently
        ignored.  This makes teardown logic idempotent.

        Args:
            container: Container name.
            path:      File or directory path within the container.
        """
        fs = self._fs(container)
        try:
            # Try as file first
            fs.get_file_client(path).delete_file()
            logger.debug("Deleted file %s/%s", container, path)
        except Exception:
            try:
                fs.get_directory_client(path).delete_directory()
                logger.debug("Deleted directory %s/%s", container, path)
            except Exception:
                logger.debug(
                    "delete(%s/%s): path not found or already deleted",
                    container,
                    path,
                )
