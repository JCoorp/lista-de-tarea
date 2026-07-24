# Puente privado: Google Classroom → GitHub Actions → Google Drive → ChatGPT

Este proyecto permite consultar tus tareas pendientes de Google Classroom sin publicar información académica en GitHub.

## Cómo funciona

1. Una GitHub Action se ejecuta cada 30 minutos o cuando se abre un issue cuyo título comienza con `[classroom-refresh]`.
2. La Action consulta los cursos activos, las tareas publicadas y tus propias entregas mediante la API de Google Classroom.
3. Genera un resumen JSON y Markdown dentro de una carpeta privada de tu Google Drive llamada `ChatGPT Classroom Bridge`.
4. ChatGPT puede buscar y leer esos archivos mediante la conexión de Google Drive cuando preguntes por tus tareas pendientes.

El workflow nunca imprime nombres de materias ni títulos de tareas en los logs públicos y nunca guarda esos datos en el repositorio.

## Configuración necesaria una sola vez

### 1. Crear el proyecto de Google Cloud

1. Abre Google Cloud Console y crea un proyecto, por ejemplo `ChatGPT Classroom Bridge`.
2. Habilita **Google Classroom API** y **Google Drive API**.
3. Configura la pantalla de consentimiento OAuth.
4. Agrega tu cuenta como usuario de prueba o publica la aplicación para uso personal.
5. Crea un **OAuth Client ID** de tipo **Desktop app**.
6. Descarga el JSON y guárdalo en esta carpeta como `credentials.json`.

Permisos solicitados:

- `classroom.courses.readonly`
- `classroom.coursework.me.readonly`
- `drive.file`

`drive.file` permite que el programa administre únicamente los archivos de Drive creados por este mismo proyecto.

### 2. Generar la autorización en Windows

En PowerShell, dentro de la carpeta `classroom-bridge`:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup_windows.ps1
```

Se abrirá Google para que autorices el acceso. Al terminar, el valor del secreto quedará copiado al portapapeles.

### 3. Crear el secreto en GitHub

En el repositorio abre:

`Settings → Secrets and variables → Actions → New repository secret`

- Nombre: `GOOGLE_TOKEN_JSON_B64`
- Valor: pega el contenido copiado por el script.

No compartas ni publiques ese valor. Después elimina `credentials.json` y `google_token.b64` de tu equipo.

### 4. Primera sincronización

Abre `Actions → Sync Google Classroom → Run workflow`.

Al finalizar aparecerán en tu Drive:

- `ChatGPT_Classroom_Pendientes.json`
- `ChatGPT_Classroom_Pendientes.md`

## Actualización solicitada por ChatGPT

Para solicitar una actualización, se abre un issue con un título similar a:

```text
[classroom-refresh] actualizar tareas
```

La Action lo procesa, actualiza Drive y cierra el issue automáticamente. No se escriben datos académicos en el issue.

## Seguridad

- El repositorio contiene solo código.
- Las tareas se guardan únicamente en Google Drive.
- El token OAuth se almacena como GitHub Actions secret.
- Los permisos son de solo lectura para Classroom.
- La integración no puede entregar, editar ni borrar tareas.

## Nota sobre OAuth de Google

Cuando la pantalla de consentimiento es externa y permanece en modo **Testing**, Google puede hacer que el refresh token expire después de 7 días. Para una integración permanente, cambia el estado de publicación a producción para tu uso personal o vuelve a ejecutar la autorización cuando venza.

## Desarrollo local

```bash
python -m venv .venv
python -m pip install -r requirements.txt
python -m pytest
```
