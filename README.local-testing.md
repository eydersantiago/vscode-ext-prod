# ADACEEN Local Testing Guide (Codespaces -> local backend)

This guide documents the end-to-end local test flow without moving code between the VS Code extension and browser extension.

## Goal

Run the backend on your local machine, open the repo in Codespaces, and make the Codespaces worker send scanned code to the local backend.

## Prerequisites

1. Backend repo available locally:
`E:\Univalle\15. Noveno Semestre\Caso de estudio\PDC\agente-proxy-azure`
2. VS Code extension installed in Codespaces (`adaceen.adaceen`).
3. Browser extension installed and logged in.

## 1) Start backend locally

In PowerShell:

```powershell
cd "E:\Univalle\15. Noveno Semestre\Caso de estudio\PDC\agente-proxy-azure"
npm run dev
```

Expected log:

```text
Agente (local, db=postgres): http://127.0.0.1:3000
```

## 2) Expose local port 3000 with Cloudflare Tunnel

If `cloudflared` is not available in PATH, use the full executable path:

```powershell
& "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:3000
```

Optional for current terminal session:

```powershell
$env:Path += ";$env:LOCALAPPDATA\Programs\cloudflared"
```

Copy the generated URL, for example:
`https://xxxx.trycloudflare.com`

Keep this terminal open while testing.

## 3) Configure Codespaces worker backend URL

In Codespaces, open `Preferences: Open Remote Settings (JSON)` and add:

```json
{
  "adaceen.backend.baseUrl": "https://xxxx.trycloudflare.com",
  "adaceen.backend.autoWorkerEnabled": true
}
```

If your backend enforces worker auth key, add:

```json
{
  "adaceen.backend.scanWorkerKey": "YOUR_WORKER_KEY"
}
```

Reload Codespaces window after saving settings.

## 4) Optional: persist URL in devcontainer.json (not recommended for shared repos)

If you need this in a branch for temporary tests, add it under `customizations.vscode.settings`:

```json
{
  "name": "ADACEEN Devcontainer",
  "image": "mcr.microsoft.com/devcontainers/universal:2",
  "customizations": {
    "vscode": {
      "extensions": [
        "adaceen.adaceen",
        "ms-python.python",
        "ms-vscode.cpptools",
        "eamodio.gitlens"
      ],
      "settings": {
        "editor.formatOnSave": true,
        "files.trimTrailingWhitespace": true,
        "adaceen.backend.baseUrl": "https://xxxx.trycloudflare.com"
      }
    }
  },
  "extensions": [
    "adaceen.adaceen"
  ],
  "postCreateCommand": "bash .devcontainer/install-extensions.sh || true",
  "postAttachCommand": "bash .devcontainer/install-extensions.sh || true",
  "updateContentCommand": "bash .devcontainer/install-extensions.sh || true"
}
```

## 5) Run the test from dashboard

1. Open dashboard in browser extension.
2. Click `Explorar proyecto`.
3. In Codespaces open `Output` and select channel `ADACEEN`.

Expected worker logs:

```text
[Worker] Inicializado | auto=true | backend=https://xxxx.trycloudflare.com ...
[Worker] Solicitud reclamada: <request-id> (owner/repo).
[Worker] Escaneo enviado al backend: owner/repo (<n> archivos).
[Worker] Sin solicitudes pendientes para owner/repo.
```

## 6) Validate files were stored locally

Backend stores scan payloads under:

`E:\Univalle\15. Noveno Semestre\Caso de estudio\PDC\agente-proxy-azure\data\project-scans\<owner__repo>\`

Example file:

`2026-04-05T20-55-01-119Z-9ade4749-3390-48f0-acf5-248d55dae702.json`

Quick check in PowerShell:

```powershell
$p = "E:\Univalle\15. Noveno Semestre\Caso de estudio\PDC\agente-proxy-azure\data\project-scans\eydersantiago__budget\2026-04-05T20-55-01-119Z-9ade4749-3390-48f0-acf5-248d55dae702.json"
$j = Get-Content -Raw -Path $p | ConvertFrom-Json
"totalFiles=$($j.payload.totalFiles) skippedBySize=$($j.payload.skippedBySize)"
$j.payload.files | Select-Object -First 5 path, bytes, lines
```

## Troubleshooting

1. `TypeError: fetch failed` in Codespaces worker:
   `adaceen.backend.baseUrl` is unreachable from Codespaces. Check tunnel URL and that backend is running locally.
2. `cloudflared` not recognized:
   run with full path:
   `& "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe" ...`
3. `Worker no autorizado` or HTTP 401:
   align `adaceen.backend.scanWorkerKey` in Codespaces with backend env `ADACEEN_SCAN_WORKER_KEY`.
4. Worker starts but never claims requests:
   confirm repo detection and that dashboard requested scan for the same `owner/repo`.

## Safety note

Do not commit temporary tunnel URLs to shared branches. Prefer Remote Settings for local testing.
