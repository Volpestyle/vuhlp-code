#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAGRAM_DIR="${ROOT_DIR}/docs/diagrams"

if ! command -v mmdc >/dev/null 2>&1; then
  if command -v npx >/dev/null 2>&1; then
    echo "[render-mermaid] mmdc not found; using npx @mermaid-js/mermaid-cli"
    MMDC=(npx -y @mermaid-js/mermaid-cli)
  else
    echo "[render-mermaid] ERROR: Mermaid CLI not found."
    echo "  Install one of:"
    echo "    - npm i -g @mermaid-js/mermaid-cli"
    echo "    - or install Node.js so we can use npx"
    exit 0
  fi
else
  MMDC=(mmdc)
fi

shopt -s nullglob
FILES=("${DIAGRAM_DIR}"/*.mmd)
if [ ${#FILES[@]} -eq 0 ]; then
  echo "[render-mermaid] No .mmd files found in ${DIAGRAM_DIR}"
  exit 0
fi

SCALE="${MERMAID_SCALE:-4}"

for f in "${FILES[@]}"; do
  out="${f%.mmd}.png"
  echo "[render-mermaid] ${f} -> ${out} (scale=${SCALE})"
  "${MMDC[@]}" -i "${f}" -o "${out}" --backgroundColor transparent --scale "${SCALE}"
done
