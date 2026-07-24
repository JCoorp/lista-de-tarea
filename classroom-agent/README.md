# ChatGPT Classroom Agent V2

Agente privado para leer actividades y anexos de Google Classroom, preparar trabajos en GitHub o Drive y ejecutar acciones visibles en la interfaz de Classroom mediante una extensión de Chrome.

## Capacidades

- Índice profundo de cursos activos, actividades, instrucciones y estado de entrega.
- Extracción de archivos de Drive, enlaces, formularios y videos anexados.
- Lectura de anuncios, temas y rúbricas cuando están disponibles.
- Cola privada de comandos en Google Sheets.
- Captura del texto y los enlaces visibles de una actividad abierta en Classroom.
- Navegación a la actividad exacta usando `alternateLink`.
- Adjuntar un enlace.
- Entregar, marcar como completada o anular una entrega.
- Confirmación visible obligatoria para acciones que cambian una entrega.

## Arquitectura

```text
ChatGPT
  ├─ Google Drive / Sheets: consulta datos y escribe comandos
  ├─ GitHub: crea o modifica el trabajo
  └─ Apps Script: sincroniza Classroom y mantiene la cola
                              ↓
                    Extensión de Chrome
                              ↓
                  classroom.google.com
```

Apps Script utiliza la API oficial para los datos estructurados. La extensión solo interviene en acciones que dependen de la interfaz web.

## Instalación de Apps Script

1. Abre el proyecto `ChatGPT Classroom Bridge` existente.
2. Crea un archivo de secuencia de comandos llamado `Agent`.
3. Copia en él el contenido de `apps-script/Agent.gs`.
4. Sustituye el manifiesto por `apps-script/appsscript.json`.
5. Guarda el proyecto.
6. Selecciona `setupAgentV2` y pulsa **Ejecutar**.
7. Acepta los permisos con `carlosjm.ti23@utsjr.edu.mx`.

El registro mostrará:

- `folderUrl`
- `commandSpreadsheetUrl`
- `bridgeToken`

Guarda el token en privado. No debe publicarse en GitHub ni en capturas.

## Implementar la aplicación web gratuita

En Apps Script:

1. Pulsa **Implementar → Nueva implementación**.
2. Tipo: **Aplicación web**.
3. Ejecutar como: **Yo**.
4. Acceso: **Cualquier usuario** o la opción más restringida que permita a la extensión abrir la URL.
5. Implementa y copia la URL terminada en `/exec`.

El endpoint exige `bridgeToken`, por lo que una llamada sin token no puede leer ni modificar la cola.

## Instalar la extensión

1. Descarga o clona la carpeta `chrome-extension`.
2. Abre `chrome://extensions` en Chrome.
3. Activa **Modo de desarrollador**.
4. Pulsa **Cargar descomprimida**.
5. Selecciona la carpeta `chrome-extension`.
6. Abre **Detalles → Opciones de la extensión**.
7. Pega la URL `/exec` y el `bridgeToken`.
8. Pulsa **Probar conexión**.

La extensión no ejecuta órdenes en segundo plano. El usuario debe abrir su panel, revisar el curso, la actividad y el enlace, y pulsar **Aprobar y ejecutar**.

## Hoja de comandos

`setupAgentV2` crea el archivo **ChatGPT Classroom Agent Commands** con la pestaña `Commands`.

Columnas:

| Columna | Uso |
|---|---|
| `command_id` | UUID único |
| `created_at` | Fecha ISO |
| `action` | Acción solicitada |
| `target_url` | Enlace de Classroom |
| `course_id` | ID del curso |
| `coursework_id` | ID de la actividad |
| `payload_json` | Parámetros JSON |
| `requires_confirmation` | `TRUE` para acciones sensibles |
| `status` | `queued`, `claimed`, `completed`, `failed` o `rejected` |
| `result_json` | Resultado y diagnóstico |

## Acciones compatibles

### Abrir y capturar una actividad

```json
{
  "action": "capture_page",
  "targetUrl": "https://classroom.google.com/...",
  "payload": {
    "courseName": "Desarrollo Web Integral",
    "courseworkTitle": "API de terceros"
  }
}
```

### Adjuntar un repositorio

```json
{
  "action": "attach_link",
  "targetUrl": "https://classroom.google.com/...",
  "payload": {
    "courseName": "Desarrollo Web Integral",
    "courseworkTitle": "API de terceros",
    "url": "https://github.com/JCoorp/proyecto"
  }
}
```

### Adjuntar y entregar

```json
{
  "action": "attach_and_submit",
  "targetUrl": "https://classroom.google.com/...",
  "requiresConfirmation": true,
  "payload": {
    "courseName": "Desarrollo Web Integral",
    "courseworkTitle": "API de terceros",
    "url": "https://github.com/JCoorp/proyecto"
  }
}
```

## Flujo operativo esperado

1. ChatGPT consulta `ChatGPT_Classroom_Deep_Index.json`.
2. Lee las instrucciones y abre anexos accesibles en Drive o en la web.
3. Propone y ejecuta el trabajo en GitHub o Drive.
4. Escribe una fila `queued` en la hoja de comandos.
5. El usuario abre el panel de la extensión.
6. La extensión muestra la actividad y el enlace exactos.
7. El usuario aprueba.
8. La extensión realiza la acción y registra el resultado.
9. Apps Script vuelve a sincronizar para comprobar el estado.

## Límites

- Los selectores de la interfaz de Classroom pueden cambiar; los errores quedan registrados en `result_json` junto con una captura textual de la página.
- CAPTCHA, reautenticación o verificación en dos pasos requieren intervención del usuario.
- La extensión trabaja en Chrome de escritorio; no controla la aplicación móvil de Classroom.
- No se debe hacer pública la hoja de comandos, el token ni la carpeta de datos académicos.
