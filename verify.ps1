[CmdletBinding()]
param([switch]$SkipLiveChecks)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

$Root = Get-NotionCodeRoot
$AccountHome = Join-Path $HOME ".notionagents"
$ModelsPath = Join-Path $AccountHome "models.json"
$ExpectedAliases = [ordered]@{
    "fable-5" = "acai-budino-high"
    "gpt-5.6-sol" = "orange-mousse"
}

$required = @(
    "bridge\server.py",
    "bridge\account_pool.py",
    "bridge\notion_images.py",
    "runtime\server.js",
    "runtime\.env",
    ".runtime\notion-agent-cli-venv\Scripts\python.exe",
    "notion-private-api-mcp\run-from-account.js",
    "config\codex-models.json",
    "state\opencode\opencode.jsonc"
)

$missing = @($required | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
if ($missing.Count -gt 0) {
    throw "Missing installed files: $($missing -join ', ')"
}
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
    throw "The notion-private MCP server is disabled. Run notion-agent doctor, then rerun the installer."
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

if (-not $SkipLiveChecks) {
    if (-not (Test-TcpPort 8787)) { throw "MCP runtime is not listening on 127.0.0.1:8787" }
    if (-not (Test-TcpPort 8765)) { throw "Notion bridge is not listening on 127.0.0.1:8765" }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/healthz" -TimeoutSec 10
    if (-not $health.ok) { throw "Bridge health check reports no valid Notion accounts." }
    $remoteModels = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/models" -TimeoutSec 10
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
    live_checks = -not $SkipLiveChecks
} | ConvertTo-Json -Depth 10
