# Puente privado: Google Classroom → GitHub Actions → Google Drive → ChatGPT

Este proyecto permite consultar tus tareas pendientes de Google Classroom sin publicar información académica en GitHub.

## Flujo principal

1. Se despliega un pequeño portal privado en Google Cloud Run.
2. Solo la primera vez abres su enlace y pulsas **Iniciar sesión con Google**.
3. Google muestra siempre el selector de cuentas.
4. El portal comprueba que el correo elegido sea exactamente la cuenta escolar configurada.
5. El refresh token se guarda en **Google Secret Manager**, no en el código ni en el repositorio.
6. GitHub Actions llama al endpoint protegido `/sync` cada 30 minutos o cuando se abre un issue `[classroom-refresh]`.
7. El portal consulta Classroom y actualiza en tu Drive:
   - `ChatGPT_Classroom_Pendientes.json`
   - `ChatGPT_Classroom_Pendientes.md`
8. ChatGPT puede leer esos archivos mediante la conexión de Google Drive cuando preguntes por tus tareas.

El workflow solo registra cantidades de cursos y tareas; no imprime nombres de materias ni títulos de actividades.

## Protección contra usar la cuenta equivocada

Durante el despliegue se configura `ALLOWED_GOOGLE_EMAIL` con el correo escolar exacto.

- Google recibe `prompt=consent select_account`, por lo que muestra el selector de cuentas.
- También se envía el correo escolar como `login_hint`.
- Después del consentimiento, el servidor consulta el correo real autorizado.
- Si no coincide exactamente con `ALLOWED_GOOGLE_EMAIL`, descarta la autorización y no guarda el token.

## Configuración de una sola vez

### 1. Preparar Google Cloud

1. Crea o selecciona un proyecto de Google Cloud.
2. Configura la pantalla de consentimiento OAuth.
3. Si la aplicación está en modo de prueba, agrega tu correo escolar como usuario de prueba.
4. Crea un **OAuth Client ID** de tipo **Web application**.
5. Descarga el JSON y guárdalo localmente como:

```text
classroom-bridge/oauth_web_credentials.json
```

No lo subas a GitHub. Está excluido por `.gitignore`.

### 2. Preparar las herramientas

En Windows necesitas:

- Google Cloud CLI (`gcloud`)
- GitHub CLI (`gh`), recomendado para crear automáticamente los secretos de Actions

Inicia sesión:

```powershell
gcloud auth login
gh auth login
```

La cuenta usada en `gcloud` debe poder administrar el proyecto de Google Cloud. La cuenta elegida posteriormente en el portal será la cuenta escolar que contiene Classroom; pueden ser cuentas distintas.

### 3. Desplegar el portal

Desde PowerShell:

```powershell
cd classroom-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\deploy_cloud_run.ps1 -ProjectId "TU_ID_DE_PROYECTO" -SchoolEmail "TU_CORREO_ESCOLAR"
```

El script:

- habilita las APIs necesarias;
- crea la cuenta de servicio;
- crea secretos para el cliente OAuth, la sesión y la clave interna;
- crea el secreto donde se guardará la autorización de Google;
- despliega el contenedor en Cloud Run;
- configura `CLASSROOM_BRIDGE_URL` y `CLASSROOM_BRIDGE_API_KEY` en GitHub cuando `gh` está autenticado.

### 4. Registrar la URI de retorno

Al terminar, el script muestra y copia una dirección semejante a:

```text
https://classroom-bridge-xxxxx-uc.a.run.app/oauth/callback
```

En Google Cloud abre el OAuth Client ID de tipo **Web application** y agrega exactamente esa dirección en **Authorized redirect URIs**.

### 5. Iniciar sesión una sola vez

Abre la URL principal que imprimió el script, por ejemplo:

```text
https://classroom-bridge-xxxxx-uc.a.run.app
```

Pulsa **Iniciar sesión con Google**, selecciona la cuenta escolar y concede los permisos. El portal mostrará `Classroom conectado` cuando el refresh token haya quedado guardado.

### 6. Primera sincronización

En GitHub abre:

```text
Actions → Sync Google Classroom → Run workflow
```

Después deberán aparecer en Drive la carpeta `ChatGPT Classroom Bridge` y los dos archivos de pendientes.

## Actualización solicitada por ChatGPT

Para solicitar una actualización inmediata se abre un issue con un título como:

```text
[classroom-refresh] actualizar tareas
```

La Action llama al portal, actualiza Drive, comenta el resultado y cierra el issue. No se escriben datos académicos en el issue.

## Permisos solicitados

- `classroom.courses.readonly`
- `classroom.coursework.me.readonly`
- `drive.file`
- correo básico de la cuenta para comprobar que es la cuenta escolar autorizada

`drive.file` permite administrar únicamente los archivos creados por este proyecto. La integración no puede entregar, editar ni borrar tareas de Classroom.

## Seguridad

- El token de Google no se guarda en GitHub.
- Secret Manager conserva el token como una versión de secreto protegida por IAM.
- La URL `/sync` requiere `X-Bridge-Key` y no acepta llamadas sin la clave privada.
- El estado OAuth se valida para evitar solicitudes manipuladas.
- La cookie temporal del inicio de sesión es `Secure`, `HttpOnly` y expira en diez minutos.
- El correo autorizado se valida en el servidor; `login_hint` por sí solo no se considera una medida de seguridad.

## Compatibilidad con el método anterior

El workflow conserva temporalmente el secreto `GOOGLE_TOKEN_JSON_B64` como respaldo. Cuando `CLASSROOM_BRIDGE_URL` y `CLASSROOM_BRIDGE_API_KEY` existen, el portal web tiene prioridad y el secreto anterior deja de utilizarse.

## Desarrollo local

```bash
python -m venv .venv
python -m pip install -r requirements-web.txt
python -m pytest
uvicorn oauth_portal:app --reload
```
