#!/usr/bin/env bash
# =============================================================================
# Forge — Build and Push All Container Images to ACR
#
# Usage:
#   ./scripts/bootstrap/build-and-push-images.sh \
#       --env <dev|staging|prod> \
#       --registry <forgeacr-dev.azurecr.io>
#
# Optional flags:
#   --custom-only     Build and push only custom Dockerfiles (skip imports)
#   --import-only     Import (pull + retag + push) only third-party images
#   --skip-login      Skip 'az acr login' (useful if already logged in)
#   --dry-run         Print commands without executing them
#   --help            Show this help message
#
# Examples:
#   # Full build for dev
#   ./scripts/bootstrap/build-and-push-images.sh \
#       --env dev --registry forgeacr-dev.azurecr.io
#
#   # Prod import-only (weekly refresh of third-party images)
#   ./scripts/bootstrap/build-and-push-images.sh \
#       --env prod --registry forgeacr-prod.azurecr.io --import-only
#
# Requirements:
#   - Docker 24+
#   - Azure CLI 2.57+ (logged in, or use --skip-login if already authenticated)
#   - curl, jq
# =============================================================================

set -euo pipefail

# =============================================================================
# Colour output helpers
# =============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_step()    { echo -e "\n${BOLD}==> $*${RESET}"; }

# =============================================================================
# Defaults
# =============================================================================
ENV=""
REGISTRY=""
CUSTOM_ONLY=false
IMPORT_ONLY=false
SKIP_LOGIN=false
DRY_RUN=false

# Repo root — this script lives at scripts/bootstrap/, so two dirs up
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DOCKER_DIR="${REPO_ROOT}/infra/docker"

# =============================================================================
# Timing tracking
# =============================================================================
declare -a PUSH_SUMMARY=()
SCRIPT_START=$(date +%s)

# =============================================================================
# Argument parsing
# =============================================================================
usage() {
    sed -n '/^# Usage:/,/^# Requirements:/p' "$0" | sed 's/^# \{0,2\}//'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)
            ENV="$2"; shift 2 ;;
        --registry)
            REGISTRY="$2"; shift 2 ;;
        --custom-only)
            CUSTOM_ONLY=true; shift ;;
        --import-only)
            IMPORT_ONLY=true; shift ;;
        --skip-login)
            SKIP_LOGIN=true; shift ;;
        --dry-run)
            DRY_RUN=true; shift ;;
        --help|-h)
            usage ;;
        *)
            log_error "Unknown argument: $1"
            usage ;;
    esac
done

# =============================================================================
# Validation
# =============================================================================
if [[ -z "${ENV}" ]]; then
    log_error "--env is required (dev, staging, or prod)"
    exit 1
fi

if [[ -z "${REGISTRY}" ]]; then
    log_error "--registry is required (e.g. forgeacr-dev.azurecr.io)"
    exit 1
fi

case "${ENV}" in
    dev|staging|prod) ;;
    *)
        log_error "--env must be one of: dev, staging, prod (got: ${ENV})"
        exit 1
        ;;
esac

if [[ "${CUSTOM_ONLY}" == true && "${IMPORT_ONLY}" == true ]]; then
    log_error "--custom-only and --import-only are mutually exclusive"
    exit 1
fi

# Extract ACR name (short name, without domain) for az acr login
ACR_SHORT_NAME="${REGISTRY%%.*}"

# =============================================================================
# Dry-run wrapper
# =============================================================================
run() {
    if [[ "${DRY_RUN}" == true ]]; then
        echo -e "${YELLOW}[DRY-RUN]${RESET} $*"
    else
        "$@"
    fi
}

# =============================================================================
# Image build + push helper
# Tracks timing and appends to the summary table.
# =============================================================================
# Usage: build_and_push <image-name> <version> <dockerfile-dir>
build_and_push() {
    local name="$1"
    local version="$2"
    local context_dir="$3"
    local extra_args="${4:-}"

    local full_tag="${REGISTRY}/${name}:${version}-${ENV}"
    local start_ts
    start_ts=$(date +%s)

    log_step "Building ${full_tag}"
    log_info "Context: ${context_dir}"
    log_info "Dockerfile: ${context_dir}/Dockerfile"

    run docker build \
        --tag "${full_tag}" \
        --file "${context_dir}/Dockerfile" \
        ${extra_args} \
        "${context_dir}"

    log_info "Pushing ${full_tag}"
    run docker push "${full_tag}"

    local end_ts duration
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))

    log_success "Pushed ${full_tag} (${duration}s)"
    PUSH_SUMMARY+=("${full_tag}|custom|${duration}s")
}

# =============================================================================
# Import helper (pull upstream + retag + push)
# =============================================================================
# Usage: import_image <upstream-ref> <acr-image-name> <acr-version>
import_image() {
    local upstream="$1"
    local acr_name="$2"
    local acr_version="$3"

    local full_tag="${REGISTRY}/${acr_name}:${acr_version}-${ENV}"
    local start_ts
    start_ts=$(date +%s)

    log_step "Importing ${acr_name}:${acr_version}"
    log_info "Upstream: ${upstream}"
    log_info "ACR tag:  ${full_tag}"

    run docker pull "${upstream}"
    run docker tag  "${upstream}" "${full_tag}"
    run docker push "${full_tag}"
    # Clean up the locally-tagged upstream image after push
    run docker rmi  "${upstream}" 2>/dev/null || true

    local end_ts duration
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))

    log_success "Imported ${full_tag} (${duration}s)"
    PUSH_SUMMARY+=("${full_tag}|import|${duration}s")
}

# =============================================================================
# Portal image helper — uses repo root as build context
# =============================================================================
# Usage: build_and_push_portal <image-name> <dockerfile-dir>
build_and_push_portal() {
    local name="$1"
    local context_dir="$2"

    local git_sha
    git_sha=$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    local full_tag="${REGISTRY}/${name}:${git_sha}-${ENV}"
    local start_ts
    start_ts=$(date +%s)

    log_step "Building ${full_tag} (portal image)"
    log_info "Context: ${REPO_ROOT} (repo root)"
    log_info "Dockerfile: ${context_dir}/Dockerfile"
    log_info "Git SHA: ${git_sha}"

    run docker build \
        --tag "${full_tag}" \
        --file "${context_dir}/Dockerfile" \
        "${REPO_ROOT}"

    log_info "Pushing ${full_tag}"
    run docker push "${full_tag}"

    local end_ts duration
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))

    log_success "Pushed ${full_tag} (${duration}s)"
    PUSH_SUMMARY+=("${full_tag}|custom|${duration}s")
}

# =============================================================================
# Print summary table
# =============================================================================
print_summary() {
    local script_end
    script_end=$(date +%s)
    local total_duration=$(( script_end - SCRIPT_START ))

    echo ""
    echo -e "${BOLD}============================================================${RESET}"
    echo -e "${BOLD} Forge Image Build Summary${RESET}"
    echo -e "${BOLD}============================================================${RESET}"
    printf "%-80s %-8s %s\n" "Image Tag" "Type" "Duration"
    printf "%-80s %-8s %s\n" "$(printf '%0.s-' {1..80})" "--------" "--------"

    for entry in "${PUSH_SUMMARY[@]}"; do
        IFS='|' read -r tag type duration <<< "${entry}"
        printf "%-80s %-8s %s\n" "${tag}" "${type}" "${duration}"
    done

    echo -e "${BOLD}------------------------------------------------------------${RESET}"
    echo -e "${BOLD}Total images: ${#PUSH_SUMMARY[@]}  |  Total time: ${total_duration}s${RESET}"
    echo ""

    if [[ "${DRY_RUN}" == true ]]; then
        log_warn "DRY-RUN mode — no images were actually built or pushed."
    fi
}

# =============================================================================
# Banner
# =============================================================================
echo -e "${BOLD}"
echo "  ___  _             _                "
echo " / __|| |_  _ _ __ _| |_ _  _ _ __   "
echo " \__ \|  _|| '_/ _\` |  _| || | '  \  "
echo " |___/ \__||_| \__,_|\__|\__,_|_|_|_| "
echo -e "${RESET}"
echo -e "${BOLD}Forge Image Builder${RESET}"
echo -e "Environment : ${CYAN}${ENV}${RESET}"
echo -e "Registry    : ${CYAN}${REGISTRY}${RESET}"
echo -e "Mode        : ${CYAN}$([ "${CUSTOM_ONLY}" == true ] && echo "custom-only" || ([ "${IMPORT_ONLY}" == true ] && echo "import-only" || echo "all"))${RESET}"
echo -e "Dry run     : ${CYAN}${DRY_RUN}${RESET}"
echo ""

# =============================================================================
# ACR Login
# =============================================================================
if [[ "${SKIP_LOGIN}" == false ]]; then
    log_step "Logging into ACR: ${ACR_SHORT_NAME}"
    run az acr login --name "${ACR_SHORT_NAME}"
    log_success "ACR login successful"
else
    log_info "Skipping ACR login (--skip-login set)"
fi

# =============================================================================
# CUSTOM IMAGE BUILDS
# =============================================================================
if [[ "${IMPORT_ONLY}" == false ]]; then
    log_step "Building custom images"

    # -------------------------------------------------------------------------
    # Spark 4.1.0
    # -------------------------------------------------------------------------
    build_and_push \
        "spark" \
        "4.1.0" \
        "${DOCKER_DIR}/spark"

    # -------------------------------------------------------------------------
    # Trino 438
    # Requires the catalog-discovery plugin JAR in build context.
    # Create a placeholder directory if the JAR is not yet available:
    #   mkdir -p infra/docker/trino/plugins/catalog-discovery
    # -------------------------------------------------------------------------
    mkdir -p "${DOCKER_DIR}/trino/plugins/catalog-discovery"
    build_and_push \
        "trino" \
        "438" \
        "${DOCKER_DIR}/trino"

    # -------------------------------------------------------------------------
    # Airflow 2.9.3
    # Requires SDK wheels in build context (optional — see Dockerfile).
    # Create placeholder directories if building without wheels:
    #   mkdir -p infra/docker/airflow/wheels
    #   mkdir -p infra/docker/airflow/dags
    #   mkdir -p infra/docker/airflow/plugins
    # -------------------------------------------------------------------------
    mkdir -p "${DOCKER_DIR}/airflow/wheels"
    mkdir -p "${DOCKER_DIR}/airflow/dags"
    mkdir -p "${DOCKER_DIR}/airflow/plugins"
    build_and_push \
        "airflow" \
        "2.9.3" \
        "${DOCKER_DIR}/airflow"

    # -------------------------------------------------------------------------
    # Grafana 10.4.2
    # Requires dashboard JSON files in build context (infra/docker/grafana/dashboards/).
    # Create placeholder directories if building without dashboards:
    #   for d in spark airflow trino dq infra platform; do
    #       mkdir -p infra/docker/grafana/dashboards/$d
    #   done
    # -------------------------------------------------------------------------
    for d in spark airflow trino dq infra platform; do
        mkdir -p "${DOCKER_DIR}/grafana/dashboards/${d}"
    done
    build_and_push \
        "grafana" \
        "10.4.2" \
        "${DOCKER_DIR}/grafana"

    # -------------------------------------------------------------------------
    # Portal API
    # Build context is repo root — Dockerfile copies from portal/api/
    # -------------------------------------------------------------------------
    build_and_push_portal \
        "portal-api" \
        "${DOCKER_DIR}/portal-api"

    # -------------------------------------------------------------------------
    # Portal Web
    # Build context is repo root — Dockerfile copies from portal/web/
    # -------------------------------------------------------------------------
    build_and_push_portal \
        "portal-web" \
        "${DOCKER_DIR}/portal-web"

    log_success "All custom images built and pushed."
fi

# =============================================================================
# THIRD-PARTY IMAGE IMPORTS
# =============================================================================
if [[ "${CUSTOM_ONLY}" == false ]]; then
    log_step "Importing third-party images"

    # -------------------------------------------------------------------------
    # Hive Metastore 3.1.3
    # -------------------------------------------------------------------------
    import_image \
        "apache/hive:3.1.3" \
        "hive-metastore" \
        "3.1.3"

    # -------------------------------------------------------------------------
    # Marquez API 0.47.0
    # -------------------------------------------------------------------------
    import_image \
        "marquezproject/marquez:0.47.0" \
        "marquez-api" \
        "0.47.0"

    # -------------------------------------------------------------------------
    # Marquez Web 0.47.0
    # -------------------------------------------------------------------------
    import_image \
        "marquezproject/marquez-web:0.47.0" \
        "marquez-web" \
        "0.47.0"

    # -------------------------------------------------------------------------
    # Prometheus 2.51.0
    # -------------------------------------------------------------------------
    import_image \
        "prom/prometheus:v2.51.0" \
        "prometheus" \
        "2.51.0"

    # -------------------------------------------------------------------------
    # Grafana Loki 3.0.0
    # -------------------------------------------------------------------------
    import_image \
        "grafana/loki:3.0.0" \
        "loki" \
        "3.0.0"

    # -------------------------------------------------------------------------
    # Alertmanager 0.27.0
    # -------------------------------------------------------------------------
    import_image \
        "prom/alertmanager:v0.27.0" \
        "alertmanager" \
        "0.27.0"

    # -------------------------------------------------------------------------
    # Promtail 3.0.0
    # -------------------------------------------------------------------------
    import_image \
        "grafana/promtail:3.0.0" \
        "promtail" \
        "3.0.0"

    # -------------------------------------------------------------------------
    # Prometheus node-exporter 1.7.0
    # -------------------------------------------------------------------------
    import_image \
        "prom/node-exporter:v1.7.0" \
        "node-exporter" \
        "1.7.0"

    # -------------------------------------------------------------------------
    # StatsD exporter 0.26.1 (for Airflow StatsD metrics)
    # -------------------------------------------------------------------------
    import_image \
        "prom/statsd-exporter:v0.26.1" \
        "statsd-exporter" \
        "0.26.1"

    # -------------------------------------------------------------------------
    # kube-state-metrics 2.12.0
    # -------------------------------------------------------------------------
    import_image \
        "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0" \
        "kube-state-metrics" \
        "2.12.0"

    # -------------------------------------------------------------------------
    # Spark Operator 1.4.6
    # -------------------------------------------------------------------------
    import_image \
        "ghcr.io/kubeflow/spark-operator:v1.4.6" \
        "spark-operator" \
        "1.4.6"

    # -------------------------------------------------------------------------
    # ArgoCD 2.11.0
    # -------------------------------------------------------------------------
    import_image \
        "quay.io/argoproj/argocd:v2.11.0" \
        "argocd" \
        "2.11.0"

    # -------------------------------------------------------------------------
    # OPA Gatekeeper 3.16.3
    # -------------------------------------------------------------------------
    import_image \
        "openpolicyagent/gatekeeper:v3.16.3" \
        "gatekeeper" \
        "3.16.3"

    log_success "All third-party images imported."
fi

# =============================================================================
# Summary
# =============================================================================
print_summary
