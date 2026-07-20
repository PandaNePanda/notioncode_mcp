#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_PORT="${NOTION_FABLE_PORT:-8765}"
ACCOUNT_HOME="${NOTION_AGENT_HOME:-${HOME}/.notionagents}"
RUNTIME_DIR="${PROJECT_ROOT}/.runtime"
PID_FILE="${RUNTIME_DIR}/notioncode-node.pid"
LOG_FILE="${RUNTIME_DIR}/notioncode-node.log"

for command_name in node npm curl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  fi
done

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || { echo "Node.js 20 or newer is required." >&2; exit 1; }

if ! npm --prefix "${PROJECT_ROOT}/bridge" ls --omit=dev --depth=0 >/dev/null 2>&1; then
  echo "Bridge dependencies are missing. Run ./scripts/install-local.sh first." >&2
  exit 1
fi

MCP_PORT="$(
  cd "${PROJECT_ROOT}"
  node --input-type=module -e \
    'import { loadRuntimeConfig } from "./bridge/src/runtime-tools.js"; process.stdout.write(String((await loadRuntimeConfig()).port));'
)"

if [[ "${BRIDGE_PORT}" == "${MCP_PORT}" ]]; then
  echo "Bridge and MCP ports must be different." >&2
  exit 1
fi

port_in_use() {
  node -e '
    const net = require("node:net");
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); process.exit(0); });
    socket.once("timeout", () => { socket.destroy(); process.exit(1); });
    socket.once("error", () => process.exit(1));
  ' "$1"
}

if port_in_use "${BRIDGE_PORT}"; then
  echo "Refusing to start: 127.0.0.1:${BRIDGE_PORT} is already occupied." >&2
  exit 1
fi
if port_in_use "${MCP_PORT}"; then
  echo "Refusing to start: 127.0.0.1:${MCP_PORT} is already occupied." >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"
cd "${PROJECT_ROOT}"
nohup env \
  NOTION_AGENT_HOME="${ACCOUNT_HOME}" \
  NOTION_FABLE_PORT="${BRIDGE_PORT}" \
  MCP_PORT="${MCP_PORT}" \
  node "${PROJECT_ROOT}/bridge/server.js" >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
printf '%s\n' "${SERVER_PID}" >"${PID_FILE}"

cleanup_failed_start() {
  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
  rm -f "${PID_FILE}"
}

ready=false
for _ in {1..30}; do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    break
  fi
  if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/v1/models" >/dev/null 2>&1 \
    && port_in_use "${MCP_PORT}"; then
    ready=true
    break
  fi
  sleep 0.5
done

if [[ "${ready}" != "true" ]]; then
  echo "Unified Node server failed to become ready. See ${LOG_FILE}." >&2
  cleanup_failed_start
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  BRIDGE_PID="$(lsof -nP -tiTCP:"${BRIDGE_PORT}" -sTCP:LISTEN | head -n 1 || true)"
  MCP_PID="$(lsof -nP -tiTCP:"${MCP_PORT}" -sTCP:LISTEN | head -n 1 || true)"
  if [[ "${BRIDGE_PID}" != "${SERVER_PID}" || "${MCP_PID}" != "${SERVER_PID}" ]]; then
    echo "Unified PID verification failed. See ${LOG_FILE}." >&2
    cleanup_failed_start
    exit 1
  fi
fi

echo "Unified Node server started (PID ${SERVER_PID})."
echo "Bridge API: http://127.0.0.1:${BRIDGE_PORT}"
echo "MCP runtime: 127.0.0.1:${MCP_PORT}"
