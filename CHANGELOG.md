# Change Log

All notable changes to the "adaceen" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
