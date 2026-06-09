#!/usr/bin/env bash
set -euo pipefail

ADACEEN_EXTENSION="adaceen.adaceen"
ADACEEN_VSIX_CANDIDATES=(
  "${ADACEEN_VSIX_PATH:-}"
  "adaceen.vsix"
  "adaceen-0.0.6.vsix"
  "adaceen-0.0.5.vsix"
  ".devcontainer/adaceen.vsix"
  ".devcontainer/adaceen-0.0.6.vsix"
  ".devcontainer/adaceen-0.0.5.vsix"
)

cli=""
if command -v code >/dev/null 2>&1; then
  cli="code"
elif command -v code-server >/dev/null 2>&1; then
  cli="code-server"
elif command -v code-insiders >/dev/null 2>&1; then
  cli="code-insiders"
fi

if [[ -z "$cli" ]]; then
  echo "[adaceen] No VS Code CLI detected in container. Skipping forced install."
  exit 0
fi

for vsix in "${ADACEEN_VSIX_CANDIDATES[@]}"; do
  if [[ -n "$vsix" && -f "$vsix" ]]; then
    echo "[adaceen] Installing ADACEEN from VSIX: ${vsix}"
    "${cli}" --install-extension "$vsix" --force || true
    echo "[adaceen] Extension install step completed."
    exit 0
  fi
done

latest_vsix="$(
  find . .devcontainer -maxdepth 1 -type f -name 'adaceen-*.vsix' 2>/dev/null \
    | sort -V \
    | tail -n 1
)"
if [[ -n "$latest_vsix" && -f "$latest_vsix" ]]; then
  echo "[adaceen] Installing latest local ADACEEN VSIX: ${latest_vsix}"
  "${cli}" --install-extension "$latest_vsix" --force || true
  echo "[adaceen] Extension install step completed."
  exit 0
fi

echo "[adaceen] Installing latest marketplace extension: ${ADACEEN_EXTENSION}"
"${cli}" --install-extension "${ADACEEN_EXTENSION}" --force || true
echo "[adaceen] Extension install step completed."
