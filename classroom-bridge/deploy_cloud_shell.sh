#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="${PROJECT_ID:-silent-octagon-503421-d1}"
SCHOOL_EMAIL="${SCHOOL_EMAIL:-carlosjm.ti23@utsjr.edu.mx}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="classroom-bridge"
SERVICE_ACCOUNT_NAME="classroom-bridge"
TOKEN_SECRET="classroom-google-token"
SCHEDULER_JOB="classroom-sync"
REPOSITORY_URL="https://github.com/JCoorp/lista-de-tarea.git"
WORKDIR="$HOME/classroom-bridge-deploy"

trap 'echo "❌ El proceso se detuvo en la línea $LINENO. Revisa el mensaje anterior." >&2' ERR

for command_name in gcloud git python3 openssl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Falta el comando $command_name. Abre este script desde Google Cloud Shell." >&2
    exit 1
  }
done

CREDENTIALS_FILE="$(python3 - <<'PY'
import json
from pathlib import Path

home = Path.home()
preferred = [home / "oauth_web_credentials.json"]
candidates = preferred + sorted(home.glob("client_secret*.json")) + sorted(home.glob("*.json"))
seen = set()
for path in candidates:
    if path in seen or not path.is_file():
        continue
    seen.add(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        continue
    web = data.get("web") if isinstance(data, dict) else None
    if isinstance(web, dict) and web.get("client_id") and web.get("client_secret"):
        print(path)
        raise SystemExit(0)
raise SystemExit(1)
PY
)" || true

if [[ -z "$CREDENTIALS_FILE" ]]; then
  cat >&2 <<'EOF'
No encontré el JSON OAuth en tu directorio principal de Cloud Shell.
Usa ⋮ > Subir y selecciona el JSON que descargaste; después ejecuta de nuevo este comando.
EOF
  exit 1
fi

mapfile -t OAUTH_VALUES < <(python3 - "$CREDENTIALS_FILE" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
web = data["web"]
print(web["client_id"])
print(web["client_secret"])
PY
)
OAUTH_CLIENT_ID="${OAUTH_VALUES[0]}"
OAUTH_CLIENT_SECRET="${OAUTH_VALUES[1]}"

if [[ -d "$WORKDIR/.git" ]]; then
  git -C "$WORKDIR" fetch --depth=1 origin main
  git -C "$WORKDIR" reset --hard origin/main
else
  rm -rf "$WORKDIR"
  git clone --depth=1 "$REPOSITORY_URL" "$WORKDIR"
fi
SOURCE_DIR="$WORKDIR/classroom-bridge"

random_secret() {
  openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
}

ensure_secret() {
  local name="$1"
  if ! gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$name" \
      --replication-policy=automatic \
      --project "$PROJECT_ID" \
      --quiet >/dev/null
  fi
}

add_secret_version() {
  local name="$1"
  local value="$2"
  ensure_secret "$name"
  printf '%s' "$value" | gcloud secrets versions add "$name" \
    --data-file=- \
    --project "$PROJECT_ID" \
    --quiet >/dev/null
}

echo "▶ Configurando el proyecto $PROJECT_ID..."
gcloud config set project "$PROJECT_ID" >/dev/null

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  classroom.googleapis.com \
  drive.googleapis.com \
  cloudscheduler.googleapis.com \
  iam.googleapis.com \
  --project "$PROJECT_ID" \
  --quiet

SERVICE_ACCOUNT_EMAIL="$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" \
  --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
    --display-name="Google Classroom Bridge" \
    --project "$PROJECT_ID" \
    --quiet >/dev/null
fi

SESSION_SECRET="$(random_secret)"
BRIDGE_API_KEY="$(random_secret)"

add_secret_version "classroom-oauth-client-id" "$OAUTH_CLIENT_ID"
add_secret_version "classroom-oauth-client-secret" "$OAUTH_CLIENT_SECRET"
add_secret_version "classroom-session-secret" "$SESSION_SECRET"
add_secret_version "classroom-bridge-api-key" "$BRIDGE_API_KEY"
ensure_secret "$TOKEN_SECRET"

for secret_name in \
  classroom-oauth-client-id \
  classroom-oauth-client-secret \
  classroom-session-secret \
  classroom-bridge-api-key \
  "$TOKEN_SECRET"; do
  gcloud secrets add-iam-policy-binding "$secret_name" \
    --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
    --role="roles/secretmanager.secretAccessor" \
    --project "$PROJECT_ID" \
    --quiet >/dev/null
 done

gcloud secrets add-iam-policy-binding "$TOKEN_SECRET" \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/secretmanager.secretVersionAdder" \
  --project "$PROJECT_ID" \
  --quiet >/dev/null

echo "▶ Desplegando el portal. Puede tardar varios minutos..."
gcloud run deploy "$SERVICE_NAME" \
  --source "$SOURCE_DIR" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --service-account "$SERVICE_ACCOUNT_EMAIL" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,ALLOWED_GOOGLE_EMAIL=$SCHOOL_EMAIL,GOOGLE_TOKEN_SECRET_ID=$TOKEN_SECRET" \
  --set-secrets="OAUTH_CLIENT_ID=classroom-oauth-client-id:latest,OAUTH_CLIENT_SECRET=classroom-oauth-client-secret:latest,SESSION_SECRET=classroom-session-secret:latest,BRIDGE_API_KEY=classroom-bridge-api-key:latest" \
  --quiet

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format='value(status.url)')"
CALLBACK_URL="$SERVICE_URL/oauth/callback"

if gcloud scheduler jobs describe "$SCHEDULER_JOB" \
  --location "$REGION" \
  --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHEDULER_JOB" \
    --location "$REGION" \
    --project "$PROJECT_ID" \
    --schedule='17,47 * * * *' \
    --time-zone='America/Mexico_City' \
    --uri="$SERVICE_URL/sync" \
    --http-method=POST \
    --headers="X-Bridge-Key=$BRIDGE_API_KEY,Content-Type=application/json" \
    --max-retry-attempts=2 \
    --quiet >/dev/null
else
  gcloud scheduler jobs create http "$SCHEDULER_JOB" \
    --location "$REGION" \
    --project "$PROJECT_ID" \
    --schedule='17,47 * * * *' \
    --time-zone='America/Mexico_City' \
    --uri="$SERVICE_URL/sync" \
    --http-method=POST \
    --headers="X-Bridge-Key=$BRIDGE_API_KEY,Content-Type=application/json" \
    --max-retry-attempts=2 \
    --quiet >/dev/null
fi

cat > "$HOME/classroom_bridge_urls.txt" <<EOF
Portal: $SERVICE_URL
URI de retorno: $CALLBACK_URL
EOF

cat <<EOF

✅ Portal desplegado.

1. Copia esta URI de retorno y agrégala al cliente OAuth en Google Auth Platform:
$CALLBACK_URL

2. Después abre este enlace e inicia sesión con tu cuenta escolar:
$SERVICE_URL

Las tareas se sincronizarán inmediatamente al iniciar sesión y luego cada 30 minutos.
Las direcciones también quedaron guardadas en ~/classroom_bridge_urls.txt
EOF
