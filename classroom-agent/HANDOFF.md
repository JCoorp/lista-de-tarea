# Classroom Agent — handoff persistente

Este archivo permite recuperar el contexto operativo del proyecto en futuros chats sin depender del historial de una sola conversación.

## Objetivo

Conectar ChatGPT con Google Classroom mediante una cola privada de comandos, Apps Script, Google Drive y una extensión de Chrome. ChatGPT puede leer el índice de tareas, colocar órdenes en una hoja y la extensión ejecuta acciones en Classroom después de que el usuario las apruebe.

## Repositorio

- GitHub: `JCoorp/lista-de-tarea`
- Carpeta principal del agente: `classroom-agent/`
- Apps Script: `classroom-agent/apps-script/`
- Extensión de Chrome: `classroom-agent/chrome-extension/`

## Cuentas

- Cuenta escolar de Classroom y propietaria de Apps Script: `carlosjm.ti23@utsjr.edu.mx`
- Cuenta conectada a Google Drive desde ChatGPT: `chatgptusejc@gmail.com`
- La cuenta conectada de Drive necesita permiso de edición sobre la carpeta y la hoja de comandos.

## Recursos activos

- Carpeta de Drive: `https://drive.google.com/drive/folders/1Qpp45I6s4rq8qmEbpD1PZ4Iqpk6BjVO-`
- Hoja de comandos: `https://docs.google.com/spreadsheets/d/1xXrHLT5JZoieaUsadpA-JeGvX6AAhxc4RwdZLXXP53A/edit`
- Aplicación web de Apps Script: `https://script.google.com/macros/s/AKfycbyLnPPWtev8SyY_zzYu-ewLdcjmZtAksyATSAv5d8u_gKymtZ88l9Ejn8NXtVuXr5llNA/exec`
- Proyecto de Apps Script: `ChatGPT Classroom Bridge`

## Archivos principales de Apps Script

- `Code.gs`: sincronización resumida de pendientes.
- `Agent.gs`: agente V2, índice profundo, cola, `doGet`, `doPost` y `setupAgentV2`.
- `SelfUpdate.gs`: actualización automática del código de Apps Script desde GitHub.
- `appsscript.json`: scopes, servicio avanzado de Classroom y configuración de web app.

## Estado verificado

Última configuración funcional verificada el 24 de julio de 2026:

- 10 cursos activos.
- 106 actividades detectadas.
- 37 pendientes.
- 32 atrasadas.
- 0 errores de sincronización.
- La extensión mostró `Conexión correcta`.
- El comando seguro `capture_page` se ejecutó correctamente.
- La captura confirmó el uso de `carlosjm.ti23@utsjr.edu.mx` y mostró los cursos escolares reales.

## Flujo operativo

1. ChatGPT lee el índice profundo de Drive cuando el usuario pregunta por tareas.
2. Para acciones de navegador, ChatGPT agrega una fila a la pestaña `Commands`.
3. El usuario abre Google Classroom con la cuenta escolar.
4. El usuario abre la extensión y pulsa `Actualizar`.
5. La extensión muestra la acción pendiente.
6. El usuario revisa y pulsa `Aprobar y ejecutar`.
7. La extensión ejecuta la acción, registra el resultado y, cuando corresponde, guarda un snapshot.

## Columnas de la hoja Commands

`command_id, created_at, action, target_url, course_id, coursework_id, payload_json, requires_confirmation, status, claimed_at, completed_at, result_json`

Estados típicos: `queued`, `claimed`, `completed`, `failed`, `rejected`.

## Acciones admitidas por la extensión

- `open_activity`
- `capture_page`
- `attach_link`
- `submit`
- `attach_and_submit`
- `reclaim`

Las acciones `submit`, `attach_and_submit` y `reclaim` cambian el estado de una entrega y requieren revisión visible del usuario.

## Archivos generados en Drive

- `ChatGPT_Classroom_Deep_Index.json`
- `ChatGPT_Classroom_Deep_Index.md`
- `ChatGPT_Classroom_Pendientes.json`
- `ChatGPT_Classroom_Pendientes.md`
- `ChatGPT_Classroom_Last_Page_Snapshot.json` cuando se ejecuta una captura.

## Token privado

El token privado **no debe almacenarse en este repositorio público**.

- Se guarda localmente en Chrome dentro de la configuración de la extensión.
- Si se pierde, abrir `Agent.gs`, ejecutar `setupAgentV2` y copiar el valor `bridgeToken` del registro.
- Nunca pegar el token en GitHub, documentos públicos o capturas compartidas.
- Si se sospecha exposición, debe rotarse antes de continuar.

## Recuperación en una conversación nueva

El usuario puede escribir:

> Recupera el contexto del Classroom Agent desde `JCoorp/lista-de-tarea`, archivo `classroom-agent/HANDOFF.md`, y revisa también la hoja de comandos y el índice profundo de Drive.

El asistente debe:

1. Leer este archivo desde GitHub.
2. Consultar la hoja de comandos actual.
3. Consultar el índice profundo más reciente de Drive.
4. No asumir que las cifras de pendientes siguen vigentes; deben actualizarse antes de responder.
5. No pedir el token salvo que sea necesario reconfigurar la extensión.

## Actualizaciones

- Apps Script puede actualizarse automáticamente desde la rama principal mediante `SelfUpdate.gs`.
- La extensión de Chrome es local; después de cambios en GitHub normalmente hay que descargar el ZIP nuevo o actualizar la carpeta local y pulsar `Volver a cargar` en `chrome://extensions`.
- La conexión de la extensión usa solicitudes sin cookies de Google (`credentials: "omit"`) para evitar redirecciones a `/macros/u/1/` y respuestas HTML.

## Limitaciones importantes

- La extensión no ejecuta comandos sola en segundo plano; el usuario abre el popup y aprueba.
- La automatización del DOM puede romperse si Google cambia la interfaz de Classroom.
- Antes de entregar, adjuntar o recuperar una tarea se debe verificar curso, actividad y enlace.
- Las tareas calificadas deben pasar por revisión del usuario antes de su envío.
- No afirmar que una acción fue completada sin comprobar `status` y `result_json` en la hoja.

## Prueba segura recomendada

Usar primero `capture_page` o `open_activity`. No comenzar las pruebas con `submit`.
