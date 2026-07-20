[CmdletBinding()]
param(
    [string]$CodeRoot = $HOME,
    [switch]$NoAutoStart,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\common.ps1")

$Root = Get-NotionCodeRoot
$RuntimeDir = Join-Path $Root "runtime"
$RuntimeStateDir = Join-Path $Root ".runtime"
$BridgeDir = Join-Path $Root "bridge"
$PrivateMcpDir = Join-Path $Root "notion-private-api-mcp"
$NodeCli = Join-Path $BridgeDir "bin\notion-agent.mjs"
$NpmCache = Join-Path $RuntimeStateDir "npm-cache"
$AccountHome = Join-Path $HOME ".notionagents"
$ModelsTemplate = Join-Path $Root "state-template\.notionagents\models.json"
$ModelsPath = Join-Path $AccountHome "models.json"
$RuntimeEnv = Join-Path $RuntimeDir ".env"
$CodexHome = Join-Path $HOME ".codex"
$OpenCodeHome = Join-Path $RuntimeStateDir "opencode"

Write-Host "Installing notioncode_mcp for Windows from $Root"
Assert-Command "node.exe" "Install Node.js 20 or newer."
Assert-Command "npm.cmd" "Install Node.js 20 or newer."
Assert-Node20

New-Item -ItemType Directory -Force -Path $RuntimeStateDir, (Join-Path $RuntimeStateDir "logs"), (Join-Path $RuntimeStateDir "pids"), $NpmCache, $AccountHome, (Join-Path $AccountHome "accounts"), $CodexHome, $OpenCodeHome | Out-Null

& npm.cmd --prefix $BridgeDir ls --omit=dev --depth=0 *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Unified Node bridge dependencies already installed; skipping npm ci."
}
else {
    & npm.cmd --prefix $BridgeDir ci --omit=dev --cache $NpmCache
    if ($LASTEXITCODE -ne 0) { throw "Unified Node bridge dependency installation failed." }
}

& npm.cmd --prefix $PrivateMcpDir ls --omit=dev --depth=0 *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Notion private MCP dependencies already installed; skipping npm ci."
}
else {
    & npm.cmd --prefix $PrivateMcpDir ci --omit=dev --cache $NpmCache
    if ($LASTEXITCODE -ne 0) { throw "Private Notion MCP dependency installation failed." }
}

& npm.cmd --prefix $OpenCodeHome ls --depth=0 "@ai-sdk/openai-compatible" "@opencode-ai/plugin" *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "OpenCode dependencies already installed; skipping npm install."
}
else {
    & npm.cmd --prefix $OpenCodeHome install --cache $NpmCache "@ai-sdk/openai-compatible" "@opencode-ai/plugin"
    if ($LASTEXITCODE -ne 0) { throw "OpenCode dependency installation failed." }
}

& node.exe (Join-Path $Root "scripts\install-model-aliases.mjs") $ModelsTemplate $ModelsPath
if ($LASTEXITCODE -ne 0) { throw "Model alias installation failed." }

& node.exe $NodeCli migrate $AccountHome
if ($LASTEXITCODE -ne 0) { throw "Notion account migration failed." }

$HasNotionAccount = Test-Path (Join-Path $AccountHome "notion_account.json")
if (-not $HasNotionAccount) {
    $HasNotionAccount = @(Get-ChildItem -LiteralPath (Join-Path $AccountHome "accounts") -Filter "*.json" -File -ErrorAction SilentlyContinue).Count -gt 0
}
$NotionMcpEnabled = if ($HasNotionAccount) { "true" } else { "false" }

if (-not (Test-Path $RuntimeEnv)) {
    $secret = New-RandomHex 32
    $runtimeEnvContent = @(
        "MCP_PATH_SECRET=$secret"
        "CODE_ROOT=$([IO.Path]::GetFullPath($CodeRoot))"
        "MCP_PORT=8787"
    ) -join [Environment]::NewLine
    Write-Utf8NoBom $RuntimeEnv ($runtimeEnvContent + [Environment]::NewLine)
}

& node.exe (Join-Path $Root "scripts\install-codex-config.mjs") (Join-Path $Root "config\codex-cli-config.toml") (Join-Path $CodexHome "config.toml") $Root $HOME $NotionMcpEnabled
if ($LASTEXITCODE -ne 0) { throw "Codex configuration generation failed." }
& node.exe (Join-Path $Root "scripts\render-config.mjs") (Join-Path $Root "config\opencode.jsonc") (Join-Path $OpenCodeHome "opencode.jsonc") $Root $HOME
if ($LASTEXITCODE -ne 0) { throw "OpenCode configuration generation failed." }

$envFile = Join-Path $Root ".runtime\windows-paths.env"
$pathsContent = @(
    "NOTIONCODE_ROOT=$Root"
    "NOTION_AGENT_HOME=$AccountHome"
    "OPENCODE_CONFIG_DIR=$OpenCodeHome"
) -join [Environment]::NewLine
Write-Utf8NoBom $envFile ($pathsContent + [Environment]::NewLine)

$startupDir = [Environment]::GetFolderPath("Startup")
$startupCmd = Join-Path $startupDir "notioncode-mcp.cmd"
if (-not $NoAutoStart) {
    $escapedStart = (Join-Path $Root "run-full.ps1").Replace('"', '""')
    @(
        "@echo off"
        "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$escapedStart`" -Action Start"
    ) | Set-Content -LiteralPath $startupCmd -Encoding ASCII
}

if (-not $NoStart) {
    & (Join-Path $PSScriptRoot "stop.ps1")
    & (Join-Path $PSScriptRoot "start.ps1")
}

Write-Host "Installation completed."
Write-Host "Notion account directory: $AccountHome"
Write-Host "Model aliases: $ModelsPath"
Write-Host "Codex VS Code configuration: $(Join-Path $CodexHome 'config.toml')"
Write-Host "OpenCode profile: $OpenCodeHome"
Write-Host "Health endpoint: http://127.0.0.1:8765/healthz"
if (-not $HasNotionAccount) {
    Write-Warning "Notion credentials are not configured yet."
    Write-Warning "The notion-private MCP server remains disabled until credentials are configured."
    Write-Host "Run the command below, paste token_v2, then press Ctrl+Z and Enter:"
    Write-Host "& node.exe '$NodeCli' init --token-v2 - --all-workspaces --account-home '$AccountHome'"
    Write-Host "Run the Node notion-agent doctor command for each account, then rerun .\run-full.ps1 to enable MCP."
}
