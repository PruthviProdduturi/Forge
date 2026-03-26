# Step 06 — CI/CD Pipeline

> **All code changes go through Git and Pull Requests. Nothing is deployed directly.**

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io)

---

## Principles

1. **No direct deploys.** Engineers push to feature branches and open PRs. Merging to `main` is the only deployment trigger.
2. **PR gates before merge.** Every PR must pass lint, tests, security scans, and image scans before it can be merged.
3. **Azure DevOps owns cluster state.** After merge, Azure DevOps detects the change and syncs the cluster to match. No human runs `helm upgrade` in production.
4. **DAG changes are live within 30s.** Airflow git-sync polls `main` continuously — no deployment pipeline needed for DAG-only changes.
5. **Image tags are immutable.** Production images are tagged with `{version}-{git-sha}`. Tags are never overwritten.

---

## Repository Branch Model

```
main  ─────────────────────────────────────────────▶  (protected, requires PR)
  │                                                         │
  │  deployed by AzDO CD pipeline → dev cluster                    │
  │  image tag: {version}-{sha}                             │
  │                                                         │
feature/my-pipeline  ──PR──▶ main                          │
hotfix/fix-dq-rule   ──PR──▶ main                          │
                                                            │
release/v1.2  ──────────────────────────────────────▶  tag v1.2.0
                                                            │
                                               AzDO CD pipeline deploys tag → prod cluster
```

**Branch naming:**

| Prefix | Use for | Example |
|--------|---------|---------|
| `feature/` | New pipelines, new features | `feature/ingest-bronze-crm-orders` |
| `fix/` | Bug fixes in DAGs, DQ rules, jobs | `fix/dq-null-rate-threshold` |
| `infra/` | Bicep or Helm changes | `infra/add-spark-node-pool` |
| `release/` | Production releases | `release/v1.3` |

---

## PR Requirements

Every PR to `main` must pass all of the following before merge is allowed:

```
PR opened
    │
    ▼
CI Pipeline runs automatically:
    │
    ├── Lint & type check
    │   ├── Python (ruff + mypy) — DAGs, DQ SDK, jobs, portal backend
    │   ├── TypeScript (eslint + tsc) — portal frontend
    │   └── Bicep (az bicep build --file to validate all modules)
    │
    ├── Security scans
    │   ├── detect-secrets — blocks commit if any secret pattern found
    │   ├── checkov — IaC security policy (Bicep + Helm)
    │   └── pip-audit / npm audit — dependency CVE scan
    │
    ├── Unit tests
    │   ├── pytest — DQ SDK, lineage SDK, portal backend
    │   ├── DAG integrity tests — all DAGs load without error
    │   └── jest — portal frontend components
    │
    ├── Docker build (dry-run)
    │   └── Build all changed Dockerfiles (no push) to verify they build clean
    │
    └── Bicep what-if (for infra/ changes only)
        └── az deployment sub what-if — posts diff as PR comment for reviewer to inspect

All checks green → PR can be reviewed and merged
```

**CODEOWNERS** enforces who must review what:

```
# .github/CODEOWNERS  (or Azure DevOps branch policy equivalent)

# Infrastructure changes require platform team review
/infra/                          @forge/platform-team
/ARCHITECTURE.md                 @forge/platform-team

# DAG changes require data engineer team review
/orchestration/airflow/dags/     @forge/data-engineers

# DQ rules can be reviewed by either team
/orchestration/dq/rules/         @forge/data-engineers @forge/platform-team

# Portal requires frontend + backend review
/portal/                         @forge/platform-team
```

---

## CI Pipeline — Full Definition

### Trigger

Runs on every push to a PR branch and on merge to `main`.

```yaml
# .github/workflows/ci.yaml  (or azure-pipelines.yml equivalent)

trigger:
  branches:
    include: [ main ]
  paths:
    exclude: [ docs/**, "*.md" ]   # doc-only changes skip CI

pr:
  branches:
    include: [ main ]
```

### Stages

```
Stage 1: Lint & Security          (parallel jobs, ~2 min)
  ├── job: lint-python
  │     ruff check . && mypy orchestration/ portal/backend/
  ├── job: lint-typescript
  │     cd portal/frontend && npm ci && npm run lint && npx tsc --noEmit
  ├── job: lint-bicep
  │     az bicep build --file infra/bicep/environments/dev/main.bicep
  │     az bicep build --file infra/bicep/environments/prod/main.bicep
  ├── job: secrets-scan
  │     detect-secrets scan --baseline .secrets.baseline
  └── job: iac-security
        checkov -d infra/bicep/ --framework arm
        checkov -d infra/helm/ --framework helm

Stage 2: Tests                    (parallel jobs, ~5 min)
  ├── job: test-python
  │     pytest orchestration/dq/tests/ orchestration/lineage/tests/ portal/backend/tests/
  ├── job: test-dags
  │     pytest orchestration/airflow/tests/ (DAG integrity tests)
  └── job: test-frontend
        cd portal/frontend && npm run test -- --ci

Stage 3: Build                    (on merge to main only, ~10 min)
  ├── job: build-spark
  │     docker build infra/docker/spark/ -t {registry}/spark:{version}-{sha}
  │     docker push → ACR
  │     Microsoft Defender for Containers scans the image automatically on push
  ├── job: build-airflow
  │     docker build infra/docker/airflow/ -t {registry}/airflow:{version}-{sha}
  │     docker push → ACR
  ├── job: build-trino
  │     (same pattern)
  ├── job: build-portal-api
  │     docker build portal/backend/ -t {registry}/portal-api:{sha}
  │     docker push → ACR
  └── job: build-portal-web
        docker build portal/frontend/ -t {registry}/portal-web:{sha}
        docker push → ACR

Stage 4: Deploy to Dev            (after Stage 3, auto)
  └── job: helm-sync-dev
        helm app sync forge-compute-dev --prune
        helm app sync forge-orchestration-dev --prune
        helm app wait forge-compute-dev --health
        helm app wait forge-orchestration-dev --health

Stage 5: Smoke Tests              (after Stage 4)
  └── job: smoke-test
        Submit test SparkApplication → assert COMPLETED
        Trigger test Airflow DAG → assert SUCCESS
        Query gold.smoke_test table via Trino → assert row returned
        Assert Purview received lineage events (asset visible in Data Map)
        Assert DQ result written to silver/_platform/dq_results/
```

---

## CD — Production Deployment

Production is **never automatically deployed**. It requires a Git tag on a tested commit.

```
1. Platform team creates a release branch: release/v1.3
2. Final testing in staging environment (optional)
3. Platform team creates a Git tag: v1.3.0
4. Azure DevOps prod ApplicationSet is configured to track tags matching v*.*.*
5. Azure DevOps detects the new tag and syncs the prod cluster
6. Deployment proceeds component by component (wave-based sync)
7. Platform team monitors Azure Managed Grafana during rollout
8. Rollback: delete the tag, push previous tag → Azure DevOps reverts
```

**ADO Pipeline stage order** (controls deployment order in production):

```yaml
# infra/pipelines/release.yml (stages — each dependsOn the previous)
stages:
  - stage: Networking      # stage 1 — networking + identity
  - stage: Storage         # stage 2 — storage + Key Vault
    dependsOn: Networking
  - stage: AKSBootstrap    # stage 3 — AKS cluster bootstrap
    dependsOn: Storage
  - stage: ComputeApps     # stage 4 — compute cluster apps (Spark, Trino)
    dependsOn: AKSBootstrap
  - stage: OrchApps        # stage 5 — orchestration cluster apps (Airflow, Purview integration)
    dependsOn: AKSBootstrap
  - stage: Portal          # stage 6 — portal (last)
    dependsOn: OrchApps
```

---

## DAG Deployments — No Pipeline Needed

DAG files (`orchestration/airflow/dags/**`) do not go through the deployment pipeline. They are:

1. Merged to `main` via a PR (same PR gates as everything else)
2. Picked up by git-sync sidecar on the Airflow scheduler within 30 seconds
3. Live in Airflow immediately — no pod restart, no Helm upgrade, no Azure DevOps sync

This is by design — data engineers should be able to deploy a pipeline fix without waiting for a full platform deployment cycle.

**What still goes through CI for DAG PRs:**
- `lint-python` (ruff + mypy on the DAG file)
- `test-dags` (DAG integrity: does it import cleanly? Are dependencies declared correctly?)
- `secrets-scan` (no hardcoded credentials in DAG files)

---

## Helm Values and Image Tags

Platform Helm values files reference image tags explicitly. To update an image in production:

```yaml
# infra/helm/compute/spark-connect/values.yaml
image:
  repository: forgeacr-prod.azurecr.io/spark
  tag: "4.1.0-a1b2c3d4"    ← git SHA pinned, updated via PR
```

The CI pipeline updates the tag in the values file as part of Stage 3 (build), commits the change back to `main`, and Azure DevOps picks it up. This means the deployed image tag is always visible in Git history — full audit trail.

---

## CI Runner Requirements

CI runners must:
- Be in the same VNet as ACR (private endpoint) — no public push to registry
- Have `az login` via federated credential (OIDC) — no service principal secrets
- Have Docker installed (for image builds)
- Have kubectl, helm installed

**Azure DevOps:** Use a self-hosted agent pool (`forge-cicd-pool`) running on AKS in the VNet.
**GitHub Actions:** Use a self-hosted runner or Azure Container Apps Jobs runner in the VNet.

---

## Security in CI/CD

| Control | How it's enforced |
|---------|------------------|
| No secrets in code | `detect-secrets` blocks PR merge |
| Signed commits | Required by branch policy |
| Image scanning | Microsoft Defender for Containers — continuous scan on every image pushed to ACR |
| IaC security | checkov blocks PR merge on policy violations |
| No direct prod access | CI runners have no prod kubeconfig; only Azure DevOps syncs prod |
| Audit trail | Every production change traceable to a PR + Git SHA |
