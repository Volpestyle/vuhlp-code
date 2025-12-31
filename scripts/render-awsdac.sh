#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAGRAM_DIR="${ROOT_DIR}/docs/diagrams"

if ! command -v awsdac >/dev/null 2>&1; then
  echo "[render-awsdac] awsdac not found."
  echo "  Install: https://github.com/awslabs/diagram-as-code (or your preferred runner)"
  echo "  This script will skip AWS diagram rendering."
  exit 0
fi

shopt -s nullglob
FILES=("${DIAGRAM_DIR}"/*.dac)
if [ ${#FILES[@]} -eq 0 ]; then
  echo "[render-awsdac] No .dac files found in ${DIAGRAM_DIR}"
  exit 0
fi

for f in "${FILES[@]}"; do
  out="${f%.dac}.png"
  echo "[render-awsdac] ${f} -> ${out}"
  awsdac --input "${f}" --output "${out}" --format png || {
    echo "[render-awsdac] WARNING: failed to render ${f}"
  }
done
