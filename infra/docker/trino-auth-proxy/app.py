"""
Trino Auth Proxy — Forge Data Platform
=======================================
OAuth2 Authorization Code flow using Azure AD + MSAL with IMDS managed identity
token as client_assertion (no client secret, no projected OIDC token — S360 compliant).

Auth model:
  Browser:
    - Calls IMDS to get managed identity token; uses it as client_assertion
    - Creates a new MSAL ConfidentialClientApplication per request (IMDS tokens rotate)
    - User identity stored in signed Flask session (SESSION_SECRET from K8s secret)
    - After AAD callback, POSTs to Trino /ui/login to obtain Trino-UI-Token cookie
      (required for web-ui.authentication.type=fixed — cookie alone isn't enough)
  CLI (Trino CLI with --access-token):
    - Accepts Azure AD Bearer token in Authorization header
    - Token obtained via: az account get-access-token --resource $CLIENT_ID
    - Validates token signature using Azure AD JWKS; checks tenant + domain
    - Extracts user from preferred_username claim; injects X-Trino-User

Routes:
  /oauth2/sign_in     — initiates Azure AD login
  /oauth2/callback    — handles token exchange, enforces allowed domain
  /oauth2/sign_out    — clears session, redirects to Azure AD logout
  /ui/login.html      — intercepted to prevent Trino-native login loop
  /ui/api/logout      — intercepted to route through OAuth sign-out
  /*                  — reverse-proxied to Trino coordinator
"""
import logging
import os

import jwt as pyjwt
import msal
import requests as req_lib
from flask import Flask, Response, redirect, request, session
from jwt import PyJWKClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# Connection pool — reused across requests
upstream_session = req_lib.Session()

# static_folder=None prevents Flask from intercepting /static/* requests
app = Flask(__name__, static_folder=None)
app.secret_key = os.environ["SESSION_SECRET"]

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
TENANT_ID        = os.environ["TENANT_ID"]
CLIENT_ID        = os.environ["CLIENT_ID"]
REDIRECT_URI     = os.environ["REDIRECT_URI"]
UPSTREAM_DEFAULT = os.environ.get("TRINO_BACKEND", "trino:8080")
ALLOWED_DOMAIN   = os.environ["ALLOWED_DOMAIN"]
SCOPES           = ["User.Read"]  # MSAL adds openid/profile/email automatically

MANAGED_IDENTITY_CLIENT_ID = os.environ["MANAGED_IDENTITY_CLIENT_ID"]
IMDS_URL = "http://169.254.169.254/metadata/identity/oauth2/token"

# JWKS client for Bearer token validation (Trino CLI with --access-token).
# Using the /common/ endpoint so tokens for any resource (Graph, management, app registrations)
# can be validated — the tenant-specific endpoint misses signing keys used by some resources.
_JWKS_CLIENT = PyJWKClient(
    "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    cache_keys=True,
)


def user_from_bearer(token: str):
    """Validate an Azure AD Bearer token; return user email or None.

    Two-path validation:
    1. JWT decode via JWKS — works for app-registration tokens (az account get-access-token --resource <CLIENT_ID>)
    2. Graph /me fallback — works for Graph tokens (az account get-access-token --resource https://graph.microsoft.com)
    """
    # Path 1: local JWT validation (fast, no outbound call)
    try:
        key = _JWKS_CLIENT.get_signing_key_from_jwt(token)
        claims = pyjwt.decode(
            token, key.key, algorithms=["RS256"],
            options={"verify_aud": False},
        )
        if TENANT_ID not in claims.get("iss", ""):
            log.warning("Bearer token rejected: issuer mismatch (iss=%s)", claims.get("iss"))
            return None
        email = claims.get("preferred_username") or claims.get("upn", "")
        if email.lower().endswith(f"@{ALLOWED_DOMAIN}"):
            log.info("Bearer token accepted via JWT validation: %s", email)
            return email
        log.warning("Bearer token rejected: email %s not in allowed domain", email)
        return None
    except Exception as e:
        log.info("JWT validation failed (%s) — trying Graph /me fallback", e)

    # Path 2: Graph API validation (for Graph-audience tokens)
    try:
        resp = req_lib.get(
            "https://graph.microsoft.com/v1.0/me",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
        if resp.status_code != 200:
            log.warning("Graph /me returned %s — token rejected", resp.status_code)
            return None
        data = resp.json()
        email = data.get("userPrincipalName", "")
        if email.lower().endswith(f"@{ALLOWED_DOMAIN}"):
            log.info("Bearer token accepted via Graph /me: %s", email)
            return email
        log.warning("Graph /me: UPN %s not in allowed domain", email)
    except Exception as e:
        log.warning("Graph /me fallback failed: %s", e)
    return None


def msal_app() -> msal.ConfidentialClientApplication:
    """Build a fresh MSAL app using the IMDS managed identity token as client_assertion."""
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
    assertion = resp.json()["access_token"]
    return msal.ConfidentialClientApplication(
        client_id=CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        client_credential={"client_assertion": assertion},
    )


# ---------------------------------------------------------------------------
# OAuth2 endpoints
# ---------------------------------------------------------------------------

@app.route("/oauth2/sign_in")
def sign_in():
    auth_url = msal_app().get_authorization_request_url(
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
    result = msal_app().acquire_token_by_authorization_code(
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
    session["user"] = email
    username = email.split("@")[0]
    log.info("User authenticated: %s", email)

    # Obtain a Trino UI session token by posting to Trino's login endpoint.
    # With web-ui.authentication.type=fixed, this is the only way to get the
    # Trino-UI-Token cookie — the username cookie alone does not bypass the login page.
    trino_token_cookies = {}
    try:
        login_resp = upstream_session.post(
            f"http://{UPSTREAM_DEFAULT}/ui/login",
            data={"username": username, "redirectPath": "/ui/"},
            allow_redirects=False,
            timeout=5,
        )
        trino_token_cookies = dict(login_resp.cookies)
        log.info("Trino UI pre-auth: status=%s cookies=%s", login_resp.status_code, list(trino_token_cookies))
    except Exception as e:
        log.warning("Could not pre-authenticate with Trino UI: %s", e)

    next_url = session.pop("next", "/ui/")
    # Never redirect back to Trino's own login page — that causes an infinite loop
    if not next_url.startswith("/") or "login" in next_url:
        next_url = "/ui/"
    resp = redirect(next_url)
    resp.set_cookie("username", username, httponly=False, samesite="Lax")
    for name, value in trino_token_cookies.items():
        resp.set_cookie(name, value, httponly=True, samesite="Lax")
    return resp


@app.route("/oauth2/sign_out")
def sign_out():
    session.clear()
    # After AAD logout, send user straight back to sign-in — never expose Trino's own login page
    logout_redirect = REDIRECT_URI.replace("/oauth2/callback", "/oauth2/sign_in")
    return redirect(
        f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/logout"
        f"?post_logout_redirect_uri={logout_redirect}"
    )


# Intercept Trino's logout endpoint and redirect to OAuth sign-out
@app.route("/ui/api/logout", methods=["POST"])
def trino_logout():
    return sign_out()


# Intercept Trino's native login page.
# If user is already authenticated via Azure AD, exchange for a Trino UI token
# and redirect straight to /ui/ — avoids the Azure AD re-auth loop.
# If not authenticated, send to Azure AD sign-in.
@app.route("/ui/login.html")
def trino_login_page():
    user = session.get("user")
    if user:
        username = user.split("@")[0]
        try:
            login_resp = upstream_session.post(
                f"http://{UPSTREAM_DEFAULT}/ui/login",
                data={"username": username, "redirectPath": "/ui/"},
                allow_redirects=False,
                timeout=5,
            )
            resp = redirect("/ui/")
            for name, value in login_resp.cookies.items():
                resp.set_cookie(name, value, httponly=True, samesite="Lax")
            log.info("Trino UI token obtained for %s — redirecting to /ui/", username)
            return resp
        except Exception as e:
            log.warning("Failed to get Trino UI token: %s", e)
    return redirect("/oauth2/sign_in")


# Logged out landing page
@app.route("/logged_out")
def logged_out_page():
    return """
    <html><body style="font-family: Arial; text-align: center; padding-top: 100px;">
    <h2>You have been signed out</h2>
    <p><a href="/oauth2/sign_in">Sign in again</a></p>
    </body></html>
    """


# ---------------------------------------------------------------------------
# Reverse proxy
# ---------------------------------------------------------------------------

METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]

@app.route("/", defaults={"path": ""}, methods=METHODS)
@app.route("/<path:path>", methods=METHODS)
def proxy(path):
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        user = user_from_bearer(auth_header[7:])
        if not user:
            return "Unauthorized: invalid or expired token", 401
        log.info("CLI request authenticated: %s → %s", user, path or "/")
    elif session.get("logged_out"):
        session.pop("logged_out", None)
        return redirect("/logged_out")
    elif "user" not in session:
        if "text/html" in request.headers.get("Accept", ""):
            session["next"] = request.full_path
            return redirect("/oauth2/sign_in")
        return "Unauthorized: provide a Bearer token via --access-token", 401
    else:
        user = session["user"]

    url = f"http://{UPSTREAM_DEFAULT}/{path}"
    if request.query_string:
        url += f"?{request.query_string.decode()}"

    # Strip hop-by-hop headers, Authorization (handled here), and any
    # client-supplied X-Trino-User (proxy is sole authority on user identity).
    skip = {"host", "content-length", "transfer-encoding", "authorization", "x-trino-user"}
    headers = {k: v for k, v in request.headers if k.lower() not in skip}

    # Pass authenticated user to Trino for API calls only.
    # Skipped for /ui/* — fixed auth handles those paths; injecting X-Trino-User there
    # conflicts with web-ui.authentication.type=fixed and breaks query-history polling.
    if not path.startswith("ui/"):
        headers["X-Trino-User"] = user.split("@")[0]

    resp = upstream_session.request(
        method=request.method, url=url, headers=headers,
        data=request.get_data(), allow_redirects=False, timeout=30,
    )

    excluded = {"transfer-encoding", "content-encoding", "content-length"}
    resp_headers = {}
    for k, v in resp.headers.items():
        if k.lower() not in excluded:
            # Rewrite Location header to replace internal service name with proxy host
            if k.lower() == "location" and v.startswith(f"http://{UPSTREAM_DEFAULT}/"):
                host = request.headers.get("Host", "localhost:8080")
                v = v.replace(f"http://{UPSTREAM_DEFAULT}/", f"http://{host}/")
            resp_headers[k] = v

    return Response(resp.content, status=resp.status_code, headers=resp_headers)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
