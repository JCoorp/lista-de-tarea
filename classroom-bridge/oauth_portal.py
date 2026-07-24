from __future__ import annotations

import base64
import hmac
import json
import os
import secrets
from html import escape
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from google.cloud import secretmanager
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from starlette.middleware.sessions import SessionMiddleware

from classroom_bridge import SCOPES, sync

PORTAL_SCOPES = [
    *SCOPES,
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]

app = FastAPI(
    title="ChatGPT Classroom Bridge",
    docs_url=None,
    redoc_url=None,
)

_session_secret = os.getenv("SESSION_SECRET") or secrets.token_urlsafe(48)
app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret,
    https_only=True,
    same_site="lax",
    max_age=600,
)


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Falta la variable de entorno {name}.")
    return value


def project_id() -> str:
    return (
        os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
        or os.getenv("GCP_PROJECT_ID", "").strip()
        or required_env("GOOGLE_CLOUD_PROJECT")
    )


def redirect_uri(request: Request) -> str:
    configured = os.getenv("OAUTH_REDIRECT_URI", "").strip()
    if configured:
        return configured
    return str(request.url_for("oauth_callback"))


def oauth_client_config(request: Request) -> dict[str, Any]:
    callback = redirect_uri(request)
    return {
        "web": {
            "client_id": required_env("OAUTH_CLIENT_ID"),
            "client_secret": required_env("OAUTH_CLIENT_SECRET"),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [callback],
        }
    }


def make_flow(request: Request, state: str | None = None) -> Flow:
    flow = Flow.from_client_config(
        oauth_client_config(request),
        scopes=PORTAL_SCOPES,
        state=state,
    )
    flow.redirect_uri = redirect_uri(request)
    return flow


def token_secret_name() -> str:
    secret_id = os.getenv("GOOGLE_TOKEN_SECRET_ID", "classroom-google-token").strip()
    return f"projects/{project_id()}/secrets/{secret_id}"


def secret_client() -> secretmanager.SecretManagerServiceClient:
    return secretmanager.SecretManagerServiceClient()


def write_authorization_secret(credentials_json: str, email: str) -> None:
    payload = json.dumps(
        {
            "authorized_email": email,
            "credentials": json.loads(credentials_json),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    secret_client().add_secret_version(
        request={"parent": token_secret_name(), "payload": {"data": payload}}
    )


def read_authorization_secret() -> dict[str, Any]:
    response = secret_client().access_secret_version(
        request={"name": f"{token_secret_name()}/versions/latest"}
    )
    return json.loads(response.payload.data.decode("utf-8"))


def account_is_allowed(email: str) -> bool:
    normalized = email.strip().lower()
    allowed_email = os.getenv("ALLOWED_GOOGLE_EMAIL", "").strip().lower()
    allowed_domain = os.getenv("ALLOWED_GOOGLE_DOMAIN", "").strip().lower().lstrip("@")

    if allowed_email:
        return hmac.compare_digest(normalized, allowed_email)
    if allowed_domain:
        return normalized.endswith(f"@{allowed_domain}")
    return True


def masked_account_hint() -> str:
    email = os.getenv("ALLOWED_GOOGLE_EMAIL", "").strip()
    domain = os.getenv("ALLOWED_GOOGLE_DOMAIN", "").strip().lstrip("@")
    if email and "@" in email:
        local, email_domain = email.split("@", 1)
        visible = local[:2] + "…" if len(local) > 2 else "…"
        return f"{visible}@{email_domain}"
    if domain:
        return f"una cuenta @{domain}"
    return "tu cuenta escolar"


def page(title: str, body: str, status_code: int = 200) -> HTMLResponse:
    html = f"""<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(title)}</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 680px; margin: 8vh auto; padding: 24px; line-height: 1.55; }}
    .card {{ border: 1px solid #ddd; border-radius: 16px; padding: 24px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }}
    a.button {{ display: inline-block; padding: 12px 18px; border-radius: 10px; background: #111; color: #fff; text-decoration: none; font-weight: 650; }}
    code {{ overflow-wrap: anywhere; }}
  </style>
</head>
<body><main class="card"><h1>{escape(title)}</h1>{body}</main></body>
</html>"""
    return HTMLResponse(html, status_code=status_code)


@app.get("/", response_class=HTMLResponse)
def home() -> HTMLResponse:
    body = (
        f"<p>Autoriza una sola vez <strong>{escape(masked_account_hint())}</strong> "
        "para consultar Google Classroom.</p>"
        '<p><a class="button" href="/login">Iniciar sesión con Google</a></p>'
        "<p>Google mostrará el selector de cuentas. Si eliges una cuenta distinta, "
        "el sistema rechazará la autorización y no guardará ningún token.</p>"
    )
    return page("Conectar Google Classroom", body)


@app.get("/healthz")
def healthz() -> JSONResponse:
    return JSONResponse({"ok": True})


@app.get("/login")
def login(request: Request) -> RedirectResponse:
    state = secrets.token_urlsafe(32)
    request.session["oauth_state"] = state
    flow = make_flow(request, state=state)

    params: dict[str, str] = {
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent select_account",
    }
    allowed_email = os.getenv("ALLOWED_GOOGLE_EMAIL", "").strip()
    allowed_domain = os.getenv("ALLOWED_GOOGLE_DOMAIN", "").strip().lstrip("@")
    if allowed_email:
        params["login_hint"] = allowed_email
    elif allowed_domain:
        params["hd"] = allowed_domain

    authorization_url, _ = flow.authorization_url(**params)
    return RedirectResponse(authorization_url, status_code=302)


@app.get("/oauth/callback", name="oauth_callback", response_class=HTMLResponse)
def oauth_callback(request: Request) -> HTMLResponse:
    expected_state = request.session.pop("oauth_state", None)
    returned_state = request.query_params.get("state")
    if not expected_state or not returned_state or not hmac.compare_digest(
        expected_state, returned_state
    ):
        return page(
            "Autorización rechazada",
            "<p>El estado OAuth no coincide. Vuelve a iniciar el proceso desde el enlace principal.</p>",
            400,
        )

    error = request.query_params.get("error")
    if error:
        return page(
            "Autorización cancelada",
            f"<p>Google devolvió el error <code>{escape(error)}</code>.</p>",
            400,
        )

    flow = make_flow(request, state=expected_state)
    callback_url = f"{redirect_uri(request)}?{request.url.query}"
    flow.fetch_token(authorization_response=callback_url)
    credentials = flow.credentials

    oauth2 = build("oauth2", "v2", credentials=credentials, cache_discovery=False)
    profile = oauth2.userinfo().get().execute()
    email = str(profile.get("email", "")).strip().lower()

    if not email or not account_is_allowed(email):
        return page(
            "Cuenta incorrecta",
            "<p>La cuenta elegida no coincide con la cuenta escolar autorizada. "
            "No se guardó ningún acceso. Cierra esta ventana e inténtalo de nuevo.</p>",
            403,
        )

    if not credentials.refresh_token:
        return page(
            "Falta acceso permanente",
            "<p>Google no entregó un refresh token. Revoca el acceso anterior de esta "
            "aplicación en tu cuenta de Google y vuelve a autorizar.</p>",
            409,
        )

    write_authorization_secret(credentials.to_json(), email)
    return page(
        "Classroom conectado",
        f"<p>La cuenta <strong>{escape(email)}</strong> quedó autorizada correctamente.</p>"
        "<p>Ya puedes cerrar esta ventana. Las siguientes consultas no pedirán inicio de sesión, "
        "salvo que Google, tu escuela o tú revoquen el permiso.</p>",
    )


@app.post("/sync")
def sync_endpoint(x_bridge_key: str | None = Header(default=None)) -> JSONResponse:
    expected_key = required_env("BRIDGE_API_KEY")
    if not x_bridge_key or not hmac.compare_digest(x_bridge_key, expected_key):
        raise HTTPException(status_code=401, detail="Unauthorized")

    stored = read_authorization_secret()
    credentials_info = stored.get("credentials")
    if not isinstance(credentials_info, dict):
        raise HTTPException(status_code=503, detail="Google authorization is missing")

    encoded = base64.b64encode(
        json.dumps(credentials_info).encode("utf-8")
    ).decode("ascii")
    os.environ["GOOGLE_TOKEN_JSON_B64"] = encoded
    result = sync()
    return JSONResponse(
        {
            "ok": True,
            "pending": result.pending_count,
            "overdue": result.overdue_count,
            "courses": result.course_count,
        }
    )
