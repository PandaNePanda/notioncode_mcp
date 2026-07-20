#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for command_name in python3 node npm openssl getent runuser systemctl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  fi
done
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
  || { echo "Python 3.10 or newer is required." >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || { echo "Node.js 18 or newer is required." >&2; exit 1; }

SERVICE_USER="${NOTIONCODE_USER:-${SUDO_USER:-root}}"
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "Linux user does not exist: ${SERVICE_USER}" >&2
  exit 1
fi
USER_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
if [[ -z "${USER_HOME}" || ! -d "${USER_HOME}" ]]; then
  echo "Could not resolve a home directory for ${SERVICE_USER}." >&2
  exit 1
fi
CODE_ROOT="${CODE_ROOT:-${USER_HOME}}"
ACCOUNT_HOME="${USER_HOME}/.notionagents"
CODEX_HOME="${USER_HOME}/.codex"
USER_SHARE="${USER_HOME}/.local/share"

run_as_service_user() {
  if [[ "${SERVICE_USER}" == "root" ]]; then
    HOME="${USER_HOME}" "$@"
  else
    runuser -u "${SERVICE_USER}" -- env HOME="${USER_HOME}" "$@"
  fi
}

mkdir -p \
  "${ROOT}/.runtime" \
  "${ROOT}/.runtime/opencode" \
  "${ACCOUNT_HOME}/accounts" \
  "${CODEX_HOME}" \
  "${USER_SHARE}"
chown "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" \
  "${ACCOUNT_HOME}" "${CODEX_HOME}" "${USER_SHARE}" "${ROOT}/.runtime/opencode"
chmod 700 "${ACCOUNT_HOME}" "${ACCOUNT_HOME}/accounts"

if [[ ! -x "${ROOT}/.runtime/notion-agent-cli-venv/bin/python" ]]; then
  python3 -m venv "${ROOT}/.runtime/notion-agent-cli-venv"
fi
"${ROOT}/.runtime/notion-agent-cli-venv/bin/pip" install -r "${ROOT}/requirements.txt"

npm --prefix "${ROOT}/runtime" ci --omit=dev
npm --prefix "${ROOT}/notion-private-api-mcp" ci --omit=dev
npm --prefix "${ROOT}/.runtime/opencode" install @ai-sdk/openai-compatible @opencode-ai/plugin

if [[ ! -f "${ROOT}/runtime/.env" ]]; then
  secret="$(openssl rand -hex 32)"
  install -m 600 /dev/null "${ROOT}/runtime/.env"
  printf 'MCP_PATH_SECRET=%s\nCODE_ROOT=%s\nPORT=8787\n' "${secret}" "${CODE_ROOT}" > "${ROOT}/runtime/.env"
fi
chown "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" "${ROOT}/runtime/.env"
chmod 600 "${ROOT}/runtime/.env"

run_as_service_user node "${ROOT}/scripts/install-model-aliases.mjs" \
  "${ROOT}/state-template/.notionagents/models.json" "${ACCOUNT_HOME}/models.json"
chmod 600 "${ACCOUNT_HOME}/models.json"

run_as_service_user env PYTHONPATH="${ROOT}/bridge" \
  "${ROOT}/.runtime/notion-agent-cli-venv/bin/python" \
  "${ROOT}/bridge/migrate_accounts.py" "${ACCOUNT_HOME}"

NOTION_MCP_ENABLED=false
if [[ -f "${ACCOUNT_HOME}/notion_account.json" ]] \
  || [[ -n "$(find "${ACCOUNT_HOME}/accounts" -maxdepth 1 -type f -name '*.json' -print -quit)" ]]; then
  NOTION_MCP_ENABLED=true
fi

run_as_service_user node "${ROOT}/scripts/render-config.mjs" \
  "${ROOT}/config/opencode.jsonc" "${ROOT}/.runtime/opencode/opencode.jsonc" "${ROOT}" "${USER_HOME}"
run_as_service_user node "${ROOT}/scripts/install-codex-config.mjs" \
  "${ROOT}/config/codex-cli-config.toml" "${CODEX_HOME}/config.toml" "${ROOT}" "${USER_HOME}" \
  "${NOTION_MCP_ENABLED}"

ln -sfn "${ROOT}/.runtime/notion-agent-cli-venv" "${USER_SHARE}/notion-agent-cli-venv"
chown -h "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" "${USER_SHARE}/notion-agent-cli-venv"

node "${ROOT}/scripts/render-config.mjs" \
  "${ROOT}/deploy/systemd/notion-code-mcp.service" \
  /etc/systemd/system/notion-code-mcp.service "${ROOT}" "${USER_HOME}" "${SERVICE_USER}"
node "${ROOT}/scripts/render-config.mjs" \
  "${ROOT}/deploy/systemd/notion-fable-proxy.service" \
  /etc/systemd/system/notion-fable-proxy.service "${ROOT}" "${USER_HOME}" "${SERVICE_USER}"
systemctl daemon-reload
systemctl enable notion-code-mcp.service notion-fable-proxy.service
systemctl restart notion-code-mcp.service notion-fable-proxy.service

if [[ "${NOTION_MCP_ENABLED}" == "false" ]]; then
  echo
  echo "Notion credentials are not configured yet."
  echo "The notion-private MCP server remains disabled until credentials are configured."
  echo "Run this command, paste token_v2, then press Ctrl-D:"
  printf 'sudo -u %q -H %q init --token-v2 - --account %q\n' \
    "${SERVICE_USER}" "${ROOT}/.runtime/notion-agent-cli-venv/bin/notion-agent" \
    "${ACCOUNT_HOME}/notion_account.json"
  echo "Run notion-agent doctor, then rerun this installer to enable MCP."
fi
