"""
Portal Auth Proxy — Forge Data Platform
========================================
Server-side OAuth2 Authorization Code flow using Azure AD + MSAL with IMDS
managed identity token as client_assertion (no client secret, S360 compliant).

Identical pattern to the Trino auth proxy. Sits in front of both portal-web
(Next.js) and portal-api (FastAPI). After AAD authentication it injects
X-User-Email, X-User-Name, and X-User-Roles headers so portal-api can trust
the caller identity without validating JWTs.

Auth flow:
  1. Unauthenticated browser request → redirect to /oauth2/sign_in
  2. /oauth2/sign_in → AAD authorization URL
  3. AAD callback → /oauth2/callback → token exchange → session cookie set
  4. All subsequent requests: session cookie validated; user headers injected

Routes:
  /oauth2/sign_in   — initiates Azure AD login
  /oauth2/callback  — handles token exchange; sets session; redirects to app
  /oauth2/sign_out  — clears session; redirects to Azure AD logout
  /api/*            — proxied to portal-api with X-User-* headers injected
  /*                — proxied to portal-web (Next.js)
"""
import logging
import os

import msal
import requests as req_lib
from flask import Flask, Response, redirect, request, session

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

upstream_session = req_lib.Session()

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ["SESSION_SECRET"]

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
TENANT_ID        = os.environ["TENANT_ID"]
CLIENT_ID        = os.environ["CLIENT_ID"]
REDIRECT_URI     = os.environ["REDIRECT_URI"]          # https://<host>/oauth2/callback
ALLOWED_DOMAIN   = os.environ["ALLOWED_DOMAIN"]        # e.g. microsoft.com
PORTAL_API_URL   = os.environ.get("PORTAL_API_URL",   "http://portal-api:8080")
PORTAL_WEB_URL   = os.environ.get("PORTAL_WEB_URL",   "http://portal-web:3001")
SCOPES           = ["User.Read"]

MANAGED_IDENTITY_CLIENT_ID = os.environ["MANAGED_IDENTITY_CLIENT_ID"]
IMDS_URL = "http://169.254.169.254/metadata/identity/oauth2/token"

# Role priority — highest match wins
_ROLE_PRIORITY = ["Admin", "Editor", "Analyst", "Viewer"]


def _extract_role(roles: list[str]) -> str:
    lowered = [r.lower() for r in roles]
    for r in _ROLE_PRIORITY:
        if r.lower() in lowered:
            return r
    return "Viewer"


def _get_assertion() -> str:
    """Get a client assertion for MSAL using IMDS managed identity token.

    Requests a token from IMDS for id-forge-portal-{env} — the user-assigned
    MI attached to the orch cluster nodes.  The token is issued directly by
    AAD (iss = login.microsoftonline.com/v2.0, sub = MI principalId) and
    matches the managed-identity-federation federated credential on the app
    registration.  Same pattern as trino-auth-proxy on the compute cluster.
    """
    resp = req_lib.get(
        IMDS_URL,
        params={
            "api-version": "2018-02-01",
            "resource": "api://AzureADTokenExchange",
            "client_id": MANAGED_IDENTITY_CLIENT_ID,
        },
        headers={"Metadata": "true"},
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _msal_app() -> msal.ConfidentialClientApplication:
    """Build a fresh MSAL app using IMDS managed identity token as client_assertion."""
    return msal.ConfidentialClientApplication(
        client_id=CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        client_credential={"client_assertion": _get_assertion()},
    )


# ---------------------------------------------------------------------------
# OAuth2 endpoints
# ---------------------------------------------------------------------------

@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/oauth2/sign_in")
def sign_in():
    auth_url = _msal_app().get_authorization_request_url(
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
        response_type="code",
    )
    return redirect(auth_url)


@app.route("/oauth2/callback")
def callback():
    code = request.args.get("code")
    if not code:
        return "Missing auth code", 400

    result = _msal_app().acquire_token_by_authorization_code(
        code=code, scopes=SCOPES, redirect_uri=REDIRECT_URI,
    )
    if "error" in result:
        desc = result.get("error_description", result.get("error", "unknown"))
        log.error("Token exchange failed: %s", desc)
        return f"Authentication failed: {desc}", 500

    claims = result.get("id_token_claims", {})
    email = claims.get("preferred_username", "")
    if not email.lower().endswith(f"@{ALLOWED_DOMAIN}"):
        log.warning("Access denied for %s", email)
        return f"Access denied: only @{ALLOWED_DOMAIN} accounts are allowed.", 403

    raw_roles = claims.get("roles", [])
    if isinstance(raw_roles, str):
        raw_roles = [raw_roles]

    session["user_email"] = email
    session["user_name"]  = claims.get("name", email.split("@")[0])
    session["user_roles"] = ",".join(raw_roles)
    session["user_role"]  = _extract_role(raw_roles)

    log.info("User authenticated: %s role=%s", email, session["user_role"])

    next_url = session.pop("next", "/")
    if not next_url.startswith("/") or "sign_in" in next_url or "callback" in next_url:
        next_url = "/"
    return redirect(next_url)


@app.route("/oauth2/sign_out")
def sign_out():
    session.clear()
    logout_redirect = REDIRECT_URI.replace("/oauth2/callback", "/oauth2/sign_in")
    return redirect(
        f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/logout"
        f"?post_logout_redirect_uri={logout_redirect}"
    )


# ---------------------------------------------------------------------------
# Reverse proxy
# ---------------------------------------------------------------------------

METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
_HOP_BY_HOP = {"host", "content-length", "transfer-encoding", "connection",
               "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailers", "upgrade"}


def _proxy(upstream_base: str, path: str) -> Response:
    url = f"{upstream_base.rstrip('/')}/{path.lstrip('/')}"
    if request.query_string:
        url += f"?{request.query_string.decode()}"

    headers = {k: v for k, v in request.headers if k.lower() not in _HOP_BY_HOP}

    # Inject authenticated user identity — portal-api trusts these headers
    headers["X-User-Email"] = session["user_email"]
    headers["X-User-Name"]  = session["user_name"]
    headers["X-User-Roles"] = session["user_roles"]
    headers["X-User-Role"]  = session["user_role"]

    resp = upstream_session.request(
        method=request.method,
        url=url,
        headers=headers,
        data=request.get_data(),
        allow_redirects=False,
        timeout=60,
    )

    resp_headers = {k: v for k, v in resp.headers.items()
                    if k.lower() not in {"transfer-encoding", "content-encoding", "content-length"}}
    return Response(resp.content, status=resp.status_code, headers=resp_headers)


@app.route("/", defaults={"path": ""}, methods=METHODS)
@app.route("/<path:path>", methods=METHODS)
def proxy(path: str) -> Response:
    # Unauthenticated — redirect HTML requests to sign-in; return 401 for API/XHR
    if "user_email" not in session:
        if path.startswith("api/"):
            return Response("Unauthorized", status=401)
        session["next"] = f"/{path}" if path else "/"
        return redirect("/oauth2/sign_in")

    # Route /api/* to portal-api; everything else to portal-web
    if path.startswith("api/") or path == "api":
        return _proxy(PORTAL_API_URL, path)
    return _proxy(PORTAL_WEB_URL, path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
