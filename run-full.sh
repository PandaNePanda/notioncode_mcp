#!/usr/bin/env bash
set -euo pipefail

# ── Security: suppress history for this session ──────────────────────────────
unset HISTFILE                      # stop bash writing history to disk
export HISTIGNORE="*"              # ignore all commands in memory
export HISTSIZE=0                   # no in-memory history
if [[ -n "${ZSH_VERSION:-}" ]]; then
    unset HISTFILE
    setopt NO_HISTORY_BEEP 2>/dev/null || true
fi

_clear_history() {
    history -c 2>/dev/null || true
}
trap _clear_history EXIT

# The old launcher required sudo and then recursively changed ownership across
# the repository and user configuration. The unified Node runtime needs no
# elevated privileges. If invoked through sudo for backwards compatibility,
# immediately return to the original user before touching npm or account files.
if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    exec sudo -u "${SUDO_USER}" -H "${BASH_SOURCE[0]}" "$@"
fi

USER_HOME="${HOME}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

BRIDGE_PORT="${NOTION_FABLE_PORT:-8765}"
ACCOUNT_HOME="${USER_HOME}/.notionagents"
CODEX_HOME="${USER_HOME}/.codex"
NODE_CLI="${ROOT}/bridge/bin/notion-agent.mjs"
RUNTIME_ENV="${ROOT}/runtime/.env"

# ── Helpers ──────────────────────────────────────────────────────────────────

has_account() {
    if [[ -f "${ACCOUNT_HOME}/notion_account.json" ]]; then return 0; fi
    if FOUND=$(find "${ACCOUNT_HOME}/accounts" -maxdepth 1 -type f -name '*.json' -print -quit 2>/dev/null) && [[ -n "${FOUND}" ]]; then return 0; fi
    return 1
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "[!] Required command not found: $1"
        return 1
    fi
}

ensure_node() {
    require_command node
    require_command npm
    require_command openssl

    local node_major
    node_major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "${node_major}" -lt 20 ]]; then
        echo "[!] Node.js 20 or newer is required; found $(node --version)."
        return 1
    fi

    if ! npm --prefix "${ROOT}/bridge" ls --omit=dev --depth=0 >/dev/null 2>&1; then
        echo ""
        echo "[>] Installing Node dependencies (first run or lockfile changed)..."
        mkdir -p "${TMPDIR:-/tmp}/notioncode-npm-cache"
        npm install --prefix "${ROOT}/bridge" --cache "${TMPDIR:-/tmp}/notioncode-npm-cache"
    else
        echo "[✓] Node dependencies already installed; skipping download."
    fi
}

ensure_runtime_config() {
    if [[ -f "${RUNTIME_ENV}" ]]; then
        return 0
    fi

    echo "[>] Creating local MCP runtime configuration..."
    mkdir -p "${ROOT}/runtime"
    local secret
    secret="$(openssl rand -hex 32)"
    (
        umask 077
        printf 'MCP_PATH_SECRET=%s\nCODE_ROOT=%s\nMCP_PORT=%s\n' \
            "${secret}" "${USER_HOME}" "${MCP_PORT:-8787}" > "${RUNTIME_ENV}"
    )
}

runtime_port() {
    node --input-type=module -e \
        'import { loadRuntimeConfig } from "./bridge/src/runtime-tools.js"; process.stdout.write(String((await loadRuntimeConfig()).port));'
}

port_is_listening() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
        return
    fi
    if command -v nc >/dev/null 2>&1; then
        nc -z 127.0.0.1 "${port}" >/dev/null 2>&1
        return
    fi
    (exec 3<>"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
}

install_codex_config() {
    mkdir -p "${CODEX_HOME}"
    node "${ROOT}/scripts/install-codex-config.mjs" \
        "${ROOT}/config/codex-cli-config.toml" \
        "${CODEX_HOME}/config.toml" \
        "${ROOT}" \
        "${USER_HOME}" \
        false
}

ensure_setup() {
    ensure_node
    ensure_runtime_config
    install_codex_config
}

add_account() {
    ensure_setup
    mkdir -p "${ACCOUNT_HOME}/accounts"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " How to get your token_v2:"
    echo "  1. Open Notion in your browser"
    echo "  2. Press F12 (DevTools) → Application → Cookies"
    echo "  3. Open the notion.so cookie list"
    echo "  4. Find 'token_v2' and copy its value"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -n "Paste your token_v2 here (input is hidden): "
    IFS= read -rs TOKEN
    echo ""

    if [[ -z "${TOKEN}" ]]; then
        echo "[!] No token entered. Aborting."
        return 1
    fi

    echo "[>] Discovering and provisioning every workspace for this credential..."
    local init_output
    if ! init_output=$(printf '%s' "${TOKEN}" | node "${NODE_CLI}" init \
        --token-v2 - \
        --all-workspaces \
        --account-home "${ACCOUNT_HOME}" 2>&1); then
        unset TOKEN
        echo "[!] Account initialization failed:"
        printf '%s\n' "${init_output}"
        return 1
    fi
    unset TOKEN
    printf '%s\n' "${init_output}"

    local created_files=()
    local line
    while IFS= read -r line; do
        [[ -n "${line}" ]] && created_files+=("${line}")
    done < <(printf '%s\n' "${init_output}" | sed -n 's/^\[init\] wrote //p')

    if [[ "${#created_files[@]}" -eq 0 ]]; then
        echo "[✓] Every discovered workspace was already configured."
        return 0
    fi

    echo ""
    echo "[>] Verifying ${#created_files[@]} newly created workspace account(s)..."
    local failed=0
    local account_file
    for account_file in "${created_files[@]}"; do
        echo ""
        echo "  [>] $(basename "${account_file}")"
        if node "${NODE_CLI}" doctor --account "${account_file}" --json; then
            echo "  [✓] Verified: ${account_file}"
        else
            echo "  [!] Verification failed: ${account_file}"
            failed=$((failed + 1))
        fi
    done

    if [[ "${failed}" -ne 0 ]]; then
        echo "[!] ${failed} workspace account(s) failed verification."
        return 1
    fi

    echo ""
    echo "[✓] All newly created workspace accounts were verified."
}

check_accounts() {
    ensure_node

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " Account Status"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local found=0
    local failed=0

    check_one() {
        local file="$1"
        local label="$2"
        if [[ -f "${file}" ]]; then
            echo ""
            echo "  [${label}] ${file}"
            if node "${NODE_CLI}" doctor --account "${file}"; then
                echo "      [✓] Account verified"
            else
                echo "      [!] Doctor check failed"
                failed=$((failed + 1))
            fi
            found=$((found + 1))
        fi
    }

    check_one "${ACCOUNT_HOME}/notion_account.json" "Main"

    for f in "${ACCOUNT_HOME}/accounts"/*.json; do
        [[ -f "${f}" ]] || continue
        check_one "${f}" "$(basename "${f}" .json)"
    done

    echo ""
    if [[ "${found}" -eq 0 ]]; then
        echo "  No accounts configured."
        echo "  Use option 3 to add an account."
    else
        echo "  Total accounts found: ${found}"
        if [[ "${failed}" -ne 0 ]]; then
            echo "  Failed checks: ${failed}"
        fi
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if [[ "${failed}" -ne 0 ]]; then
        return 1
    fi
}

refresh_tokens() {
    ensure_node

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " Refreshing Client Token Version for all Accounts"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local files=()
    if [[ -f "${ACCOUNT_HOME}/notion_account.json" ]]; then
        files+=("${ACCOUNT_HOME}/notion_account.json")
    fi
    for f in "${ACCOUNT_HOME}/accounts"/*.json; do
        [[ -f "${f}" ]] && files+=("${f}")
    done

    if [[ ${#files[@]} -eq 0 ]]; then
        echo "  No accounts found to refresh."
        return 0
    fi

    local failed=0
    for file in "${files[@]}"; do
        echo ""
        echo "[>] Refreshing: $(basename "${file}")"
        if ! node "${NODE_CLI}" doctor --refresh-client-version --account "${file}"; then
            failed=$((failed + 1))
        fi
    done
    echo ""
    if [[ "${failed}" -ne 0 ]]; then
        echo "[!] Token refresh failed for ${failed} account(s)."
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        return 1
    fi
    echo "[✓] Client token refresh sequence complete!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

start_services() {
    ensure_setup
    require_command curl

    # If no account, prompt to add one first
    if ! has_account; then
        echo ""
        echo "[!] No Notion accounts configured."
        echo "    You must add an account before starting."
        echo ""
        echo -n "Would you like to add one now? [Y/n]: "
        read -r CONFIRM
        if [[ "${CONFIRM}" =~ ^[Nn] ]]; then
            echo "Exiting."
            return 0
        fi
        add_account || return 1
    fi

    local RUNTIME_PORT
    RUNTIME_PORT="$(runtime_port)"

    if [[ "${BRIDGE_PORT}" = "${RUNTIME_PORT}" ]]; then
        echo "[!] Bridge and MCP runtime cannot share port ${BRIDGE_PORT}."
        return 1
    fi

    echo ""
    kill_port_owner() {
        local port="$1"
        if command -v lsof >/dev/null 2>&1; then
            local pids
            pids="$(lsof -nP -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u | xargs || true)"
            if [[ -n "${pids}" ]]; then
                echo "[>] Terminating existing process listening on port ${port} (PID ${pids})..."
                kill -9 ${pids} 2>/dev/null || true
            fi
        fi
    }

    kill_port_owner "${BRIDGE_PORT}"
    kill_port_owner "${RUNTIME_PORT}"
    sleep 0.5

    local state_dir="${ROOT}/.runtime"
    local pid_file="${state_dir}/notioncode-node.pid"
    local log_file="${state_dir}/notioncode-node.log"
    mkdir -p "${state_dir}"
    rm -f "${pid_file}"

    echo "[>] Starting the unified Node server..."
    nohup env \
        NOTION_AGENT_HOME="${ACCOUNT_HOME}" \
        NOTION_FABLE_PORT="${BRIDGE_PORT}" \
        MCP_PORT="${RUNTIME_PORT}" \
        NOTION_LOG_FORMAT="${NOTION_LOG_FORMAT:-pretty}" \
        NOTION_COLOR="${NOTION_COLOR:-1}" \
        node "${ROOT}/bridge/server.js" >"${log_file}" 2>&1 &
    local SERVER_PID=$!
    printf '%s\n' "${SERVER_PID}" > "${pid_file}"

    echo "[~] Waiting for both listeners..."
    local bridge_ready=0
    local runtime_ready=0
    local attempt
    for attempt in {1..30}; do
        if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/v1/models" >/dev/null 2>&1; then
            bridge_ready=1
        fi
        if port_is_listening "${RUNTIME_PORT}"; then
            runtime_ready=1
        fi
        if [[ "${bridge_ready}" -eq 1 && "${runtime_ready}" -eq 1 ]]; then
            break
        fi
        if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done

    if [[ "${bridge_ready}" -ne 1 || "${runtime_ready}" -ne 1 ]]; then
        echo "[!] Unified server did not open both listeners. Log: ${log_file}"
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
        rm -f "${pid_file}"
        return 1
    fi

    if command -v lsof >/dev/null 2>&1; then
        local bridge_owner
        local runtime_owner
        bridge_owner="$(lsof -nP -tiTCP:"${BRIDGE_PORT}" -sTCP:LISTEN 2>/dev/null | sort -u | xargs || true)"
        runtime_owner="$(lsof -nP -tiTCP:"${RUNTIME_PORT}" -sTCP:LISTEN 2>/dev/null | sort -u | xargs || true)"
        if [[ "${bridge_owner}" != "${SERVER_PID}" || "${runtime_owner}" != "${SERVER_PID}" ]]; then
            echo "[!] Listener ownership check failed; both ports must belong to PID ${SERVER_PID}."
            kill "${SERVER_PID}" 2>/dev/null || true
            wait "${SERVER_PID}" 2>/dev/null || true
            rm -f "${pid_file}"
            return 1
        fi
    elif ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        echo "[!] Unified server exited during startup. Log: ${log_file}"
        rm -f "${pid_file}"
        return 1
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[✓] Unified Node server is UP (PID ${SERVER_PID})"
    echo "    Bridge:  http://127.0.0.1:${BRIDGE_PORT}"
    echo "    Runtime: http://127.0.0.1:${RUNTIME_PORT}"
    echo "    Log:     ${log_file}"
    echo ""
    echo "To use with Claude Code CLI:"
    echo "  export ANTHROPIC_BASE_URL=http://127.0.0.1:${BRIDGE_PORT}"
    echo "  export ANTHROPIC_API_KEY=sk-notioncode"
    echo "  claude"
    echo ""
    echo "Streaming live logs (Press Ctrl+C to stop viewing logs; server will stay running):"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    tail -n 25 -f "${log_file}"
}

# ── Main Menu ────────────────────────────────────────────────────────────────

clear
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║      NotionCode MCP — Launcher           ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

ACCOUNT_STATUS="❌ No accounts configured"
if has_account; then
    COUNT=0
    [[ -f "${ACCOUNT_HOME}/notion_account.json" ]] && COUNT=$((COUNT+1))
    EXTRA=$(find "${ACCOUNT_HOME}/accounts" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    COUNT=$((COUNT + EXTRA))
    ACCOUNT_STATUS="✅ ${COUNT} account(s) configured"
fi

echo "  Status: ${ACCOUNT_STATUS}"
echo ""
echo "  1)  🚀  Start unified Node server"
echo "  2)  🔍  Check accounts"
echo "  3)  ➕  Add a new account"
echo "  4)  🔄  Refresh account live tokens"
echo "  5)  ❌  Exit"
echo ""
echo -n "  Select an option [1-5]: "
read -r CHOICE

case "${CHOICE}" in
    1) start_services ;;
    2) check_accounts ;;
    3) add_account ;;
    4) refresh_tokens ;;
    5)
        _clear_history
        exit 0
        ;;
    *) echo "[!] Invalid option." ; exit 1 ;;
esac

# Always clear history on normal exit
_clear_history
