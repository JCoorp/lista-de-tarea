$ErrorActionPreference = "Stop"

if (-not (Test-Path "credentials.json")) {
    Write-Error "Falta credentials.json. Descarga un OAuth Client ID de tipo Desktop app desde Google Cloud y colócalo aquí."
}

py -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install --requirement requirements.txt
& .\.venv\Scripts\python.exe authorize_google.py

$token = Get-Content -Raw "google_token.b64"
Set-Clipboard $token
Write-Host "El secreto GOOGLE_TOKEN_JSON_B64 quedó copiado al portapapeles."
Write-Host "Agrégalo en GitHub > Settings > Secrets and variables > Actions."
Write-Host "Después elimina credentials.json y google_token.b64 de tu computadora."
