[CmdletBinding()]
param(
    [string]$CodeRoot = $HOME,
    [switch]$NoAutoStart,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

$Root = Get-NotionCodeRoot
$RuntimeDir = Join-Path $Root "runtime"
$VenvDir = Join-Path $Root ".runtime\notion-agent-cli-venv"
$PythonExe = Join-Path $VenvDir "Scripts\python.exe"
$AccountHome = Join-Path $HOME ".notionagents"
$ModelsTemplate = Join-Path $Root "state-template\.notionagents\models.json"
$ModelsPath = Join-Path $AccountHome "models.json"
$RuntimeEnv = Join-Path $RuntimeDir ".env"
$StateDir = Join-Path $Root "state"
$CodexHome = Join-Path $HOME ".codex"
$OpenCodeHome = Join-Path $StateDir "opencode"

Write-Host "Installing notioncode_mcp for Windows from $Root"
Assert-Command "node.exe" "Install Node.js 18 or newer."
Assert-Command "npm.cmd" "Install Node.js 18 or newer."
$Python = Find-Python
Invoke-Python $Python @("-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)")

New-Item -ItemType Directory -Force -Path (Join-Path $Root ".runtime"), (Join-Path $Root ".runtime\logs"), $AccountHome, (Join-Path $AccountHome "accounts"), $CodexHome, $OpenCodeHome | Out-Null

if (-not (Test-Path $PythonExe)) {
    Invoke-Python $Python @("-m", "venv", $VenvDir)
}
& $PythonExe -m pip install --disable-pip-version-check -r (Join-Path $Root "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

& npm.cmd --prefix $RuntimeDir ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "Runtime npm dependency installation failed." }
& npm.cmd --prefix (Join-Path $Root "notion-private-api-mcp") ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "Private Notion MCP npm dependency installation failed." }

& node.exe (Join-Path $Root "scripts\install-model-aliases.mjs") $ModelsTemplate $ModelsPath
if ($LASTEXITCODE -ne 0) { throw "Model alias installation failed." }

& $PythonExe (Join-Path $Root "bridge\migrate_accounts.py") $AccountHome
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
        "PORT=8787"
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
    $escapedStart = (Join-Path $Root "start.ps1").Replace('"', '""')
    @(
        "@echo off"
        "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$escapedStart`""
    ) | Set-Content -LiteralPath $startupCmd -Encoding ASCII
}

if (-not $NoStart) {
    & (Join-Path $Root "stop.ps1")
    & (Join-Path $Root "start.ps1")
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
    Write-Host "& '$VenvDir\Scripts\notion-agent.exe' init --token-v2 - --account '$AccountHome\notion_account.json'"
    Write-Host "Run notion-agent doctor, then rerun .\install.ps1 to enable MCP."
}
