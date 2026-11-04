#!/usr/bin/env bash
set -euo pipefail

export OPEN_SCIENCE_CONFIG_ROOT="${OPEN_SCIENCE_CONFIG_ROOT:-/data/open-science}"
export DATA_DIR="${DATA_DIR:-/data}"
export UPSTREAM_URL="${UPSTREAM_URL:-http://127.0.0.1:44100}"
export GATEWAY_PORT="${GATEWAY_PORT:-8080}"

mkdir -p "$OPEN_SCIENCE_CONFIG_ROOT" "$DATA_DIR/auth" "$HOME/.local/bin"

# Start the Open-Science backend on loopback; the auth gateway is the only public surface.
# --credential-store=file is required on Linux headless (no OS keyring in the container).
node /opt/open-science/out/backend/index.cjs --serve=44100 --credential-store=file &
BACKEND_PID=$!

node /opt/auth-gateway/server.mjs &
GATEWAY_PID=$!

shutdown() {
  kill "$BACKEND_PID" "$GATEWAY_PID" 2>/dev/null || true
}
trap shutdown TERM INT

wait -n "$BACKEND_PID" "$GATEWAY_PID"
STATUS=$?
shutdown
wait "$BACKEND_PID" "$GATEWAY_PID" 2>/dev/null || true
exit "$STATUS"
