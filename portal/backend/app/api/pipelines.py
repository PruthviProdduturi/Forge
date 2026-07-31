"""Pipeline (Airflow DAG) API routes."""

from __future__ import annotations

import asyncio
import ssl
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services import airflow_client

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/pipelines", tags=["pipelines"])
settings = get_settings()

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


class TriggerRequest(BaseModel):
    conf: dict[str, Any] = {}
    force: bool = False  # if True, cancel active run for this slot first then retrigger


class RestateRequest(BaseModel):
    from_date: str  # YYYY-MM-DD
    to_date: str  # YYYY-MM-DD
    conf: dict[str, Any] = {}


class RegisterRequest(BaseModel):
    dag_id: str
    owner_alias: str = ""


# ---------------------------------------------------------------------------
# Postgres helpers — pipeline_deployments table (same pattern as theme.py)
# ---------------------------------------------------------------------------


async def _pg_token() -> str:
    from azure.identity import WorkloadIdentityCredential  # type: ignore

    cred = WorkloadIdentityCredential()
    token_obj = await asyncio.to_thread(
        cred.get_token, "https://ossrdbms-aad.database.windows.net/.default"
    )
    return token_obj.token


async def _pg_connect():  # type: ignore[return]
    if not settings.pg_host or not settings.pg_user:
        return None
    try:
        import asyncpg  # type: ignore

        token = await _pg_token()
        ssl_ctx = ssl.create_default_context()
        conn = await asyncpg.connect(
            host=settings.pg_host,
            port=5432,
            database="portal",
            user=settings.pg_user,
            password=token,
            ssl=ssl_ctx,
        )
        return conn
    except Exception as exc:
        log.warning("pg_connect_failed", error=str(exc))
        return None


async def _ensure_deployments_table(conn: Any) -> None:
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS pipeline_deployments (
            dag_id       TEXT PRIMARY KEY,
            owner_email  TEXT NOT NULL,
            owner_alias  TEXT NOT NULL DEFAULT '',
            deployed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at   TIMESTAMPTZ
        )
    """)
    # Add deleted_at if upgrading from older schema
    await conn.execute("""
        ALTER TABLE pipeline_deployments
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    """)


def _summarise_dag(dag: dict[str, Any], runs: list[dict[str, Any]]) -> dict[str, Any]:
    last_run = runs[0] if runs else None
    last_run_state = None
    last_run_at = None
    if last_run:
        last_run_state = last_run.get("state")
        # Use logical_date as fallback so queued/running runs (no start_date yet) still show a date
        last_run_at = (
            last_run.get("start_date")
            or last_run.get("execution_date")
            or last_run.get("logical_date")
        )

    tags = [t.get("name", "") for t in dag.get("tags", [])]

    return {
        "dag_id": dag.get("dag_id", ""),
        "description": dag.get("description") or "",
        "is_active": not dag.get("is_paused", True),
        "is_paused": dag.get("is_paused", False),
        "last_run_state": last_run_state,
        "last_run_at": last_run_at,
        "last_run_id": last_run.get("dag_run_id") if last_run else None,
        "next_run_at": dag.get("next_dagrun"),
        "schedule": dag.get("schedule_interval") or dag.get("timetable_description"),
        "tags": tags,
    }


@router.get("")
async def list_pipelines(current_user: CurrentUser) -> list[dict[str, Any]]:
    """List all DAGs with their last run state, excluding soft-deleted pipelines."""
    try:
        dags = await airflow_client.get_dags(limit=100, only_active=False)
    except Exception as exc:
        log.error("list_pipelines_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc

    # Exclude any DAGs the user has deleted from the portal.
    # These remain in Airflow/ADLS until the next full deploy applies the RBAC-enabled
    # ADLS deletion, but we hide them immediately via the DB soft-delete flag.
    deleted_ids: set[str] = set()
    conn = await _pg_connect()
    if conn is not None:
        try:
            await _ensure_deployments_table(conn)
            rows = await conn.fetch(
                "SELECT dag_id FROM pipeline_deployments WHERE deleted_at IS NOT NULL"
            )
            deleted_ids = {r["dag_id"] for r in rows}
        except Exception as exc:
            log.warning("pg_deleted_ids_failed", error=str(exc))
        finally:
            await conn.close()

    active_dags = [d for d in dags if d.get("dag_id", "") not in deleted_ids]

    async def _fetch_run(dag: dict[str, Any]) -> dict[str, Any]:
        dag_id = dag.get("dag_id", "")
        try:
            runs = await airflow_client.get_dag_runs(dag_id, limit=1)
        except Exception:
            runs = []
        return _summarise_dag(dag, runs)

    results = await asyncio.gather(*[_fetch_run(d) for d in active_dags])
    return list(results)


@router.post("/register", status_code=200)
async def register_pipeline(
    body: RegisterRequest, current_user: CurrentUser
) -> dict[str, str]:
    """Register (or re-register) a DAG deployment. Called by sync-jobs.sh via Bearer token."""
    email = current_user.get("email", "") or current_user.get("preferred_username", "")
    # Prefer explicit alias from caller; fall back to UPN prefix (e.g. prproddu@tenant → prproddu)
    upn = current_user.get("preferred_username", "") or email
    alias = body.owner_alias or upn.split("@")[0] or current_user.get("name", "")
    conn = await _pg_connect()
    if conn is not None:
        try:
            await _ensure_deployments_table(conn)
            await conn.execute(
                """
                INSERT INTO pipeline_deployments (dag_id, owner_email, owner_alias, deployed_at, deleted_at)
                VALUES ($1, $2, $3, now(), NULL)
                ON CONFLICT (dag_id) DO UPDATE
                  SET owner_email = EXCLUDED.owner_email,
                      owner_alias = EXCLUDED.owner_alias,
                      deployed_at = now(),
                      deleted_at  = NULL
            """,
                body.dag_id,
                email,
                alias,
            )
            log.info("pipeline_registered", dag_id=body.dag_id, owner=email)
        except Exception as exc:
            log.warning("pg_register_pipeline_failed", error=str(exc))
        finally:
            await conn.close()
    return {"dag_id": body.dag_id, "owner_email": email}


@router.get("/mine")
async def list_mine(current_user: CurrentUser) -> list[str]:
    """Return dag_ids owned by the current user.

    Fallback: if no pipeline_deployments rows exist for this user AND the user
    is Admin/Editor, return all Airflow DAGs so the count is correct before
    any explicit registration via sync-jobs.sh.
    """
    email = current_user.get("email", "")
    conn = await _pg_connect()
    if conn is None:
        return []
    try:
        await _ensure_deployments_table(conn)
        rows = await conn.fetch(
            "SELECT dag_id FROM pipeline_deployments WHERE owner_email = $1 AND deleted_at IS NULL",
            email,
        )
        if rows:
            return [r["dag_id"] for r in rows]

        # No registrations for this user — fall back to all Airflow DAGs for Admin/Editor
        roles = current_user.get("roles", [])
        if isinstance(roles, str):
            roles = [roles]
        if any(r.lower() in ("admin", "editor") for r in roles):
            try:
                dags = await airflow_client.get_dags(limit=200, only_active=False)
                return [d.get("dag_id", "") for d in dags if d.get("dag_id")]
            except Exception:
                pass
        return []
    except Exception as exc:
        log.warning("pg_list_mine_failed", error=str(exc))
        return []
    finally:
        await conn.close()


@router.get("/mine/count")
async def count_mine(current_user: CurrentUser) -> dict[str, int]:
    """Return the number of DAGs owned by the current user. Used by sync-jobs.sh for DAG limit check."""
    email = current_user.get("email", "")
    conn = await _pg_connect()
    if conn is None:
        return {"count": 0}
    try:
        await _ensure_deployments_table(conn)
        row = await conn.fetchrow(
            "SELECT COUNT(*) as count FROM pipeline_deployments WHERE owner_email = $1 AND deleted_at IS NULL",
            email,
        )
        return {"count": int(row["count"])}
    except Exception as exc:
        log.warning("pg_count_mine_failed", error=str(exc))
        return {"count": 0}
    finally:
        await conn.close()


@router.get("/{dag_id}")
async def get_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Get a single DAG with recent runs and ownership info."""
    try:
        dag = await airflow_client.get_dag(dag_id)
    except Exception as exc:
        log.error("get_pipeline_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc

    # Fetch runs, task defs, and ownership in parallel
    async def _get_runs() -> list[dict[str, Any]]:
        try:
            return await airflow_client.get_dag_runs(dag_id, limit=90)
        except Exception:
            return []

    async def _get_tasks_def() -> list[dict[str, Any]]:
        try:
            return await airflow_client.get_dag_tasks(dag_id)
        except Exception:
            return []

    async def _get_ownership() -> dict[str, Any]:
        conn = await _pg_connect()
        if conn is None:
            return {}
        try:
            await _ensure_deployments_table(conn)
            row = await conn.fetchrow(
                "SELECT owner_email, owner_alias, deployed_at FROM pipeline_deployments WHERE dag_id = $1",
                dag_id,
            )
            if row:
                return {
                    "owner_email": row["owner_email"],
                    "owner_alias": row["owner_alias"],
                    "deployed_at": row["deployed_at"].isoformat()
                    if row["deployed_at"]
                    else None,
                }
        except Exception:
            pass
        finally:
            await conn.close()
        return {}

    runs, tasks_def, ownership = await asyncio.gather(
        _get_runs(), _get_tasks_def(), _get_ownership()
    )

    summary = _summarise_dag(dag, runs)
    summary["recent_runs"] = runs
    summary["doc_md"] = dag.get("doc_md") or ""
    summary["tasks_def"] = tasks_def
    summary.update(ownership)
    return summary


@router.get("/{dag_id}/runs")
async def get_pipeline_runs(
    dag_id: str, current_user: CurrentUser
) -> list[dict[str, Any]]:
    """Get the last 20 runs for a DAG, including task counts."""
    try:
        runs = await airflow_client.get_dag_runs(dag_id, limit=20)
    except Exception as exc:
        log.error("get_pipeline_runs_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc

    async def _enrich_run(run: dict[str, Any]) -> dict[str, Any]:
        run_id = run.get("dag_run_id", "")
        try:
            tasks = await airflow_client.get_task_instances(dag_id, run_id)
        except Exception:
            tasks = []
        task_counts: dict[str, int] = {}
        for t in tasks:
            state = t.get("state") or "none"
            task_counts[state] = task_counts.get(state, 0) + 1
        run_copy = dict(run)
        run_copy["task_counts"] = task_counts
        run_copy["total_tasks"] = len(tasks)
        return run_copy

    enriched = await asyncio.gather(*[_enrich_run(r) for r in runs])
    return list(enriched)


@router.get("/{dag_id}/runs/{run_id}/tasks")
async def get_run_tasks(
    dag_id: str, run_id: str, current_user: CurrentUser
) -> list[dict[str, Any]]:
    """Get task instances for a specific DAG run."""
    try:
        return await airflow_client.get_task_instances(dag_id, run_id)
    except Exception as exc:
        log.error("get_run_tasks_failed", dag_id=dag_id, run_id=run_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc


@router.get("/{dag_id}/runs/{run_id}/tasks/{task_id}/logs")
async def get_task_logs(
    dag_id: str,
    run_id: str,
    task_id: str,
    current_user: CurrentUser,
    attempt: int = 1,
) -> dict[str, Any]:
    """Fetch Airflow task logs for a specific task instance attempt."""
    try:
        logs = await airflow_client.get_task_logs(dag_id, run_id, task_id, attempt)
        return {"logs": logs, "attempt": attempt}
    except Exception as exc:
        log.error(
            "get_task_logs_failed",
            dag_id=dag_id,
            run_id=run_id,
            task_id=task_id,
            error=str(exc),
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/{dag_id}/runs/{run_id}/cancel")
async def cancel_run(
    dag_id: str, run_id: str, current_user: CurrentUser
) -> dict[str, Any]:
    """Cancel a running or queued DAG run. Required before retriggering."""
    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    if not any(r.lower() in ("admin", "editor") for r in roles):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Editor roles can cancel runs",
        )
    try:
        result = await airflow_client.cancel_dag_run(dag_id, run_id)
        log.info(
            "run_cancelled", dag_id=dag_id, run_id=run_id, user=current_user.get("sub")
        )
        return result
    except Exception as exc:
        log.error("cancel_run_failed", dag_id=dag_id, run_id=run_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not cancel DAG run") from exc


@router.post("/{dag_id}/runs/{run_id}/restart")
async def restart_run(
    dag_id: str, run_id: str, current_user: CurrentUser
) -> dict[str, Any]:
    """Restart a failed run: delete the run (clears all task trackers) then trigger a fresh run."""
    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    if not any(r.lower() in ("admin", "editor") for r in roles):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Editor roles can restart runs",
        )
    try:
        await airflow_client.delete_dag_run(dag_id, run_id)
        log.info(
            "run_deleted_for_restart",
            dag_id=dag_id,
            run_id=run_id,
            user=current_user.get("sub"),
        )
    except Exception as exc:
        log.error("restart_delete_failed", dag_id=dag_id, run_id=run_id, error=str(exc))
        raise HTTPException(
            status_code=502, detail="Could not delete run before restarting"
        ) from exc
    try:
        result = await airflow_client.trigger_dag(dag_id, conf={})
        log.info(
            "run_restarted",
            dag_id=dag_id,
            new_run_id=result.get("dag_run_id"),
            user=current_user.get("sub"),
        )
        return result
    except Exception as exc:
        log.error("restart_trigger_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(
            status_code=502, detail="Run deleted but could not trigger fresh run"
        ) from exc


@router.post("/{dag_id}/pause")
async def pause_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Pause a DAG."""
    try:
        return await airflow_client.set_dag_paused(dag_id, True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Could not pause DAG") from exc


@router.post("/{dag_id}/unpause")
async def unpause_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Unpause a DAG."""
    try:
        return await airflow_client.set_dag_paused(dag_id, False)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Could not unpause DAG") from exc


@router.delete("/{dag_id}")
async def delete_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """
    Delete a pipeline fully. Dev environment only.

    Cleans:
      1. Airflow — DAG + all run history
      2. Postgres — pipeline_deployments ownership record
      3. ADLS — DAG file, Spark job, DQ rules (best-effort; requires portal MI to have
                 Storage Blob Data Contributor on the ADLS account — silently skipped if not granted)
    """
    if settings.forge_env != "dev":
        raise HTTPException(
            status_code=403, detail="Pipeline deletion is only allowed in dev"
        )

    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    if not any(r.lower() in ("admin", "editor") for r in roles):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Editor roles can delete pipelines",
        )

    warnings: list[str] = []

    # 1. Postgres — soft-delete immediately so any page refresh won't show it
    # while the slower Airflow cleanup runs below.
    conn = await _pg_connect()
    if conn is not None:
        try:
            await _ensure_deployments_table(conn)
            await conn.execute(
                """
                INSERT INTO pipeline_deployments (dag_id, owner_email, owner_alias, deleted_at)
                VALUES ($1, '', '', now())
                ON CONFLICT (dag_id) DO UPDATE SET deleted_at = now()
            """,
                dag_id,
            )
        except Exception as exc:
            log.warning("pg_delete_pipeline_failed", dag_id=dag_id, error=str(exc))
        finally:
            await conn.close()

    # 2. Airflow — pause first (stops scheduler + retries), cancel active runs,
    # delete all run history, then delete DAG definition.
    # Pause prevents the scheduler from creating new runs or retrying active ones
    # while we're cleaning up, which avoids new SparkApplications being spawned.
    try:
        # 2a. Pause the DAG immediately to stop new runs and retries
        try:
            await airflow_client.set_dag_paused(dag_id, True)
        except Exception:
            pass  # DAG may not exist yet — continue with cleanup

        # 2b. Fetch all runs (paginate: Airflow default page size is 100)
        all_runs: list[dict] = []
        offset = 0
        while True:
            page = await airflow_client.get_dag_runs(dag_id, limit=100, offset=offset)
            if not page:
                break
            all_runs.extend(page)
            if len(page) < 100:
                break
            offset += 100

        # 2c. Cancel active runs first, then delete all
        active_states = {"running", "queued", "up_for_retry"}
        for run in all_runs:
            run_id = run.get("dag_run_id", "")
            if not run_id:
                continue
            if run.get("state") in active_states:
                try:
                    await airflow_client.cancel_dag_run(dag_id, run_id)
                except Exception:
                    pass
            try:
                await airflow_client.delete_dag_run(dag_id, run_id)
            except Exception:
                pass

        await airflow_client.delete_dag(dag_id)
    except Exception as exc:
        log.error("delete_pipeline_airflow_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(
            status_code=502, detail="Could not delete DAG from Airflow"
        ) from exc

    # 3. ADLS — best-effort deletion of DAG file, Spark job, DQ rules
    adls_cleaned: list[str] = []
    adls_account = settings.adls_account
    if adls_account:
        try:
            from azure.identity.aio import (
                DefaultAzureCredential as AsyncDefaultAzureCredential,
            )
            from azure.storage.blob.aio import ContainerClient

            blob_account_url = f"https://{adls_account}.blob.core.windows.net"
            blobs_to_delete = [
                ("code", f"dags/{dag_id}_dag.py"),
                ("code", f"spark/jobs/{dag_id}_job.py"),
            ]

            async with AsyncDefaultAzureCredential() as cred:
                for container, blob_path in blobs_to_delete:
                    try:
                        async with ContainerClient(
                            blob_account_url, container_name=container, credential=cred
                        ) as cc:
                            await cc.delete_blob(blob_path)
                            adls_cleaned.append(f"{container}/{blob_path}")
                    except Exception:
                        pass  # blob may not exist or no access — skip silently

                # DQ rules — delete any YAML matching dag_id prefix
                try:
                    async with ContainerClient(
                        blob_account_url, container_name="code", credential=cred
                    ) as cc:
                        async for blob in cc.list_blobs(
                            name_starts_with=f"dq/rules/{dag_id}"
                        ):
                            try:
                                await cc.delete_blob(blob.name)
                                adls_cleaned.append(f"code/{blob.name}")
                            except Exception:
                                pass
                except Exception:
                    pass

        except Exception as exc:
            log.warning("adls_cleanup_skipped", dag_id=dag_id, error=str(exc))
            warnings.append(
                "ADLS cleanup skipped — portal MI may need Storage Blob Data Contributor on the ADLS account"
            )

    # 4. Compute cluster — delete all SparkApplications for this DAG (best-effort)
    spark_app_prefix = dag_id.replace("_", "-")
    spark_apps_deleted: list[str] = []
    if (
        settings.subscription_id
        and settings.compute_rg
        and settings.compute_cluster_name
    ):
        try:
            import yaml as _yaml
            from azure.identity import WorkloadIdentityCredential
            from azure.mgmt.containerservice import ContainerServiceClient
            from kubernetes.client import ApiClient, Configuration, CustomObjectsApi
            from kubernetes.config import load_kube_config_from_dict

            wic = WorkloadIdentityCredential()
            aks = ContainerServiceClient(wic, settings.subscription_id)
            creds_result = aks.managed_clusters.list_cluster_admin_credentials(
                settings.compute_rg, settings.compute_cluster_name
            )
            kubeconfig_raw = creds_result.kubeconfigs[0].value
            kubeconfig_dict = _yaml.safe_load(kubeconfig_raw.decode())

            conf = Configuration()
            load_kube_config_from_dict(kubeconfig_dict, client_configuration=conf)
            async with asyncio.to_thread(lambda: None):
                pass  # yield event loop briefly before blocking calls
            api_client = ApiClient(configuration=conf)
            custom_api = CustomObjectsApi(api_client)

            all_apps = await asyncio.to_thread(
                custom_api.list_namespaced_custom_object,
                group="sparkoperator.k8s.io",
                version="v1beta2",
                namespace="spark-jobs",
                plural="sparkapplications",
            )
            for app in all_apps.get("items", []):
                name = app.get("metadata", {}).get("name", "")
                if name.startswith(spark_app_prefix):
                    try:
                        await asyncio.to_thread(
                            custom_api.delete_namespaced_custom_object,
                            group="sparkoperator.k8s.io",
                            version="v1beta2",
                            namespace="spark-jobs",
                            plural="sparkapplications",
                            name=name,
                        )
                        spark_apps_deleted.append(name)
                    except Exception:
                        pass
            api_client.rest_client.pool_manager.clear()
            if spark_apps_deleted:
                log.info(
                    "spark_apps_deleted", dag_id=dag_id, count=len(spark_apps_deleted)
                )
        except Exception as exc:
            log.warning("spark_app_cleanup_skipped", dag_id=dag_id, error=str(exc))
            warnings.append(
                "SparkApplication cleanup skipped — portal MI needs "
                "'Azure Kubernetes Service Cluster Admin Role' on the compute AKS cluster"
            )

    log.info(
        "pipeline_deleted",
        dag_id=dag_id,
        user=current_user.get("sub"),
        adls_cleaned=adls_cleaned,
        spark_apps_deleted=spark_apps_deleted,
    )
    return {
        "dag_id": dag_id,
        "status": "deleted",
        "adls_cleaned": adls_cleaned,
        **({"spark_apps_deleted": spark_apps_deleted} if spark_apps_deleted else {}),
        **({"warnings": warnings} if warnings else {}),
    }


@router.post("/{dag_id}/trigger")
async def trigger_pipeline(
    dag_id: str,
    body: TriggerRequest,
    current_user: CurrentUser,
) -> dict[str, Any]:
    """Trigger a DAG run. Requires Admin or Editor role."""
    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    roles_lower = [r.lower() for r in roles]
    if "admin" not in roles_lower and "editor" not in roles_lower:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Editor roles can trigger pipelines",
        )

    # Enforce one-run-per-slot rule:
    # If a run is active (running/queued) for the current slot, either block or cancel+retrigger.
    try:
        recent = await airflow_client.get_dag_runs(dag_id, limit=1)
        active = (
            recent[0]
            if recent and recent[0].get("state") in ("running", "queued")
            else None
        )
        if active:
            active_run_id = active.get("dag_run_id", "")
            if not body.force:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "message": "A run is already active for this slot. Use force=true to cancel it and retrigger.",
                        "active_run_id": active_run_id,
                        "active_state": active.get("state"),
                    },
                )
            # force=True — cancel active run first
            log.info(
                "retrigger_cancel_active",
                dag_id=dag_id,
                run_id=active_run_id,
                user=current_user.get("sub"),
            )
            try:
                await airflow_client.cancel_dag_run(dag_id, active_run_id)
            except Exception as exc:
                log.error(
                    "retrigger_cancel_failed",
                    dag_id=dag_id,
                    run_id=active_run_id,
                    error=str(exc),
                )
                raise HTTPException(
                    status_code=502,
                    detail="Could not cancel active run before retriggering",
                ) from exc
    except HTTPException:
        raise
    except Exception:
        pass  # if we can't check, allow the trigger through

    try:
        result = await airflow_client.trigger_dag(dag_id, conf=body.conf)
        log.info(
            "pipeline_triggered",
            dag_id=dag_id,
            force=body.force,
            user=current_user.get("sub"),
        )
        return result
    except Exception as exc:
        log.error("trigger_pipeline_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(
            status_code=502, detail="Could not trigger DAG in Airflow"
        ) from exc


@router.post("/{dag_id}/restate")
async def restate_pipeline(
    dag_id: str,
    body: RestateRequest,
    current_user: CurrentUser,
) -> dict[str, Any]:
    """Restate (backfill) a pipeline for a date range. One run per day. Requires Admin or Editor."""
    from datetime import date, timedelta

    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    roles_lower = [r.lower() for r in roles]
    if "admin" not in roles_lower and "editor" not in roles_lower:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Editor roles can restate pipelines",
        )

    try:
        from_dt = date.fromisoformat(body.from_date)
        to_dt = date.fromisoformat(body.to_date)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="Invalid date format — use YYYY-MM-DD"
        ) from exc

    if from_dt > to_dt:
        raise HTTPException(status_code=400, detail="from_date must be ≤ to_date")

    max_days = 90
    delta = (to_dt - from_dt).days + 1
    if delta > max_days:
        raise HTTPException(
            status_code=400, detail=f"Date range too large (max {max_days} days)"
        )

    # Discover sensor task IDs once (ExternalTaskSensor = trackers to skip during restate)
    sensor_task_ids: list[str] = []
    try:
        all_tasks = await airflow_client.get_dag_tasks(dag_id)
        sensor_task_ids = [
            t.get("task_id", "")
            for t in all_tasks
            if "ExternalTaskSensor"
            in (
                t.get("class_ref", {}).get("class_name", "")
                or t.get("operator_name", "")
                or ""
            )
            and t.get("task_id", "")
        ]
        if sensor_task_ids:
            log.info("restate_sensors_found", dag_id=dag_id, sensors=sensor_task_ids)
    except Exception as exc:
        log.warning("restate_sensor_discovery_failed", dag_id=dag_id, error=str(exc))

    triggered: list[str] = []
    errors: list[str] = []

    current_date = from_dt
    while current_date <= to_dt:
        logical_date = f"{current_date.isoformat()}T00:00:00+00:00"
        try:
            # Delete any existing runs for this logical_date so trackers/tasks start fresh
            existing = await airflow_client.get_dag_runs_for_date(dag_id, logical_date)
            for existing_run in existing:
                existing_run_id = existing_run.get("dag_run_id", "")
                if existing_run_id:
                    # Cancel first if running/queued so delete succeeds
                    if existing_run.get("state") in ("running", "queued"):
                        try:
                            await airflow_client.cancel_dag_run(dag_id, existing_run_id)
                        except Exception:
                            pass
                    await airflow_client.delete_dag_run(dag_id, existing_run_id)
                    log.info(
                        "restate_cleared_run",
                        dag_id=dag_id,
                        run_id=existing_run_id,
                        date=str(current_date),
                    )

            result = await airflow_client.trigger_dag(
                dag_id, conf=body.conf, logical_date=logical_date
            )
            new_run_id = result.get("dag_run_id", logical_date)
            triggered.append(new_run_id)

            # Skip ExternalTaskSensor tasks (trackers) so the Spark job runs immediately
            # Airflow needs ~2s to schedule task instances after the run is created
            if sensor_task_ids:
                await asyncio.sleep(3)
                for sensor_id in sensor_task_ids:
                    try:
                        await airflow_client.patch_task_instance_state(
                            dag_id, new_run_id, sensor_id, "success"
                        )
                        log.info(
                            "restate_sensor_skipped",
                            dag_id=dag_id,
                            run_id=new_run_id,
                            sensor=sensor_id,
                        )
                    except Exception as exc:
                        log.warning(
                            "restate_sensor_skip_failed",
                            dag_id=dag_id,
                            sensor=sensor_id,
                            error=str(exc),
                        )

        except Exception as exc:
            errors.append(f"{current_date}: {exc}")
            log.warning(
                "restate_day_failed",
                dag_id=dag_id,
                date=str(current_date),
                error=str(exc),
            )
        current_date += timedelta(days=1)

    log.info(
        "pipeline_restate",
        dag_id=dag_id,
        days=delta,
        triggered=len(triggered),
        errors=len(errors),
        user=current_user.get("sub"),
    )
    return {"triggered": triggered, "errors": errors, "days": delta}
