# ADACEEN

ADACEEN escanea archivos del workspace en VS Code (local o Codespaces), genera un resumen y construye un JSON listo para enviar a un backend de analisis.

## Caracteristicas

- Escaneo de archivos por `glob` con exclusiones.
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
- Sincronizacion con el overlay del navegador para publicar archivo activo, sugerencia y opciones de reemplazo.

## Comandos

- `ADACEEN: Escanear workspace`
- `ADACEEN: Abrir sugerencias del archivo activo`
- `ADACEEN: Actualizar sugerencias del archivo activo`
- `ADACEEN: Configurar sesión compartida`
- `ADACEEN: Aplicar siguiente reemplazo del navegador`

Ejecutalos desde la paleta de comandos (`Ctrl+Shift+P`).

## Configuracion

La extension expone estas opciones:

- `adaceen.scan.mode`: `auto | local | codespace | all`
- `adaceen.scan.includeGlob`: glob de inclusion
- `adaceen.scan.excludeGlob`: glob de exclusion
- `adaceen.scan.maxFiles`: maximo de archivos
- `adaceen.scan.maxFileKB`: tamano maximo por archivo en KB
- `adaceen.backend.baseUrl`: URL base del backend ADACEEN
- `adaceen.backend.sessionId`: sesion compartida con el overlay del navegador
- `adaceen.backend.codeActionsEnabled`: consulta reemplazos enviados desde el navegador
- `adaceen.backend.autoApplyCodeActions`: aplica reemplazos sin confirmacion

## Sincronizacion con navegador

1. Inicia sesion en el overlay ADACEEN del navegador.
2. En una pagina de Codespaces, copia el ID de sesion desde el panel de sincronizacion.
3. En VS Code/Codespaces ejecuta `ADACEEN: Configurar sesión compartida` y pega ese valor.
4. Abre un archivo del proyecto. La extension publica el archivo activo, el fragmento cercano al cursor y las opciones de reemplazo hacia el backend.
5. Desde el navegador elige una opcion de reemplazo. VS Code la reclama y la aplica con confirmacion, salvo que `adaceen.backend.autoApplyCodeActions` este activo.

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
