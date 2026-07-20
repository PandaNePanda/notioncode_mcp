#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IS_DARWIN=false

if [[ "$(uname -s)" == "Darwin" ]]; then
  IS_DARWIN=true
fi

if [[ "${IS_DARWIN}" == "false" && "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root on Linux." >&2
  exit 1
fi

REQUIRED_CMDS=(node npm openssl)
if [[ "${IS_DARWIN}" == "false" ]]; then
  REQUIRED_CMDS+=(getent runuser systemctl)
fi

for command_name in "${REQUIRED_CMDS[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  fi
done

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || { echo "Node.js 20 or newer is required." >&2; exit 1; }

SERVICE_USER="${NOTIONCODE_USER:-${SUDO_USER:-$USER}}"

if [[ "${IS_DARWIN}" == "true" ]]; then
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    USER_HOME=$(eval echo "~${SUDO_USER}")
  else
    USER_HOME="${HOME}"
  fi
else
  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    echo "Linux user does not exist: ${SERVICE_USER}" >&2
    exit 1
  fi
  USER_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
fi

if [[ -z "${USER_HOME}" || ! -d "${USER_HOME}" ]]; then
  echo "Could not resolve a home directory for ${SERVICE_USER}." >&2
  exit 1
fi

CODE_ROOT="${CODE_ROOT:-${USER_HOME}}"
ACCOUNT_HOME="${USER_HOME}/.notionagents"
CODEX_HOME="${USER_HOME}/.codex"
USER_SHARE="${USER_HOME}/.local/share"
NPM_CACHE="${ROOT}/.runtime/npm-cache"

run_as_service_user() {
  if [[ "${IS_DARWIN}" == "true" || "${SERVICE_USER}" == "root" || "${SERVICE_USER}" == "$USER" ]]; then
    HOME="${USER_HOME}" "$@"
  else
    runuser -u "${SERVICE_USER}" -- env HOME="${USER_HOME}" "$@"
  fi
}

mkdir -p \
  "${ROOT}/.runtime" \
  "${ROOT}/.runtime/opencode" \
  "${NPM_CACHE}" \
  "${ACCOUNT_HOME}/accounts" \
  "${CODEX_HOME}" \
  "${USER_SHARE}"

if [[ "${IS_DARWIN}" == "false" && "${EUID}" -eq 0 ]]; then
  chown "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" \
    "${ACCOUNT_HOME}" "${CODEX_HOME}" "${USER_SHARE}" \
    "${ROOT}/.runtime/opencode" "${NPM_CACHE}"
fi
chmod 700 "${ACCOUNT_HOME}" "${ACCOUNT_HOME}/accounts"

if npm --prefix "${ROOT}/bridge" ls --omit=dev --depth=0 >/dev/null 2>&1; then
  echo "[✓] Unified Node bridge dependencies already installed — skipping npm ci."
else
  run_as_service_user npm --prefix "${ROOT}/bridge" ci --omit=dev --cache "${NPM_CACHE}"
fi

if npm --prefix "${ROOT}/notion-private-api-mcp" ls --omit=dev --depth=0 >/dev/null 2>&1; then
  echo "[✓] Notion MCP Node dependencies already installed — skipping npm ci."
else
  run_as_service_user npm --prefix "${ROOT}/notion-private-api-mcp" ci --omit=dev --cache "${NPM_CACHE}"
fi

if npm --prefix "${ROOT}/.runtime/opencode" ls --depth=0 \
  @ai-sdk/openai-compatible @opencode-ai/plugin >/dev/null 2>&1; then
  echo "[✓] OpenCode Node dependencies already installed — skipping npm install."
else
  run_as_service_user npm --prefix "${ROOT}/.runtime/opencode" install \
    --cache "${NPM_CACHE}" \
    @ai-sdk/openai-compatible @opencode-ai/plugin
fi

if [[ ! -f "${ROOT}/runtime/.env" ]]; then
  secret="$(openssl rand -hex 32)"
  install -m 600 /dev/null "${ROOT}/runtime/.env"
  printf 'MCP_PATH_SECRET=%s\nCODE_ROOT=%s\nMCP_PORT=8787\n' \
    "${secret}" "${CODE_ROOT}" > "${ROOT}/runtime/.env"
fi

if [[ "${IS_DARWIN}" == "false" && "${EUID}" -eq 0 ]]; then
  chown "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" "${ROOT}/runtime/.env"
fi
chmod 600 "${ROOT}/runtime/.env"

run_as_service_user node "${ROOT}/scripts/install-model-aliases.mjs" \
  "${ROOT}/state-template/.notionagents/models.json" "${ACCOUNT_HOME}/models.json"
chmod 600 "${ACCOUNT_HOME}/models.json"

run_as_service_user node "${ROOT}/bridge/bin/notion-agent.mjs" migrate "${ACCOUNT_HOME}"

NOTION_MCP_ENABLED=false
if [[ -f "${ACCOUNT_HOME}/notion_account.json" ]] \
  || [[ -n "$(find "${ACCOUNT_HOME}/accounts" -maxdepth 1 -type f -name '*.json' -print -quit 2>/dev/null)" ]]; then
  NOTION_MCP_ENABLED=true
fi

run_as_service_user node "${ROOT}/scripts/render-config.mjs" \
  "${ROOT}/config/opencode.jsonc" "${ROOT}/.runtime/opencode/opencode.jsonc" "${ROOT}" "${USER_HOME}"
run_as_service_user node "${ROOT}/scripts/install-codex-config.mjs" \
  "${ROOT}/config/codex-cli-config.toml" "${CODEX_HOME}/config.toml" "${ROOT}" "${USER_HOME}" \
  "${NOTION_MCP_ENABLED}"

if [[ "${IS_DARWIN}" == "false" && "${EUID}" -eq 0 ]]; then
  node "${ROOT}/scripts/render-config.mjs" \
    "${ROOT}/deploy/systemd/notion-fable-proxy.service" \
    /etc/systemd/system/notion-fable-proxy.service "${ROOT}" "${USER_HOME}" "${SERVICE_USER}"
  systemctl disable --now notion-code-mcp.service 2>/dev/null || true
  rm -f /etc/systemd/system/notion-code-mcp.service
  systemctl daemon-reload
  systemctl enable notion-fable-proxy.service
  systemctl restart notion-fable-proxy.service
else
  echo "[✓] Installation complete on macOS. Run ./bridge/start.sh to start the unified server."
fi

if [[ "${NOTION_MCP_ENABLED}" == "false" ]]; then
  echo
  echo "Notion credentials are not configured yet."
  echo "The notion-private MCP server remains disabled until credentials are configured."
  echo "Run this command, paste token_v2, then press Ctrl-D:"
  printf 'node %q init --token-v2 - --all-workspaces --account-home %q\n' \
    "${ROOT}/bridge/bin/notion-agent.mjs" "${ACCOUNT_HOME}"
  echo "Run notion-agent doctor, then rerun this installer to enable MCP."
fi
