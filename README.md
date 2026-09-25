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
- `ADACEEN: Conectar` (tambien desde la barra de estado «ADACEEN: sin conectar»)
- `ADACEEN: Configurar sesión compartida` (compatibilidad: abre la misma caja que «Tengo un código o sesión»; el navegador aun lo cita)
- `ADACEEN: Aplicar siguiente reemplazo del navegador`

Ejecutalos desde la paleta de comandos (`Ctrl+Shift+P`).

## Configuracion

La extension expone estas opciones:

- `adaceen.scan.mode`: `auto | local | codespace | all`
- `adaceen.scan.includeGlob`: glob de inclusion
- `adaceen.scan.excludeGlob`: glob de exclusion
- `adaceen.scan.maxFiles`: maximo de archivos
- `adaceen.scan.maxFileKB`: tamano maximo por archivo en KB
- `adaceen.backend.baseUrl`: URL base del backend ADACEEN. Vacio (por defecto): el backend local `http://127.0.0.1:3000` si esta corriendo en el equipo (`npm run dev:local`) y, si no, produccion; en Codespaces, produccion
- `adaceen.backend.sessionId`: (heredado) sesion compartida con el overlay del navegador; solo se usa si no hay sesion emparejada ni archivo del tunel (ver «Sesion»)
- `adaceen.backend.codeActionsEnabled`: consulta reemplazos enviados desde el navegador
- `adaceen.backend.autoApplyCodeActions`: los reemplazos recien elegidos en el overlay que VS Code encuentra donde el estudiante los vio ya se aplican sin preguntar (el clic es la confirmacion); este ajuste solo decide si tambien se aplican sin preguntar los demas (esperaron mas de 10 minutos en la cola o no se encontro su codigo); si la politica del docente pide confirmar, esos preguntan igual
- `adaceen.triggers.blockingSeconds`: segundos que el mismo error debe seguir presente para considerar un bloqueo (defecto 90; tambien cuenta que aparezca 3 veces en 10 minutos)
- `adaceen.triggers.suggestOnBlocking`: al detectar un bloqueo, pide una sugerencia con `trigger: "blocking"` (defecto `true`)
- `adaceen.codeApplication.offlineMaxLines`: si no se puede consultar `apply-check`, solo se aplican cambios de hasta estas lineas (defecto 12)

## Tutor: bloqueo y aplicacion de codigo

- Todas las llamadas al backend llevan `x-adaceen-client-id` (id persistente de esta instalacion) y `x-session-id` cuando hay sesion (ver «Sesion»), asi que las metricas funcionan tambien sin sesion.
- Con errores en el archivo activo se registran `compile_error_detected` y, si el estudiante se queda atascado, `blocking_detected`. El texto del error solo viaja para que el backend calcule su hash; no se guarda.
- Antes de aplicar cualquier cambio del tutor se consulta `POST /api/suggestions/apply-check`: si la politica del docente no lo permite, no se aplica y se muestra el motivo.
- Si la politica pide confirmar (`requireConfirmation`), en un cambio de hasta 5 lineas que no borra codigo la confirmacion es el clic explicito del estudiante sobre la accion (ventana flotante, «Aceptar ayuda» del CodeLens, pista o hover, arreglo rapido abierto con `Ctrl+.`, comando o un reemplazo recien elegido en el overlay): no se abre un segundo dialogo. El modal «Aplicar» queda para las aplicaciones automaticas, los cambios mas grandes y las eliminaciones.
- Mientras la ventana flotante esta abierta, el CodeLens no repite «Aceptar ayuda» y la pista en linea se oculta. Si el estudiante la cierra con la X, esa sugerencia no se vuelve a ofrecer hasta que llegue otra.
- Pruebas unitarias (sin descargar VS Code): `npm run test:unit`.

## Sesion

La extension resuelve la sesion de ADACEEN (`x-session-id`) en este orden (`src/editor-session.ts`):

1. La sesion emparejada en este equipo, en el llavero de VS Code (SecretStorage `adaceen.editorSession`; nunca en settings). Solo se usa con el backend donde se obtuvo.
2. `~/.adaceen/editor-session.json`, que escribe la VM de editores al preparar el tunel. Cero clics: se relee al arrancar, al volver a la ventana, cuando el archivo cambia y cuando el backend rechaza la sesion. En la extension web no hay archivo. En el tunel, si el archivo es mas nuevo que la sesion emparejada, gana el archivo.
3. El ajuste heredado `adaceen.backend.sessionId` o la variable `ADACEEN_SESSION_ID`.

Sin sesion, al arrancar se intenta en silencio la cuenta de GitHub que VS Code ya tiene (`POST /api/auth/editor/github`), salvo que en este equipo se haya cerrado sesion o desconectado VS Code (hasta la siguiente conexion hecha a mano) o que `adaceen.backend.baseUrl` venga del espacio de trabajo abierto. La barra de estado muestra «ADACEEN: sin conectar» o «ADACEEN: <nombre>»; con un clic abre `ADACEEN: Conectar`:

- «Con mi cuenta de GitHub (recomendado)»: un clic en «Permitir». Requiere haber conectado esa cuenta de GitHub en el overlay del navegador.
- «Tengo un código o sesión»: el codigo `XXXX-XXXX` de un solo uso que muestra el overlay (dura 10 minutos). Tambien acepta el ID de sesion de versiones anteriores.
- «Desconectar este equipo» (si hay sesion guardada): la olvida y no vuelve a conectar en silencio.

Si el backend responde `x-adaceen-session: invalid` (por ejemplo, se cerro sesion en el navegador), la extension olvida esa sesion, relee el archivo y, si no queda otra, avisa una vez por ventana con el boton «Conectar» (el aviso lo nombra; en el tunel tambien sirve volver a pulsar «Abrir mi editor» en el navegador). No vuelve a conectar en silencio con GitHub (en un equipo compartido esa cuenta puede ser de otro estudiante). Una sesion que vence con la ventana abierta se detecta en la revision de cada 20 s. El token de GitHub no se guarda ni se registra, y el canal ADACEEN nunca muestra ids de sesion ni codigos.

### Enlaces desde el navegador (VS Code de escritorio)

```
vscode://adaceen.adaceen/abrir?code=XXXX-XXXX&repo=owner/repo
vscode://adaceen.adaceen/conectar?code=XXXX-XXXX
```

El codigo se canjea contra el backend ya resuelto por la extension (un parametro `backend` distinto se ignora). Si llega otro enlace mientras se atiende uno (doble clic), se atiende el ultimo, que trae el codigo vigente. Si el enlace reemplaza la sesion de otra persona, el aviso lo dice y ofrece «Desconectar». Con `repo` se abre la carpeta recordada si ya se clono en este equipo; si no, se pide la carpeta padre, se clona `https://github.com/<owner>/<repo>.git` y se abre. Si falta git, la extension lo explica y ofrece el comando de instalacion (`xcode-select --install` en la Mac).

## Sincronizacion con navegador

1. Inicia sesion en el overlay ADACEEN del navegador.
2. Conecta VS Code: en el tunel ya viene conectado; en la Mac del laboratorio, usa «Abrir en VS Code de este equipo» del overlay; en otros casos, `ADACEEN: Conectar`.
3. Abre un archivo del proyecto. La extension publica el archivo activo, el fragmento cercano al cursor y las opciones de reemplazo hacia el backend.
4. Desde el navegador elige una opcion de reemplazo. VS Code la reclama y, si encuentra el codigo que elegiste donde lo viste, la aplica sin volver a preguntar (tu clic es la confirmacion; la politica del docente se consulta igual y un cambio grande o que borra codigo pide su dialogo). Si el reemplazo espero mas de 10 minutos en la cola (VS Code estaba cerrado) o su codigo ya no esta (o aparece varias veces lejos del cursor), VS Code pregunta antes de aplicarlo y dice donde caera: el dialogo del docente si su politica pide confirmar o, si no, «Aplicar reemplazo» / «Omitir» (salvo que `adaceen.backend.autoApplyCodeActions` este activo). «ADACEEN: Aplicar siguiente reemplazo del navegador» tambien pregunta por un reemplazo viejo.

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
