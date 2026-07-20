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
    # Wipe the last line written to the real history files
    for histfile in "${HOME}/.bash_history" "${HOME}/.zsh_history"; do
        if [[ -f "${histfile}" ]]; then
            # Remove any line that references this script
            local tmp; tmp=$(mktemp)
            grep -v 'run-full\.sh\|token_v2\|notion-agent' "${histfile}" > "${tmp}" 2>/dev/null || true
            mv "${tmp}" "${histfile}" 2>/dev/null || rm -f "${tmp}"
        fi
    done
}
trap _clear_history EXIT

if [[ "${EUID}" -ne 0 ]]; then
    echo ""
    echo "  [!] Error: This script must be run with sudo."
    echo "      Please run: sudo ./run-full.sh"
    echo ""
    exit 1
fi

SERVICE_USER="${SUDO_USER:-root}"
if [[ "${SERVICE_USER}" == "root" ]]; then
    USER_HOME="${HOME}"
else
    # Resolve the home directory of the sudo user on macOS
    USER_HOME=$(eval echo "~${SERVICE_USER}")
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

BRIDGE_PORT="${NOTION_FABLE_PORT:-8765}"
RUNTIME_PORT="8787"
ACCOUNT_HOME="${USER_HOME}/.notionagents"
CODEX_HOME="${USER_HOME}/.codex"
VENV="${ROOT}/.runtime/notion-agent-cli-venv/bin"

# ── Auto-fix file permissions on startup ─────────────────────────────────────
if [[ "${SERVICE_USER}" != "root" ]]; then
    chown -R "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" "${ACCOUNT_HOME}" "${CODEX_HOME}" "${ROOT}" 2>/dev/null || true
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

has_account() {
    if [[ -f "${ACCOUNT_HOME}/notion_account.json" ]]; then return 0; fi
    if FOUND=$(find "${ACCOUNT_HOME}/accounts" -maxdepth 1 -type f -name '*.json' -print -quit 2>/dev/null) && [[ -n "${FOUND}" ]]; then return 0; fi
    return 1
}

ensure_venv() {
    if [[ ! -x "${VENV}/python" ]]; then
        echo ""
        echo "[>] First-time setup: running installer..."
        ./scripts/install-local.sh
    fi
    if [[ ! -f "${ROOT}/runtime/.env" ]]; then
        secret="$(openssl rand -hex 32)"
        install -m 600 /dev/null "${ROOT}/runtime/.env"
        printf 'MCP_PATH_SECRET=%s\nCODE_ROOT=%s\nPORT=%s\n' "${secret}" "${USER_HOME}" "${RUNTIME_PORT}" > "${ROOT}/runtime/.env"
        if [[ "${SERVICE_USER}" != "root" ]]; then
            chown "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" "${ROOT}/runtime/.env" 2>/dev/null || true
        fi
    fi
}

add_account() {
    mkdir -p "${ACCOUNT_HOME}/accounts"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " How to get your token_v2:"
    echo "  1. Open Notion in your browser"
    echo "  2. Press F12 (DevTools) → Application → Cookies"
    echo "  3. Click on https://www.notion.so"
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

    local account_file="${ACCOUNT_HOME}/notion_account.json"
    if [[ -f "${account_file}" ]]; then
        local idx=2
        while [[ -f "${ACCOUNT_HOME}/accounts/account-$(printf '%02d' ${idx}).json" ]]; do
            ((idx++))
        done
        account_file="${ACCOUNT_HOME}/accounts/account-$(printf '%02d' ${idx}).json"
        echo "[>] Main account exists. Saving as: ${account_file}"
    fi

    # ── Try init, detect multiple-workspace error ──────────────────────────
    echo "[>] Detecting workspaces..."
    INIT_OUTPUT=$(printf '%s' "${TOKEN}" | "${VENV}/notion-agent" init --token-v2 - --account "${account_file}" 2>&1 || true)

    if echo "${INIT_OUTPUT}" | grep -q "Multiple workspaces available"; then
        echo ""
        echo "  Multiple Notion workspaces found for this token:"
        echo ""

        # Parse workspace names — bash 3.2 compatible (no mapfile)
        WS_NAMES=()
        while IFS= read -r line; do
            name=$(echo "${line}" | sed "s/.*name='\([^']*\)'.*/\1/")
            [[ -n "${name}" ]] && WS_NAMES+=("${name}")
        done < <(echo "${INIT_OUTPUT}" | grep "name=")

        if [[ ${#WS_NAMES[@]} -eq 0 ]]; then
            echo "[!] Could not parse workspace list. Raw output:"
            echo "${INIT_OUTPUT}"
            return 1
        fi

        echo "  [>] Auto-initializing all ${#WS_NAMES[@]} workspace(s)..."
        local _first=true
        local _slot
        for name in "${WS_NAMES[@]}"; do
            local _ws_file
            if [[ "${_first}" == "true" ]]; then
                _ws_file="${account_file}"
                _first=false
            else
                _slot=2
                while [[ -f "${ACCOUNT_HOME}/accounts/account-$(printf '%02d' ${_slot}).json" ]]; do
                    ((_slot++))
                done
                _ws_file="${ACCOUNT_HOME}/accounts/account-$(printf '%02d' ${_slot}).json"
            fi
            echo ""
            echo "  [>] Initializing workspace: '${name}' -> $(basename "${_ws_file}")..."
            printf '%s' "${TOKEN}" | "${VENV}/notion-agent" init --token-v2 - \
                --space-name "${name}" \
                --account "${_ws_file}"
            if "${VENV}/notion-agent" doctor --account "${_ws_file}" --json >/dev/null 2>&1; then
                echo "  [✓] Verified and saved: ${_ws_file}"
                if [[ "${SERVICE_USER}" != "root" ]]; then
                    chown "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" "${_ws_file}" 2>/dev/null || true
                fi
            else
                echo "  [!] Verify failed for workspace '${name}'. Removing."
                rm -f "${_ws_file}"
            fi
        done
        echo ""
        echo "[✓] All workspaces initialized."
        echo ""
        echo "[>] Re-running installer to register configuration with Codex..."
        ./scripts/install-local.sh
        return 0

    elif echo "${INIT_OUTPUT}" | grep -qi "error\|fail\|exception"; then
        echo "[!] Init failed:"
        echo "${INIT_OUTPUT}"
        return 1
    else
        echo "${INIT_OUTPUT}"
    fi

    # ── Verify the account ─────────────────────────────────────────────────
    echo ""
    echo "[>] Verifying account..."
    if "${VENV}/notion-agent" doctor --account "${account_file}" --json; then
        echo ""
        echo "[✓] Account added and verified successfully!"
        echo "    File: ${account_file}"
        if [[ "${SERVICE_USER}" != "root" ]]; then
            chown -R "${SERVICE_USER}:$(id -gn "${SERVICE_USER}")" "${ACCOUNT_HOME}" 2>/dev/null || true
        fi
        echo ""
        echo "[>] Re-running installer to register configuration with Codex..."
        ./scripts/install-local.sh
    else
        echo "[!] Doctor check failed. The token may be invalid or expired."
        rm -f "${account_file}"
        return 1
    fi
}

check_accounts() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " Account Status"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    local found=0

    check_one() {
        local file="$1"
        local label="$2"
        if [[ -f "${file}" ]]; then
            echo ""
            echo "  [${label}] ${file}"
            "${VENV}/notion-agent" doctor --account "${file}" --json 2>&1 | \
                python3 -c "
import sys, json, re
try:
    checks = json.load(sys.stdin)
    failed = [c for c in checks if c.get('status') == 'fail']
    status = '✗ FAILED' if failed else '✓ OK'
    
    user_info = '?'
    space_info = '?'
    for c in checks:
        if c.get('check') == 'required fields present':
            detail = c.get('detail', '')
            user_match = re.search(r'user=(\S+)', detail)
            space_match = re.search(r\"space='([^']+)'\", detail)
            if user_match: user_info = user_match.group(1)
            if space_match: space_info = space_match.group(1)
            
    print(f'      Status   : {status}')
    print(f'      Workspace: {space_info}')
    print(f'      User     : {user_info}')
    if failed:
        for f in failed:
            print(f'        - {f.get(\"check\")}: {f.get(\"detail\")}')
except Exception as e:
    print(f'      Could not parse: {e}')
" 2>/dev/null || echo "      [!] Doctor check failed"
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
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

refresh_tokens() {
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

    for file in "${files[@]}"; do
        echo ""
        echo "[>] Refreshing: $(basename "${file}")"
        "${VENV}/notion-agent" doctor --refresh-client-version --account "${file}"
    done
    echo ""
    echo "[✓] Token refresh sequence complete!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

start_services() {
    ensure_venv

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
            exit 0
        fi
        add_account || exit 1
        ./scripts/install-local.sh
    fi

    # Ensure Codex configuration is installed
    if ! grep -q "notioncode_mcp" "${CODEX_HOME}/config.toml" 2>/dev/null; then
        echo "[>] Registering configuration with Codex..."
        ./scripts/install-local.sh
    fi

    echo ""
    echo "[>] Starting services in separate Terminal tabs..."

    osascript <<EOF
tell application "Terminal"
    tell application "System Events" to keystroke "t" using command down
    delay 0.4
    do script "cd '${ROOT}/runtime' && echo '=== MCP Runtime (port ${RUNTIME_PORT}) ===' && set -a && source ./.env && set +a && node server.js" in front window
end tell
EOF

    sleep 0.5

    osascript <<EOF
tell application "Terminal"
    tell application "System Events" to keystroke "t" using command down
    delay 0.4
    do script "cd '${ROOT}/bridge' && echo '=== Notion Bridge (port ${BRIDGE_PORT}) ===' && PYTHONPATH='${ROOT}/bridge' '${VENV}/python' -m uvicorn server:app --host 127.0.0.1 --port ${BRIDGE_PORT}" in front window
end tell
EOF

    echo "[~] Waiting for services to start..."
    sleep 5

    echo ""
    if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/healthz" 2>/dev/null; then
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "[✓] All services are UP!"
        echo "    Bridge:  http://127.0.0.1:${BRIDGE_PORT}"
        echo "    Runtime: http://127.0.0.1:${RUNTIME_PORT}"
        echo ""
        echo "To use with Claude Code CLI:"
        echo "  export ANTHROPIC_BASE_URL=http://127.0.0.1:${BRIDGE_PORT}"
        echo "  export ANTHROPIC_API_KEY=sk-notioncode"
        echo "  claude"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    else
        echo "[!] Health check failed — check the Terminal tabs for error output."
    fi
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
echo "  1)  🚀  Start services (Bridge + Runtime)"
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
    3)
        ensure_venv
        add_account
        ;;
    4) refresh_tokens ;;
    5)
        _clear_history
        exit 0
        ;;
    *) echo "[!] Invalid option." ; exit 1 ;;
esac

# Always clear history on normal exit
_clear_history
