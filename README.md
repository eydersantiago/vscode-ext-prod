# ADACEEN

ADACEEN escanea archivos del workspace en VS Code (local o Codespaces), genera un resumen y construye un JSON listo para enviar a un backend de analisis.

## Caracteristicas

- Escaneo de archivos por `glob` con exclusiones.
- Coach contextual para VS Code/Codespaces usando APIs nativas:
- Code Actions cerca del cursor, seleccion o diagnostic.
- Hover contextual con acceso rapido a ADACEEN.
- QuickPick con opciones accionables.
- Webview lateral persistente en la actividad ADACEEN.
- StatusBar discreto para pedir ayuda manual.
- Deteccion de inactividad, diagnostic repetido y tareas fallidas.
- Llamadas a `POST /github-mentor` con contexto del editor activo.
- Guardado de memoria del proyecto con `POST /api/projects/save`.
- Soporte para entornos:
- `local` (carpetas con `scheme=file`)
- `codespace` (carpetas remotas)
- `auto` (detecta segun entorno)
- `all` (todo el workspace)
- Limites configurables:
- maximo de archivos
- tamano maximo por archivo (KB)
- Salida detallada en `Output > ADACEEN`:
- resumen legible
- JSON con metadatos y contenido de archivos leidos

## Comando

- `ADACEEN: Escanear workspace`
- `ADACEEN: pedir recomendacion contextual`
- `ADACEEN: abrir recomendaciones`
- `ADACEEN: guardar memoria del proyecto`

Ejecutalo desde la paleta de comandos (`Ctrl+Shift+P`).

## Configuracion

La extension expone estas opciones:

- `pdcCoach.backendUrl`: URL base del backend PDC.
- `pdcCoach.sessionId`: `x-session-id` para politica, telemetria y memoria.
- `pdcCoach.idleThresholdMs`: tiempo de inactividad para detectar bloqueo.
- `pdcCoach.backendTimeoutMs`: timeout de llamadas a backend.
- `pdcCoach.showQuickPickOnSignal`: muestra QuickPick ante senales automaticas.
- `pdcCoach.maxCodeChars`: maximo de caracteres enviados como contexto.
- `pdcCoach.maxProjectFiles`: maximo de archivos al guardar memoria.
- `adaceen.scan.mode`: `auto | local | codespace | all`
- `adaceen.scan.includeGlob`: glob de inclusion
- `adaceen.scan.excludeGlob`: glob de exclusion
- `adaceen.scan.maxFiles`: maximo de archivos
- `adaceen.scan.maxFileKB`: tamano maximo por archivo en KB

## Desarrollo local

1. Instala dependencias:

```bash
npm install
```

2. Compila:

```bash
npm run compile
```

3. Presiona `F5` para abrir `Extension Development Host`.
4. En la nueva ventana, abre una carpeta y ejecuta `ADACEEN: Escanear workspace`.

## Pruebas local + Codespaces

Para pruebas end-to-end con backend local expuesto por Cloudflare Tunnel, revisa:

- `README.local-testing.md`

## Publicacion

Para publicar en Visual Studio Marketplace:

1. Crea tu `publisher` en Marketplace.
2. Configura el campo `publisher` en `package.json` con ese ID.
3. Genera un PAT (Azure DevOps) con permisos de Marketplace.
4. Publica con:

```bash
npx @vscode/vsce publish
```

## Licencia

MIT
