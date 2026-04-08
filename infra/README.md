# Forge Infrastructure

All infrastructure code for the Forge platform: Azure resource provisioning, Docker images, Kubernetes deployments, and operational scripts.

## Directory Structure

```
infra/
  bicep/      Azure resource provisioning (Bicep IaC)
  docker/     Dockerfiles for all platform images
  helm/       Helm charts for Kubernetes deployments
  scripts/    Deployment and operational scripts
```

## Bicep (`infra/bicep/`)

```
bicep/
  environments/
    dev/    main.bicep + dev.parameters.json
    prod/   main.bicep + prod.parameters.json
    shared/ cross-environment shared resources
  modules/
    aks.bicep           AKS clusters (compute + orchestration)
    acr.bicep           Azure Container Registry
    storage.bicep       ADLS Gen2 (raw/bronze/silver/gold/code/state containers)
    postgres.bicep      PostgreSQL Flexible Server
    identity.bicep      Managed identities + workload identity federation
    keyvault.bicep      Key Vault + RBAC assignments
    networking.bicep    VNets, subnets, NSGs
    law.bicep           Log Analytics workspace
    (+ ACR PE, AKS network RBAC modules)
```

Each environment has one entry-point `main.bicep` that wires together all modules. One managed identity is provisioned per workload: `hms`, `trino`, `spark`, `portal`, `airflow`.

## Docker Images (`infra/docker/`)

| Image | Base | Purpose |
|---|---|---|
| `spark` | `apache/spark` | Spark jobs with `forge_sdk` pre-installed |
| `trino` | `trinodb/trino` | Distributed query engine |
| `trino-auth-proxy` | `python:slim` | OAuth2 reverse proxy for Trino web UI |
| `hive-metastore` | custom | Hive Metastore for Delta catalog |
| `airflow` | `apache/airflow:3.1.8` | Workflow orchestrator |
| `portal-api` | `python:3.11` | FastAPI backend |
| `portal-web` | `node:20` | Next.js frontend |
| `grafana` | `grafana/grafana` | Observability dashboards |

## Helm Charts (`infra/helm/`)

```
helm/
  compute/                      Compute AKS cluster
    cluster-bootstrap/          Namespaces + service accounts
    hive-metastore/             Delta catalog metastore
    spark-operator/             Spark Kubernetes operator
    spark-connect/              Persistent Spark Connect server
    trino/                      Query engine
    trino-auth-proxy/           OAuth2 proxy for Trino web UI
  orchestration/                Orchestration AKS cluster
    cluster-bootstrap/          Namespaces + service accounts
    airflow/                    Airflow (chart pulled from ACR OCI)
    ingress-nginx/              Public ingress controller
    portal/                     Developer portal (api + web + ingress)
    observability/              Grafana stack
```

## Scripts (`infra/scripts/`)

| Script | Purpose |
|---|---|
| `forge-up.sh` | **Main entry point** — full platform deploy (7 phases) |
| `provision-infra.sh` | Bicep provisioning (called by `forge-up.sh`) |
| `post-provision.sh` | Kubeconfig fetch + S360 IP tagging |
| `sync-jobs.sh` | DAG/lib sync to ADLS + git push |
| `portal-dev.sh` | Local portal development (no AKS needed) |
| `generate-docs.py` | Export architecture docs |

### Deploy everything

```bash
bash infra/scripts/forge-up.sh --env dev --alias <your-alias> \
  --pg-admin-pass <postgres-admin-password> \
  --git-pat <azure-devops-pat>
```

## Further Reading

Step-by-step deployment guides live in [`docs/implementation/`](../docs/implementation/README.md).
