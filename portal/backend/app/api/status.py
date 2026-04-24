"""Cluster and workload status endpoint.

Returns live status for both the orchestration cluster (queried via
in-cluster Kubernetes API) and the compute cluster (queried via the
Azure Management API using the portal workload identity).

The portal managed identity requires:
  - Reader on: rg-forge-{env} (or both AKS resources) — for Azure Resource API
  - K8s RBAC: ClusterRole forge-portal-reader bound to portal-api ServiceAccount
    (grants get/list/watch pods + deployments in key orchestration namespaces)
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
import structlog
from fastapi import APIRouter

from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/status", tags=["status"])

# ---------------------------------------------------------------------------
# Kubernetes in-cluster helpers (orchestration cluster)
# ---------------------------------------------------------------------------

def _k8s_orch_status() -> dict[str, Any]:
    """List pods across key orchestration namespaces using in-cluster config."""
    try:
        from kubernetes import client as k8s_client, config as k8s_config  # type: ignore

        k8s_config.load_incluster_config()
        v1 = k8s_client.CoreV1Api()

        namespaces = ["airflow", "portal", "dq", "monitoring"]
        result: dict[str, list[dict[str, str]]] = {}

        for ns in namespaces:
            try:
                pods = v1.list_namespaced_pod(namespace=ns, timeout_seconds=5)
                result[ns] = [
                    {
                        "name": p.metadata.name,
                        "phase": p.status.phase or "Unknown",
                        "ready": _pod_ready(p),
                    }
                    for p in pods.items
                ]
            except Exception as exc:
                result[ns] = [{"error": str(exc)}]

        return {"reachable": True, "namespaces": result}

    except Exception as exc:
        # Not in-cluster (local dev) or RBAC issue
        log.warning("k8s_incluster_unavailable", error=str(exc))
        return {"reachable": False, "error": str(exc)}


def _pod_ready(pod: Any) -> bool:
    if not pod.status.conditions:
        return False
    return any(
        c.type == "Ready" and c.status == "True"
        for c in pod.status.conditions
    )


# ---------------------------------------------------------------------------
# Azure Management API helpers (compute cluster)
# ---------------------------------------------------------------------------

async def _azure_compute_cluster_status() -> dict[str, Any]:
    """Fetch compute AKS cluster + node pool state via Azure Resource API.

    Requires the portal managed identity to have Reader on the compute cluster
    resource (or on rg-forge-{env}).  If permissions are missing, returns a
    degraded entry rather than raising.
    """
    sub = settings.subscription_id
    rg = settings.resource_group
    cluster = settings.compute_cluster_name

    if not all([sub, rg, cluster]):
        return {"reachable": False, "error": "compute_cluster_name / subscription_id / resource_group not configured"}

    try:
        from azure.identity import ManagedIdentityCredential  # type: ignore
        from azure.mgmt.containerservice import ContainerServiceClient  # type: ignore

        credential = ManagedIdentityCredential(client_id=settings.azure_client_id or None)
        aks = ContainerServiceClient(credential, sub)

        cluster_obj = await asyncio.to_thread(aks.managed_clusters.get, rg, cluster)
        pools = await asyncio.to_thread(
            lambda: list(aks.agent_pools.list(rg, cluster))
        )

        return {
            "reachable": True,
            "provisioning_state": cluster_obj.provisioning_state,
            "kubernetes_version": cluster_obj.kubernetes_version,
            "fqdn": cluster_obj.fqdn,
            "node_pools": [
                {
                    "name": p.name,
                    "provisioning_state": p.provisioning_state,
                    "vm_size": p.vm_size,
                    "count": p.count,
                    "min_count": p.min_count,
                    "max_count": p.max_count,
                    "mode": p.mode,
                }
                for p in pools
            ],
        }

    except Exception as exc:
        log.warning("azure_compute_status_failed", error=str(exc))
        return {"reachable": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# HTTP probes for compute workloads
# The orchestration cluster subnet (10.2.x.x) can reach the compute subnet
# (10.1.x.x) but Kubernetes ClusterIP services are not routable cross-cluster.
# These probes target the AKS internal LoadBalancer IPs or well-known endpoints
# that ARE exposed cross-cluster (e.g. Trino internal LB, Spark Connect LB).
# Configured via env vars; gracefully skipped if not set.
# ---------------------------------------------------------------------------

async def _probe_http(name: str, url: str, timeout: float = 4.0) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url)
            return {"name": name, "reachable": True, "status_code": resp.status_code}
    except Exception as exc:
        return {"name": name, "reachable": False, "error": str(exc)}


async def _compute_workload_probes() -> list[dict[str, Any]]:
    """HTTP liveness probes for well-known compute endpoints."""
    import os

    probes = []

    # Trino internal LB (set TRINO_INTERNAL_URL env var when internal LB is deployed)
    trino_url = os.getenv("TRINO_INTERNAL_URL", "")
    if trino_url:
        probes.append(_probe_http("trino", f"{trino_url}/v1/info"))

    # Spark Connect internal LB
    spark_url = os.getenv("SPARK_CONNECT_INTERNAL_URL", "")
    if spark_url:
        probes.append(_probe_http("spark-connect", f"{spark_url}/"))

    # Hive Metastore thrift is not HTTP — skip; HMS health is inferred from Trino

    if not probes:
        return []

    return list(await asyncio.gather(*probes))


# ---------------------------------------------------------------------------
# Clear failed pods endpoint
# ---------------------------------------------------------------------------

@router.delete("/clear-failed")
async def clear_failed_pods() -> dict[str, Any]:
    """Delete all Failed-phase pods in orchestration namespaces.

    Requires the portal service account to have pod/delete RBAC in these
    namespaces (add ``delete`` to the forge-portal-reader ClusterRole verbs).
    """
    try:
        from kubernetes import client as k8s_client, config as k8s_config  # type: ignore

        k8s_config.load_incluster_config()
        v1 = k8s_client.CoreV1Api()

        namespaces = ["airflow", "portal", "dq", "monitoring"]
        deleted = 0
        affected: list[str] = []

        for ns in namespaces:
            try:
                pods = v1.list_namespaced_pod(namespace=ns, timeout_seconds=5)
                for p in pods.items:
                    if p.status.phase == "Failed":
                        v1.delete_namespaced_pod(
                            name=p.metadata.name,
                            namespace=ns,
                            grace_period_seconds=0,
                        )
                        deleted += 1
                        if ns not in affected:
                            affected.append(ns)
            except Exception as exc:
                log.warning("clear_failed_pods_ns_error", ns=ns, error=str(exc))

        log.info("cleared_failed_pods", deleted=deleted)
        return {"deleted": deleted, "namespaces": affected}

    except Exception as exc:
        log.warning("clear_failed_pods_failed", error=str(exc))
        return {"deleted": 0, "namespaces": [], "error": str(exc)}


# ---------------------------------------------------------------------------
# Main endpoint
# ---------------------------------------------------------------------------

@router.get("")
async def cluster_status() -> dict[str, Any]:
    """Return live status for both clusters and key workloads."""
    orch_task = asyncio.to_thread(_k8s_orch_status)
    compute_azure_task = _azure_compute_cluster_status()
    compute_probes_task = _compute_workload_probes()

    orch, compute_azure, compute_probes = await asyncio.gather(
        orch_task,
        compute_azure_task,
        compute_probes_task,
    )

    log.info(
        "status_check",
        orch_reachable=orch.get("reachable"),
        compute_reachable=compute_azure.get("reachable"),
    )

    return {
        "env": settings.forge_env,
        "orchestration_cluster": orch,
        "compute_cluster": {
            "azure_resource": compute_azure,
            "workload_probes": compute_probes,
        },
    }
