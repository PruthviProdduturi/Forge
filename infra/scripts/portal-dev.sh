#!/usr/bin/env bash
# =============================================================================
# Forge — Local Development Launcher (portal only)
#
# Starts the portal frontend (Next.js) and/or backend (FastAPI) for local
# development. This script does NOT deploy infrastructure or build Docker
# images — see docs/implementation/ for those steps.
#
# Usage:
#   ./scripts/dev.sh                    # start frontend + backend
#   ./scripts/dev.sh portal             # portal frontend only
#   ./scripts/dev.sh api                # portal backend (FastAPI) only
#   ./scripts/dev.sh install            # install all dependencies only
#
# Prerequisites:
#   - Node.js 20+ and npm  (frontend)
#   - Python 3.11+ and pip (backend)
#   - Copy portal/backend/.env.example to portal/backend/.env and fill in values
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PORTAL_DIR="$ROOT/portal/frontend"
API_DIR="$ROOT/portal/backend"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[forge]${RESET} $*"; }
success() { echo -e "${GREEN}[forge]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[forge]${RESET} $*"; }
die()     { echo -e "${RED}[forge] ERROR:${RESET} $*" >&2; exit 1; }

# ── Dependency checks ─────────────────────────────────────────────────────────
check_deps() {
  command -v node  &>/dev/null || die "Node.js not found. Install Node.js 20+ from https://nodejs.org"
  command -v npm   &>/dev/null || die "npm not found."
  node_ver=$(node --version | sed 's/v//' | cut -d. -f1)
  [[ "$node_ver" -ge 20 ]] || warn "Node.js $node_ver detected. Node 20+ is recommended."
  success "Node.js $(node --version) / npm $(npm --version)"
}

# ── Install all dependencies ──────────────────────────────────────────────────
install_all() {
  info "Installing portal frontend dependencies..."
  cd "$PORTAL_DIR"
  npm install
  success "Frontend dependencies installed."

  if [[ -f "$API_DIR/requirements.txt" ]]; then
    info "Installing portal backend dependencies..."
    cd "$API_DIR"
    if [[ ! -d ".venv" ]]; then
      python3 -m venv .venv
    fi
    .venv/bin/pip install -q --upgrade pip
    .venv/bin/pip install -q -r requirements.txt
    success "Backend dependencies installed."
  fi
}

# ── Run portal frontend ───────────────────────────────────────────────────────
run_frontend() {
  cd "$PORTAL_DIR"

  # Ensure .env.local exists
  if [[ ! -f ".env.local" ]]; then
    if [[ -f ".env.local.example" ]]; then
      cp .env.local.example .env.local
      warn "Created .env.local from .env.local.example — edit it to set API URL and Azure AD config."
    fi
  fi

  # Install if node_modules missing
  if [[ ! -d "node_modules" ]]; then
    info "node_modules not found — running npm install first..."
    npm install
  fi

  info "Starting Forge portal frontend on http://localhost:3001"
  npm run dev
}

# ── Run portal API ────────────────────────────────────────────────────────────
run_api() {
  if [[ ! -f "$API_DIR/main.py" ]] && [[ ! -f "$API_DIR/app/main.py" ]]; then
    warn "Portal backend not yet implemented. Skipping."
    return
  fi
  cd "$API_DIR"
  if [[ ! -d ".venv" ]]; then
    info "Creating Python virtual environment..."
    python3 -m venv .venv
    .venv/bin/pip install -q --upgrade pip
    .venv/bin/pip install -q -r requirements.txt
  fi
  info "Starting portal API on http://localhost:8080"
  .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
}

# ── Main ──────────────────────────────────────────────────────────────────────
CMD="${1:-all}"

check_deps

case "$CMD" in
  install)
    install_all
    ;;
  portal|frontend|web)
    run_frontend
    ;;
  api|backend)
    run_api
    ;;
  all)
    # Run frontend; optionally API in background if it exists
    if [[ -f "$API_DIR/main.py" ]] || [[ -f "$API_DIR/app/main.py" ]]; then
      info "Starting all services..."
      run_api &
      API_PID=$!
      trap "kill $API_PID 2>/dev/null" EXIT
    fi
    run_frontend
    ;;
  *)
    echo -e "${BOLD}Usage:${RESET} $0 [install|portal|api|all]"
    exit 1
    ;;
esac
