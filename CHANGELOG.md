# Change Log

All notable changes to the "adaceen" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.32] - 2026-09-25

Menos pasos repetidos (auditoría de redundancias del frontend, ítems 6, 7 y 13).

### Cambiado

- **El clic explícito del estudiante cumple `requireConfirmation` en los cambios pequeños.** La política del docente (`POST /api/suggestions/apply-check`) puede pedir confirmación antes de aplicar código del tutor (`requireConfirmation: true`, el valor por defecto). Desde esta versión, en un cambio de hasta 5 líneas que no borra código (`CLICK_CONFIRM_MAX_LINES`), esa confirmación es el clic del estudiante sobre la acción concreta: «Insertar debajo» o «Modificar seleccion» de la ventana flotante, «Aceptar ayuda» del CodeLens, de la pista en línea o del hover, el arreglo rápido que el estudiante abre con `Ctrl+.`, «ADACEEN: Aplicar sugerencia activa» o un reemplazo que acaba de elegir en el overlay del navegador. Ya no se abre después el modal «ADACEEN: ¿Aplicar el cambio del tutor…?» con «Aplicar», que solo repetía la pregunta. El modal sigue para las aplicaciones automáticas (las que nadie pulsó), para los cambios de más de 5 líneas y para las eliminaciones, aunque haya clic: un clic sin querer en un CodeLens no reescribe ni borra un bloque sin una pausa, y el detalle dice por qué pregunta. El menú de arreglos rápidos que ADACEEN abre solo (`adaceen.suggestions.autoOpenSelectionActions` sin ventana flotante) no cuenta como clic: su acción viene preseleccionada y un Enter la aplicaría. La política se respeta igual: si el docente no permite aplicar (`allowed: false`: aplicación desactivada, cambio demasiado largo o cupo agotado), no se aplica y se muestra el motivo; sin conexión sigue la regla de `adaceen.codeApplication.offlineMaxLines`. El veredicto y las métricas locales dicen cómo se confirmó (`confirmedBy: click | dialog`).
- **Reemplazos elegidos en el overlay:** se aplican sin el segundo aviso «Aplicar reemplazo» / «Omitir» cuando el clic en el overlay es reciente (10 minutos o menos en la cola, con la hora del servidor) y VS Code encuentra el cambio donde el estudiante lo vio: el código elegido aparece una sola vez en el archivo (o varias, pero una toca el cursor o la selección, y se usa esa en lugar de la primera del archivo) o, al insertar, la línea enfocada sigue en su sitio. Si no (el estudiante editó esa parte, el código aparece varias veces lejos del cursor, esperó más de 10 minutos porque VS Code estaba cerrado o falta la hora en que se pidió), pregunta como antes y dice qué es, hace cuánto se pidió y dónde caerá («No encontré en Main.java el código que elegiste (cambió o ya no está): se aplicará en la línea 14.»): el diálogo del docente si su política pide confirmar o, si no, «Aplicar reemplazo» / «Omitir» (salvo `adaceen.backend.autoApplyCodeActions`). El cambio se aplica en el sitio anunciado aunque el estudiante mueva el cursor mientras decide. «ADACEEN: Aplicar siguiente reemplazo del navegador», ejecutado a mano, no cuenta como clic: aplica el más antiguo de la cola, que el estudiante no ve. La métrica de la cola guarda `confirmedBy` (`click`, `dialog` o `auto`) y `targetVerified`.
- **Una sola superficie con «Aceptar ayuda» a la vez.** Mientras la ventana flotante está abierta sobre la selección, el CodeLens no agrega «Aceptar ayuda: …» (el resumen «ADACEEN: …» se queda, así la línea no salta) y la pista en línea y la decoración de fin de línea se apagan; antes volvían a aparecer con cualquier movimiento del cursor. Vuelven cuando la ventana se retira porque el estudiante movió la selección (`src/suggestion-surfaces.ts`). Si la cerró con la X, esa sugerencia quedó descartada y no se vuelve a ofrecer en el CodeLens ni en la pista hasta que llegue otra. Con los comentarios del editor ocultos (`comments.visible: false`) la ventana no se ve y el CodeLens y la pista siguen ofreciendo la acción. El arreglo rápido (`Ctrl+.`) sigue disponible. Límite conocido: si el estudiante pliega la ventana con su flecha, VS Code no avisa a la extensión; la ventana se vuelve a abrir con su icono del margen.
- **«ADACEEN: Conectar»:** una sola opción para escribir o pegar, «Tengo un código o sesión», que acepta el código `XXXX-XXXX` del navegador o el ID de sesión de versiones anteriores. Reemplaza a «Tengo un código del navegador» y «Pegar sesión», y su detalle ya no dice que el overlay copia el ID de sesión (copia un código).
- **Cuentas de docente con GitHub:** el aviso ya no repite el texto del backend, que citaba «Copiar sesion» y «Tengo un codigo del navegador». VS Code muestra su propio texto (mismo comienzo, «Las cuentas de docente y administrador se vinculan con un codigo del navegador»), que nombra «Copiar codigo para VS Code» y «Tengo un código o sesión», y en lugar de «Reintentar» (que fallaría igual) ofrece el botón «Tengo un código o sesión», que abre la caja del código.
- **«ADACEEN: Configurar sesión compartida»** sigue en la paleta por compatibilidad: el overlay lo cita con un backend sin emparejamiento y las versiones anteriores del navegador mandan a buscarlo con F1. Abre la misma caja que «Tengo un código o sesión» y avisa lo mismo al conectar.
- **Aviso de sesión perdida:** nombra el botón que ofrece. Dice «Pulsa «Conectar»…» y, en el túnel, también «…o vuelve a pulsar «Abrir mi editor» en el navegador». Antes solo mandaba al navegador y el botón decía otra cosa. Con un backend sin la ruta de canje, el mensaje manda a «Tengo un código o sesión» en lugar de «Pegar sesión».
- 39 pruebas unitarias nuevas (175 en total): clic explícito frente a `requireConfirmation` (cambio pequeño, grande y eliminación), política que no permite aplicar, regla offline con clic, menú de arreglos rápidos abierto solo, antigüedad de los reemplazos del overlay (sin hora se pregunta), destino comprobado de los reemplazos (coincidencia única, ninguna, varias e inserción) y el aviso que dice dónde caerán, opciones de «ADACEEN: Conectar», aviso para docentes, aviso de sesión perdida, ventana flotante frente a CodeLens y pista en línea (descartada con la X y comentarios ocultos) y el comando heredado en la paleta.

### Compatibilidad

- Sin cambios de contrato con el backend: `apply-check` responde igual y la cola de reemplazos ya devolvía `source`, `requestedAt` y `claimedAt`. Un reemplazo sin `requestedAt` se pregunta (no se puede saber si el clic es reciente). El aviso para docentes usa el campo `reason: staff_requires_code` que el backend ya manda.
- Con el navegador 0.7.12 de la misma rama de PDC: el overlay manda a «Tengo un código o sesión» al copiar el código para VS Code y dice que VS Code aplica el reemplazo elegido en unos segundos. El backend de esa rama, en el aviso que solo muestran tal cual las versiones 0.0.31 y anteriores, nombra «Copiar codigo para VS Code» (el botón del navegador 0.7.12) y conserva «Tengo un codigo del navegador», la opción que esas versiones tienen.
- La VM de editores instala la VSIX que fija el submódulo: se publica con `git add -f adaceen-0.0.32.vsix` (`*.vsix` está en `.gitignore`). Si falta, la VM conserva la 0.0.31, que sigue funcionando con el túnel.

## [0.0.31] - 2026-09-25

Acceso simplificado (contrato `docs/arquitectura/acceso-simplificado.md` de PDC, sección 3): el estudiante ya no copia ni pega la sesión.

### Añadido

- La sesión de ADACEEN se resuelve en este orden (`src/editor-session.ts`): 1) la sesión emparejada en este equipo, guardada en el llavero de VS Code (SecretStorage `adaceen.editorSession`, nunca en settings); 2) `~/.adaceen/editor-session.json`, que escribe la VM de editores al preparar el túnel (cero clics; se relee al arrancar, al volver a la ventana, cuando el archivo cambia y cuando el backend rechaza la sesión; en la extensión web no se lee); 3) el ajuste heredado `adaceen.backend.sessionId` y `ADACEEN_SESSION_ID`. Todas las llamadas (sugerencias, métricas, apply-check, cola del navegador, rack, quiz y el visor de fuentes RAG) usan la sesión resuelta.
- La sesión emparejada solo se usa con el backend donde se obtuvo: no viaja al backend local de la Mac ni a un `adaceen.backend.baseUrl` que traiga un repositorio, y vuelve a valer sola al volver a su backend. En el túnel, un `editor-session.json` escrito después de guardar la sesión emparejada gana (la VM es del estudiante; el llavero de vscode.dev puede ser de un perfil compartido).
- Sin sesión, al arrancar se intenta en silencio la cuenta de GitHub que VS Code ya tiene (`read:user`) y se canjea en `POST /api/auth/editor/github`: cero clics cuando la extensión ya tenía permiso. El token de GitHub no se guarda ni se registra. No se hace si en este equipo se cerró sesión o se desconectó VS Code (marca en `globalState` que quita la siguiente conexión hecha a mano), si `adaceen.backend.baseUrl` lo fija el espacio de trabajo abierto, ni pisa una conexión que termine antes (enlace, código o archivo del túnel).
- Barra de estado «ADACEEN: sin conectar» / «ADACEEN: <nombre>» y comando **ADACEEN: Conectar** con tres opciones: «Con mi cuenta de GitHub (recomendado)» (un clic en «Permitir»), «Tengo un código del navegador» (`XXXX-XXXX`, canje en `POST /api/auth/editor/claim`; también acepta el UUID de antes) y «Pegar sesión».
- Cuando el backend responde `x-adaceen-session: invalid` (por ejemplo, cerraste sesión en el navegador): se olvida esa sesión, se relee el archivo del túnel y, si no queda otra, una sola advertencia por ventana con el botón «Conectar» (en el túnel sugiere volver a «Abrir mi editor»). No se vuelve a conectar en silencio con GitHub: en una Mac compartida esa cuenta puede ser de otro estudiante. Al arrancar, la sesión que hay se comprueba con `GET /api/auth/me` (así también se detectan sesiones muertas en un backend anterior y se muestra el nombre). Una sesión que vence con la ventana abierta se detecta en la revisión de cada 20 s (barra y advertencia). Si el llavero de VS Code tarda más de 3 s, la sesión guardada se aplica cuando conteste y el arranque la espera antes de probar GitHub.
- «ADACEEN: Conectar» ofrece «Desconectar este equipo» cuando hay sesión guardada. Si un enlace del navegador reemplaza la sesión de otra persona, el aviso lo dice («¿No eres tú?») con el botón «Desconectar».
- Enlaces del navegador para VS Code de escritorio (Mac del laboratorio): `vscode://adaceen.adaceen/abrir?code=XXXX-XXXX&repo=owner/repo` y `vscode://adaceen.adaceen/conectar?code=XXXX-XXXX`. El código se canjea contra el backend ya resuelto por la extensión (un parámetro `backend` distinto se ignora). Con `repo`, abre la carpeta recordada si ya se clonó en este equipo o pide la carpeta padre, clona `https://github.com/<owner>/<repo>.git` y la abre; si falta git, lo explica y ofrece el comando de instalación (`xcode-select --install` en la Mac). Nueva activación `onUri`. Los enlaces se atienden de a uno y, si llega otro mientras tanto (doble clic: cada clic pide un código nuevo e invalida el anterior), se atiende el último en vez de descartarlo; los avisos que no bloquean (falta git, carpeta ocupada) ya no retienen los enlaces siguientes.
- 66 pruebas unitarias nuevas (136 en total): archivo de sesión (versión, campos, vencida), códigos y UUID, orden de resolución y reacción a sesiones inválidas con dependencias falsas, carreras entre GitHub en silencio y el enlace, llavero lento, vencimiento con la ventana abierta, «Desconectar», canjes, cola de enlaces, visor RAG y cabecera `x-adaceen-session`.

### Cambiado

- «ADACEEN: Configurar sesión compartida» sigue existiendo: ahora acepta un código `XXXX-XXXX` (lo canjea) o el UUID de antes, y guarda la sesión en el llavero de VS Code en lugar de `adaceen.backend.sessionId`.
- El backend sigue eligiéndose como en la 0.0.30 (`src/backend-url.ts`); la detección del backend local termina antes de leer la sesión guardada.
- El enlace al visor de fuentes RAG ya no lleva `sessionId` en la URL (el visor no la usa y quedaba en el historial del navegador, en los logs de acceso y en la métrica `vscode_rag_source_opened`); también se quita si viene del backend.

### Compatibilidad

- El canje con código o con GitHub y la cabecera `x-adaceen-session` requieren el backend de la rama `claude/serene-heisenberg-0te9s9` de PDC. Con un backend anterior, «Pegar sesión» y el ajuste heredado funcionan como antes, y una sesión muerta se detecta igual por el 401 de `/api/auth/me`.

## [0.0.30] - 2026-09-24

### Cambiado

- Backend por defecto (Mac del laboratorio y VS Code instalado en cualquier equipo): la conexión local de siempre se conserva. Si en el equipo corre un backend de ADACEEN (`npm run dev:local` o el rol local de las Mac del laboratorio), la extensión lo usa en `http://127.0.0.1:3000`, igual que antes. Si no hay backend local, usa producción, así que VS Code instalado en las Mac del laboratorio o en Windows funciona sin configurar nada. Se reconoce el backend local por su `GET /health` (`ok`, `mode` y `database_provider`), para no confundirlo con otra aplicación del estudiante en el puerto 3000. La prueba se hace al activar (máximo 800 ms) y cada 30 s, así que encender o apagar el backend local cambia el destino sin reiniciar VS Code. Un valor escrito en `adaceen.backend.baseUrl` o en `ADACEEN_BACKEND_URL` sigue mandando, y Codespaces sigue en producción (`src/backend-url.ts`). En vscode.dev sin túnel (extensión web) no se prueba el equipo, para que el navegador no pida permiso de red local: va a producción.
- El valor por defecto de `adaceen.backend.baseUrl` pasa a vacío. Quien ya lo tenía escrito, por ejemplo `http://127.0.0.1:3000` o la URL de la VM de editores que fija `nuevo-tunel.sh`, conserva ese valor.

### Añadido

- Telemetría: cada evento lleva `metadata.editorHost` (`local`, `tunnel`, `codespaces` o `remote`) y `metadata.editorUi` (`desktop` o `web`). Así el piloto puede separar VS Code instalado en las Mac del laboratorio de vscode.dev por túnel.
- Indicador de GPU: el tooltip lista los servidores de inferencia con latido reciente (por ejemplo «Mac del laboratorio - M2 x2, Google Cloud - V100») y de dónde salió la URL del backend.
- El canal ADACEEN registra el backend elegido y cada cambio (`[Backend] …`).
- 11 pruebas unitarias nuevas (70 en total).

### Compatibilidad

- `editorHost` y `editorUi` solo se guardan con un backend que los tenga en su lista blanca de metadata (rama `feat/macs-laboratorio` de PDC). Un backend anterior descarta esas claves y guarda el resto del evento.

## [0.0.29] - 2026-09-24

### Añadido

- Fin de los episodios de bloqueo (A3.3 ADACEEN-43, base del KPI P1): nuevo evento `blocking_resolved` cuando desaparece del archivo el error que causó un bloqueo. `durationMs` es el tiempo hasta desbloqueo (desde que apareció el error hasta que desapareció) y la metadata lleva `line`, `blockedForMs` (desde la señal de bloqueo), `resolvedWhileAway` y `errorCount`. Si el error se corrigió mientras el estudiante estaba en otro archivo, el episodio se cierra al volver, pasado el tiempo de estabilidad de los diagnósticos, con `resolvedWhileAway: true` (el tiempo es una cota superior). Si vuelve a un archivo con el error todavía presente, sigue el mismo episodio. Los episodios que no se cierran no emiten nada (en el análisis quedan censurados). Se recuerdan hasta 50 episodios abiertos.
- El canal ADACEEN registra cada desbloqueo (`[Signals] Desbloqueo en …`).
- 5 pruebas unitarias nuevas de episodios (59 en total).

### Compatibilidad

- Requiere un backend que acepte `blocking_resolved` y las claves `blockedForMs` y `resolvedWhileAway` (rama `feat/segunda-tanda-jira` de PDC). Un backend anterior guarda el evento, pero descarta de la metadata las claves que no conoce.

## [0.0.28] - 2026-09-24

### Añadido

- Identidad unificada: todas las llamadas al backend (sugerencias, métricas, apply-check, indicador de GPU, worker y quiz) envían `x-adaceen-client-id` con el id persistente que ya usaba la vista de quiz, además de `x-session-id` cuando hay sesión compartida (`src/client-identity.ts`).
- Telemetría v1.1 (A11.2 ADACEEN-98, A4.2): los eventos se envían también sin sesión e incluyen `schemaVersion: "1.1"`, `seq`, `clientSessionId`, `decisionId` y `latencyMs`; un reintento ante error de red; los eventos casi simultáneos viajan en un solo POST. Nuevo evento `vscode_suggestion_ignored` con el tiempo que la sugerencia estuvo a la vista.
- Señales de error y bloqueo (A6.2 ADACEEN-63): `compile_error_detected` y `blocking_detected` a partir de los diagnósticos del archivo activo. Un bloqueo (mismo error ≥ `adaceen.triggers.blockingSeconds` o 3 veces en 10 minutos) puede pedir una sugerencia con `trigger: "blocking"`.
- `/suggest-tab` (A9.10 ADACEEN-144): la petición envía `trigger`, `visibleError`, `diagnostics` y `clientSessionId`; la respuesta guarda `decision_id`, `policy_applied` y `code_application`. Las respuestas bloqueadas por la política se muestran como mensaje del tutor, sin acciones de aplicar código (`vscode_suggestion_blocked_by_policy`), y se muestra cuántas aplicaciones quedan en el archivo.
- Límite de aplicación de código (A10.8 ADACEEN-145): antes de aplicar cualquier cambio del tutor (ventana flotante, CodeLens, quick fix, panel y reemplazos del navegador) se consulta `POST /api/suggestions/apply-check`; se respeta `allowed`, `requireConfirmation` y, sin red, `adaceen.codeApplication.offlineMaxLines` (`src/code-application-guard.ts`). Evento `code_application_blocked`; `suggestion_completion_applied` lleva `decisionId` y `metadata.linesChanged`.
- Indicador de GPU (A15.4 ADACEEN-125): con backends que informan latidos, la barra muestra "GPU: sin worker activo" cuando ningún worker ha mandado latido reciente.
- Ajustes nuevos: `adaceen.triggers.blockingSeconds`, `adaceen.triggers.suggestOnBlocking`, `adaceen.codeApplication.offlineMaxLines`.
- Pruebas unitarias sin descargar VS Code: `npm run test:unit` (`node:test`).

### Cambiado

- Los botones Insertar / Modificar / Eliminar de la ventana flotante solo aparecen cuando se puede aplicar código.
- El paquete ya no incluye `.devcontainer/`.

## [0.0.27] - 2026-09-24

### Corregido

- "Insertar debajo" sustituía el código en vez de agregarlo: las acciones que llegan por la cola (`insert_after_line`, `delete_selection`) no se reconocían porque el guion bajo impedía separar la palabra. Insertar desde la cola va debajo de la última línea seleccionada y cada aplicación deja una línea `[Apply]` en el canal ADACEEN.

## [Unreleased]

- Initial release
