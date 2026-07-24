# Google Classroom Bridge — versión gratuita con Apps Script

Esta variante no usa Cloud Run, Cloud Scheduler, Secret Manager ni una cuenta de facturación. El código se ejecuta dentro de la cuenta escolar mediante Google Apps Script.

## Instalación

1. Inicia sesión en Google con `carlosjm.ti23@utsjr.edu.mx`.
2. Abre `https://script.google.com/home/projects/create`.
3. Cambia el nombre del proyecto a `ChatGPT Classroom Bridge`.
4. Borra el contenido de `Código.gs` y pega todo el contenido de `Code.gs` de esta carpeta.
5. En la barra izquierda, junto a **Servicios**, pulsa `+`.
6. Selecciona **Google Classroom API** y pulsa **Agregar**.
7. Guarda el proyecto.
8. En el selector de funciones elige `setup` y pulsa **Ejecutar**.
9. Revisa los permisos y autoriza únicamente con la cuenta escolar indicada.

`setup()` realiza la primera sincronización y crea un activador automático cada 30 minutos.

## Resultado

En Google Drive aparece la carpeta privada:

`ChatGPT Classroom Bridge`

con estos archivos:

- `ChatGPT_Classroom_Pendientes.json`
- `ChatGPT_Classroom_Pendientes.md`

ChatGPT puede buscar y leer estos archivos mediante la conexión de Google Drive.

## Actualización manual

Para actualizar inmediatamente, ejecuta la función `syncClassroom` desde el editor de Apps Script.

## Seguridad

- El código valida que la cuenta ejecutora sea `carlosjm.ti23@utsjr.edu.mx`.
- Solo se solicitan permisos para leer cursos, trabajos y entregas propias, además de escribir el resumen en Drive.
- El script no entrega, modifica ni elimina actividades de Classroom.
- El archivo JSON OAuth creado anteriormente ya no se utiliza y puede eliminarse de Cloud Shell y del dispositivo.

## Posible restricción institucional

Si Google Workspace muestra que el administrador bloqueó la aplicación o la API de Classroom, la autorización debe ser permitida por el administrador de UTSJR. No existe una forma legítima de omitir esa política.
