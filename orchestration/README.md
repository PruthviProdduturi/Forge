# Orchestration — Airflow git-sync target

This directory is the deployment drop zone for Airflow DAGs. **Do not edit files here directly.**

DAGs are generated and copied here by `sync-jobs.sh` from `examples/src/airflow/dags/`.
Airflow git-sync polls `Forge/orchestration/airflow/dags` every 30s.

See [`examples/README.md`](../examples/README.md) for the full pipeline guide.
