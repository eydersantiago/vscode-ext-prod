#!/usr/bin/env bash
set -euo pipefail

extensions=(
  "adaceen.adaceen"
)

cli=""
if command -v code >/dev/null 2>&1; then
  cli="code"
elif command -v code-server >/dev/null 2>&1; then
  cli="code-server"
fi

if [[ -z "$cli" ]]; then
  echo "[adaceen] No VS Code CLI detected in container. Skipping forced install."
  exit 0
fi

for ext in "${extensions[@]}"; do
  echo "[adaceen] Installing extension: ${ext}"
  "${cli}" --install-extension "${ext}" --force || true
done

echo "[adaceen] Extension install step completed."
