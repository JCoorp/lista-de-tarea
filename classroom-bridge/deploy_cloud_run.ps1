param(
    [string]$ProjectId = "",
    [string]$SchoolEmail = "",
    [string]$Region = "us-central1",
    [string]$Repository = "JCoorp/lista-de-tarea"
)

$ErrorActionPreference = "Stop"
$ServiceName = "classroom-bridge"
$ServiceAccountName = "classroom-bridge"
$TokenSecret = "classroom-google-token"
$CredentialsFile = Join-Path $PSScriptRoot "oauth_web_credentials.json"

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "No se encontró '$Name'. Instálalo y vuelve a ejecutar este script."
    }
}

function New-RandomSecret([int]$Bytes = 48) {
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($buffer)
    }
    finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($buffer).Replace("+", "-").Replace("/", "_").TrimEnd("=")
}

function Ensure-Secret([string]$Name) {
    & gcloud secrets describe $Name --project $ProjectId *> $null
    if ($LASTEXITCODE -ne 0) {
        & gcloud secrets create $Name --replication-policy="automatic" --project $ProjectId
        if ($LASTEXITCODE -ne 0) {
            throw "No se pudo crear el secreto $Name."
        }
    }
}

function Add-SecretVersion([string]$Name, [string]$Value) {
    Ensure-Secret $Name
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText(
            $tempFile,
            $Value,
            (New-Object System.Text.UTF8Encoding($false))
        )
        & gcloud secrets versions add $Name --data-file=$tempFile --project $ProjectId
        if ($LASTEXITCODE -ne 0) {
            throw "No se pudo guardar una versión de $Name."
        }
    }
    finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

Require-Command "gcloud"

if (-not $ProjectId) {
    $ProjectId = Read-Host "ID del proyecto de Google Cloud"
}
if (-not $SchoolEmail) {
    $SchoolEmail = Read-Host "Correo escolar exacto que tiene acceso a Classroom"
}
if (-not $ProjectId -or -not $SchoolEmail) {
    throw "El proyecto y el correo escolar son obligatorios."
}
if (-not (Test-Path $CredentialsFile)) {
    throw "Falta oauth_web_credentials.json. Descarga un OAuth Client ID de tipo Web application y guárdalo en classroom-bridge con ese nombre."
}

$oauthConfig = Get-Content -Raw $CredentialsFile | ConvertFrom-Json
if (-not $oauthConfig.web.client_id -or -not $oauthConfig.web.client_secret) {
    throw "oauth_web_credentials.json no corresponde a un OAuth Client ID de tipo Web application."
}

& gcloud config set project $ProjectId
& gcloud services enable `
    run.googleapis.com `
    cloudbuild.googleapis.com `
    artifactregistry.googleapis.com `
    secretmanager.googleapis.com `
    classroom.googleapis.com `
    drive.googleapis.com `
    --project $ProjectId

$serviceAccountEmail = "$ServiceAccountName@$ProjectId.iam.gserviceaccount.com"
& gcloud iam service-accounts describe $serviceAccountEmail --project $ProjectId *> $null
if ($LASTEXITCODE -ne 0) {
    & gcloud iam service-accounts create $ServiceAccountName `
        --display-name="Google Classroom Bridge" `
        --project $ProjectId
}

$sessionSecret = New-RandomSecret
$bridgeApiKey = New-RandomSecret

Add-SecretVersion "classroom-oauth-client-id" ([string]$oauthConfig.web.client_id)
Add-SecretVersion "classroom-oauth-client-secret" ([string]$oauthConfig.web.client_secret)
Add-SecretVersion "classroom-session-secret" $sessionSecret
Add-SecretVersion "classroom-bridge-api-key" $bridgeApiKey
Ensure-Secret $TokenSecret

foreach ($secretName in @(
    "classroom-oauth-client-id",
    "classroom-oauth-client-secret",
    "classroom-session-secret",
    "classroom-bridge-api-key",
    $TokenSecret
)) {
    & gcloud secrets add-iam-policy-binding $secretName `
        --member="serviceAccount:$serviceAccountEmail" `
        --role="roles/secretmanager.secretAccessor" `
        --project $ProjectId `
        --quiet
}

& gcloud secrets add-iam-policy-binding $TokenSecret `
    --member="serviceAccount:$serviceAccountEmail" `
    --role="roles/secretmanager.secretVersionAdder" `
    --project $ProjectId `
    --quiet

$environmentVariables = "GOOGLE_CLOUD_PROJECT=$ProjectId,ALLOWED_GOOGLE_EMAIL=$SchoolEmail,GOOGLE_TOKEN_SECRET_ID=$TokenSecret"
$secretMappings = "OAUTH_CLIENT_ID=classroom-oauth-client-id:latest,OAUTH_CLIENT_SECRET=classroom-oauth-client-secret:latest,SESSION_SECRET=classroom-session-secret:latest,BRIDGE_API_KEY=classroom-bridge-api-key:latest"

Push-Location $PSScriptRoot
try {
    & gcloud run deploy $ServiceName `
        --source . `
        --region $Region `
        --project $ProjectId `
        --allow-unauthenticated `
        --service-account $serviceAccountEmail `
        --set-env-vars $environmentVariables `
        --set-secrets $secretMappings `
        --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "Cloud Run no pudo desplegar el portal."
    }
}
finally {
    Pop-Location
}

$serviceUrl = (& gcloud run services describe $ServiceName `
    --region $Region `
    --project $ProjectId `
    --format="value(status.url)").Trim()

if (-not $serviceUrl) {
    throw "No fue posible obtener la URL de Cloud Run."
}

$callbackUrl = "$serviceUrl/oauth/callback"

if (Get-Command "gh" -ErrorAction SilentlyContinue) {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) {
        & gh secret set CLASSROOM_BRIDGE_URL --repo $Repository --body $serviceUrl
        & gh secret set CLASSROOM_BRIDGE_API_KEY --repo $Repository --body $bridgeApiKey
        $issueBody = @"
Portal OAuth desplegado correctamente.

- Inicio de sesión: $serviceUrl
- URI de retorno: $callbackUrl

La URL es pública, pero `/sync` requiere una clave privada y el portal solo acepta el correo escolar configurado.
"@
        & gh issue comment 1 --repo $Repository --body $issueBody
        Write-Host "Se configuraron los secretos de Actions y se registró la URL en el issue #1."
    }
    else {
        Write-Warning "GitHub CLI no está autenticado. Ejecuta 'gh auth login' y vuelve a ejecutar el script para guardar los secretos de Actions."
    }
}
else {
    Write-Warning "No se encontró GitHub CLI. Debes crear manualmente CLASSROOM_BRIDGE_URL y CLASSROOM_BRIDGE_API_KEY en GitHub Actions Secrets."
}

Write-Host ""
Write-Host "Portal desplegado: $serviceUrl"
Write-Host "Agrega exactamente esta URI en Google Cloud > OAuth Client > Authorized redirect URIs:"
Write-Host $callbackUrl
Write-Host ""
Write-Host "Después abre el portal e inicia sesión con tu cuenta escolar:"
Write-Host $serviceUrl

Set-Clipboard $callbackUrl
Write-Host "La URI de retorno quedó copiada al portapapeles."
