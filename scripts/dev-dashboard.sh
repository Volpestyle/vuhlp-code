#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTD_BIN="$ROOT_DIR/bin/agentd"
API_HOST="${AGENTD_HOST:-127.0.0.1}"
API_PORT="${AGENTD_PORT:-8787}"
UI_HOST="${UI_HOST:-127.0.0.1}"
UI_PORT="${UI_PORT:-5173}"
DEV_WATCH="${DEV_WATCH:-1}"
AI_KIT_ROOT="${AI_KIT_ROOT:-$ROOT_DIR/../ai-kit}"

if command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"
else
  PM="npm"
fi

watch_list() {
  if command -v rg >/dev/null 2>&1; then
    rg --files -g '*.go' "$ROOT_DIR/cmd" "$ROOT_DIR/internal"
    if [[ -d "$AI_KIT_ROOT" ]]; then
      rg --files -g '*.go' "$AI_KIT_ROOT/packages/go"
    fi
  else
    find "$ROOT_DIR/cmd" "$ROOT_DIR/internal" -type f -name '*.go'
    if [[ -d "$AI_KIT_ROOT" ]]; then
      find "$AI_KIT_ROOT/packages/go" -type f -name '*.go'
    fi
  fi
  echo "$ROOT_DIR/go.mod"
  echo "$ROOT_DIR/go.sum"
}

if [[ "$DEV_WATCH" == "1" ]]; then
  if command -v entr >/dev/null 2>&1; then
    export ROOT_DIR AGENTD_BIN API_HOST API_PORT
    watch_list | entr -r bash -c 'cd "$ROOT_DIR" && make build && exec "$AGENTD_BIN" --listen "${API_HOST}:${API_PORT}"' &
    AGENTD_PID=$!
  else
    echo "DEV_WATCH=1 but entr not found; starting without rebuild-on-change."
    (cd "$ROOT_DIR" && make build)
    "$AGENTD_BIN" --listen "${API_HOST}:${API_PORT}" &
    AGENTD_PID=$!
  fi
else
  (cd "$ROOT_DIR" && make build)
  "$AGENTD_BIN" --listen "${API_HOST}:${API_PORT}" &
  AGENTD_PID=$!
fi

cleanup() {
  kill "$AGENTD_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "agentd listening on ${API_HOST}:${API_PORT}"
echo "starting UI on ${UI_HOST}:${UI_PORT}"

"$PM" --prefix "$ROOT_DIR/ui" run dev -- --host "$UI_HOST" --port "$UI_PORT"
