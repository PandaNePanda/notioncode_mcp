[CmdletBinding()]
param([switch]$SkipLiveChecks)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\common.ps1")

$Root = Get-NotionCodeRoot
$AccountHome = Join-Path $HOME ".notionagents"
$ModelsPath = Join-Path $AccountHome "models.json"
$RuntimeEnv = Join-Path $Root "runtime\.env"
$ExpectedAliases = [ordered]@{
    "fable-5" = "acai-budino-high"
    "gpt-5.6-sol" = "orange-mousse"
}

$required = @(
    "bridge\server.js",
    "bridge\package.json",
    "bridge\package-lock.json",
    "bridge\bin\notion-agent.mjs",
    "bridge\src\http-server.js",
    "bridge\src\mcp-server.js",
    "bridge\src\runtime-tools.js",
    "runtime\.env",
    "notion-private-api-mcp\run-from-account.js",
    "config\codex-models.json",
    ".runtime\opencode\opencode.jsonc"
)

$missing = @($required | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
if ($missing.Count -gt 0) {
    throw "Missing installed files: $($missing -join ', ')"
}

Assert-Command "node.exe" "Install Node.js 20 or newer."
Assert-Command "npm.cmd" "Install Node.js 20 or newer."
Assert-Node20
& npm.cmd --prefix (Join-Path $Root "bridge") ls --omit=dev --depth=0 *> $null
if ($LASTEXITCODE -ne 0) { throw "Unified Node bridge dependencies are missing or invalid." }

if (-not (Test-Path $ModelsPath)) {
    throw "Model alias file is missing: $ModelsPath"
}
$CodexConfig = Join-Path $HOME ".codex\config.toml"
if (-not (Test-Path $CodexConfig)) {
    throw "Codex VS Code configuration is missing: $CodexConfig"
}
$CodexConfigText = Get-Content -LiteralPath $CodexConfig -Raw -Encoding UTF8
if ($CodexConfigText -notmatch 'model_provider\s*=\s*"notion-ai"' -or $CodexConfigText -notmatch '\[model_providers\.notion-ai\]') {
    throw "Codex VS Code is not configured for the Notion provider: $CodexConfig"
}
if ($CodexConfigText -notmatch '(?s)\[mcp_servers\.notion-private\].*?enabled\s*=\s*true') {
    throw "The notion-private MCP server is disabled. Run the Node notion-agent doctor command, then rerun the installer."
}

$models = Get-Content -LiteralPath $ModelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $ExpectedAliases.GetEnumerator()) {
    $actual = $models.friendly_aliases.PSObject.Properties[$entry.Key].Value
    if ($actual -ne $entry.Value) {
        throw "Incorrect model alias for $($entry.Key): expected $($entry.Value), got $actual"
    }
}

$catalog = Get-Content -LiteralPath (Join-Path $Root "config\codex-models.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$slugs = @($catalog.models | ForEach-Object { $_.slug })
if (($slugs -join ",") -ne "gpt-5.5,gpt-5.6-sol") {
    throw "Unexpected Codex model catalog: $($slugs -join ', ')"
}
foreach ($model in $catalog.models) {
    $efforts = @($model.supportedReasoningEfforts | ForEach-Object { $_.reasoningEffort })
    if (($efforts -join ",") -ne "low,medium,high") {
        throw "Unexpected reasoning efforts for $($model.slug): $($efforts -join ', ')"
    }
}

$requestedBridgePort = $env:NOTION_FABLE_PORT
$requestedMcpPort = $env:MCP_PORT
$envValues = Get-DotEnv $RuntimeEnv
$bridgePortValue = $requestedBridgePort
if (-not $bridgePortValue) { $bridgePortValue = $envValues["NOTION_FABLE_PORT"] }
if (-not $bridgePortValue) { $bridgePortValue = "8765" }
$mcpPortValue = $requestedMcpPort
if (-not $mcpPortValue) { $mcpPortValue = $envValues["MCP_PORT"] }
if (-not $mcpPortValue) { $mcpPortValue = $envValues["PORT"] }
if (-not $mcpPortValue) { $mcpPortValue = "8787" }

$bridgePort = 0
$mcpPort = 0
if (-not [int]::TryParse($bridgePortValue, [ref]$bridgePort) -or $bridgePort -lt 1 -or $bridgePort -gt 65535) {
    throw "Invalid bridge port: $bridgePortValue"
}
if (-not [int]::TryParse($mcpPortValue, [ref]$mcpPort) -or $mcpPort -lt 1 -or $mcpPort -gt 65535) {
    throw "Invalid MCP port: $mcpPortValue"
}
if ($bridgePort -eq $mcpPort) { throw "Bridge and MCP ports must be different." }

$unifiedProcessId = $null
if (-not $SkipLiveChecks) {
    if (-not (Test-TcpPort $mcpPort)) { throw "MCP runtime is not listening on 127.0.0.1:$mcpPort" }
    if (-not (Test-TcpPort $bridgePort)) { throw "Notion bridge is not listening on 127.0.0.1:$bridgePort" }

    $bridgeOwner = Get-ListeningProcessId $bridgePort
    $mcpOwner = Get-ListeningProcessId $mcpPort
    if (-not $bridgeOwner -or -not $mcpOwner -or $bridgeOwner -ne $mcpOwner) {
        throw "Bridge and MCP listeners are not owned by one process."
    }
    $unifiedProcessId = $bridgeOwner
    $process = Get-Process -Id $unifiedProcessId -ErrorAction SilentlyContinue
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $unifiedProcessId" -ErrorAction SilentlyContinue
    $commandLine = if ($processInfo) { [string]$processInfo.CommandLine } else { "" }
    if (-not $process -or $process.ProcessName -notlike "node*" -or $commandLine -notmatch 'bridge[\\/]server\.js') {
        throw "The shared listener process is not the unified notioncode Node server."
    }

    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/healthz" -TimeoutSec 10
    if (-not $health.ok) { throw "Bridge health check reports no valid Notion accounts." }
    $remoteModels = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/v1/models" -TimeoutSec 10
    $remoteIds = @($remoteModels.data | ForEach-Object { $_.id })
    if (($remoteIds -join ",") -ne "fable-5,gpt-5.6-sol") {
        throw "Bridge returned unexpected models: $($remoteIds -join ', ')"
    }
}

[pscustomobject]@{
    ok = $true
    project_root = $Root
    model_aliases = $ExpectedAliases
    models = $slugs
    bridge_port = $bridgePort
    mcp_port = $mcpPort
    unified_process_id = $unifiedProcessId
    live_checks = -not $SkipLiveChecks
} | ConvertTo-Json -Depth 10
