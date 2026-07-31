# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Forge, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **security@pruthviprodduturi.dev** or use [GitHub's private vulnerability reporting](https://github.com/PruthviProdduturi/Forge/security/advisories/new).

You should receive a response within 48 hours. We will work with you to understand the issue, verify the fix, and coordinate disclosure.

## Supported Versions

| Version | Supported |
|---------|-----------|
| main    | Yes       |

## Security Design

Forge follows these security principles:

- **No static secrets** — all authentication uses Azure AD Managed Identity and Workload Identity (OIDC)
- **Private by default** — AKS clusters, ACR, Key Vault, and Postgres all use private endpoints
- **RBAC everywhere** — Azure RBAC for infrastructure, AAD app roles for portal access
- **No credentials in code** — all secrets stored in Azure Key Vault, accessed via Managed Identity
