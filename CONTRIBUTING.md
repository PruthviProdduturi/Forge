# Contributing to Forge

Thanks for your interest in contributing to Forge. This guide will get you set up.

## Prerequisites

- Python 3.12+
- Node.js 20+
- Azure CLI (`az`)
- kubectl, Helm 3.x

## Local Development

### Portal Backend (FastAPI)

```bash
cd portal/backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt

# Run locally
uvicorn app.main:app --reload --port 8000

# Run tests
pytest tests/ -v

# Lint
ruff check app/ tests/
ruff format app/ tests/

# Type check
mypy app/ --ignore-missing-imports
```

### Portal Frontend (Next.js)

```bash
cd portal/frontend
npm install

# Run locally
npm run dev          # http://localhost:3001

# Lint & type check
npm run lint
npm run type-check

# Build
npm run build
```

## Code Standards

### Python
- **Formatter**: ruff format
- **Linter**: ruff check
- **Type checker**: mypy (strict on public interfaces)
- **Tests**: pytest + pytest-asyncio. Use `httpx.AsyncClient` with `ASGITransport` for API tests.

### TypeScript
- **Linter**: ESLint (next config)
- **Type checker**: `tsc --noEmit` (strict mode)
- **Framework**: Next.js 14 App Router, React 19

### Infrastructure
- **Azure IaC**: Bicep only. Modules in `infra/bicep/modules/`, environments in `infra/bicep/environments/`.
- **Kubernetes**: Helm charts. Values per environment.
- **No static secrets**: Managed Identity everywhere.

## Commit Messages

Use conventional prefixes:

```
feat: add dataset lineage graph
fix: resolve Trino connection timeout
chore: update dependencies
docs: add DQ framework guide
refactor: simplify auth middleware
test: add pipeline API tests
security: rotate ACR credentials
perf: optimize ADLS listing query
```

Body should explain **why**, not what. The diff shows what.

## Pull Requests

1. Fork the repo and create a branch: `feat/my-feature` or `fix/my-fix`
2. Make your changes with tests
3. Ensure CI passes: lint, type-check, tests, build
4. Open a PR against `main` using the PR template
5. One approval required

## What to Contribute

Check [open issues](https://github.com/PruthviProdduturi/Forge/issues) for things to work on. Good first issues are labeled `good first issue`.

### Areas that need help
- Additional Spark job templates
- DQ rule types (beyond null/range/regex)
- Portal UI improvements
- Documentation and examples
- Helm chart hardening
