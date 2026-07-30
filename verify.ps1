[CmdletBinding()]
param([switch]$SkipLiveChecks)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

$Root = Get-NotionCodeRoot
$AccountHome = Join-Path $HOME ".notionagents"
$ModelsPath = Join-Path $AccountHome "models.json"
$CodexModelsPath = Join-Path $AccountHome "codex-models.json"
$ExpectedAliases = [ordered]@{
    "fable-5" = "acai-budino-high"
    "gpt-5.6-sol" = "orange-mousse"
    "opus-5" = "agave-flan"
}
$ExpectedEfforts = [ordered]@{
    "gpt-5.5" = "low,medium,high,xhigh"
    "gpt-5.6-sol" = "low,medium,high,xhigh,max,ultra"
    "opus-5" = "low,medium,high"
}

$required = @(
    "bridge\server.py",
    "bridge\account_pool.py",
    "bridge\notion_images.py",
    "runtime\server.js",
    "runtime\.env",
    ".runtime\notion-agent-cli-venv\Scripts\python.exe",
    "notion-private-api-mcp\run-from-account.js",
    "notion-private-api-mcp\run-external-inference.js",
    "notion-private-api-mcp\src\external-inference-client.js",
    "notion-private-api-mcp\src\external-inference-server.js",
    "config\codex-models.json",
    "state\opencode\opencode.jsonc",
    "scripts\patch-codex-desktop.mjs",
    "start.ps1"
)

$missing = @($required | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
if ($missing.Count -gt 0) {
    throw "Missing installed files: $($missing -join ', ')"
}
if (-not (Test-Path $ModelsPath)) {
    throw "Model alias file is missing: $ModelsPath"
}
if (-not (Test-Path $CodexModelsPath)) {
    throw "Dynamic Codex model catalog is missing: $CodexModelsPath"
}
$CodexConfig = Join-Path $HOME ".codex\config.toml"
if (-not (Test-Path $CodexConfig)) {
    throw "Codex VS Code configuration is missing: $CodexConfig"
}
$CodexConfigText = Get-Content -LiteralPath $CodexConfig -Raw -Encoding UTF8
function Get-TomlAssignmentValues {
    param(
        [string]$Text,
        [AllowEmptyString()][string]$Table,
        [string]$Key
    )
    $currentTable = ""
    $escapedKey = [regex]::Escape($Key)
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
            $currentTable = $Matches[1].Trim()
            continue
        }
        if ($currentTable -eq $Table -and $line -match ("^\s*{0}\s*=\s*([^#]*?)\s*(?:#.*)?$" -f $escapedKey)) {
            $Matches[1].Trim()
        }
    }
}

$rootServiceTier = @(Get-TomlAssignmentValues -Text $CodexConfigText -Table "" -Key "service_tier")
if ($rootServiceTier.Count -ne 1 -or $rootServiceTier[0] -ne '"priority"') {
    throw "Codex root config must contain exactly one service_tier = `"priority`" assignment."
}
$canonicalEfforts = '["low","medium","high","xhigh","max","ultra"]'
foreach ($table in @("", "desktop")) {
    $tableLabel = if ($table) { "[$table]" } else { "root" }
    $ultraValues = @(Get-TomlAssignmentValues -Text $CodexConfigText -Table $table -Key "show-ultra-in-model-picker-slider")
    if ($ultraValues.Count -ne 1 -or $ultraValues[0] -ne "true") {
        throw "Codex $tableLabel config must contain exactly one show-ultra-in-model-picker-slider = true assignment."
    }
    $effortValues = @(Get-TomlAssignmentValues -Text $CodexConfigText -Table $table -Key "enabled-reasoning-efforts")
    $normalizedEfforts = if ($effortValues.Count -eq 1) { $effortValues[0] -replace '\s', '' } else { "" }
    if ($effortValues.Count -ne 1 -or $normalizedEfforts -ne $canonicalEfforts) {
        throw "Codex $tableLabel config must contain exactly one canonical six-effort list in low, medium, high, xhigh, max, ultra order."
    }
}
if ($CodexConfigText -notmatch 'model_provider\s*=\s*"notion-ai"' -or $CodexConfigText -notmatch '\[model_providers\.notion-ai\]') {
    throw "Codex VS Code is not configured for the Notion provider: $CodexConfig"
}
if ($CodexConfigText -notmatch 'model_catalog_json\s*=\s*"[^\r\n]*[\\/]\.notionagents[\\/]codex-models\.json"') {
    throw "Codex is not configured to use the dynamic Notion model catalog: $CodexConfig"
}
if ($CodexConfigText -notmatch '(?s)\[mcp_servers\.notion-private\].*?enabled\s*=\s*true') {
    throw "The notion-private MCP server is disabled. Run notion-agent doctor, then rerun the installer."
}
if ($CodexConfigText -notmatch '\[mcp_servers\.external-inference\]') {
    throw "The optional external-inference MCP definition is missing. Rerun the installer."
}
if ($CodexConfigText -notmatch '(?s)\[mcp_servers\.external-inference\].*?enabled\s*=\s*true') {
    throw "The external-inference MCP server is disabled. Rerun the installer."
}
if ($CodexConfigText -match '(?m)^\s*(OPENROUTER_API_KEY|VIVGRID_API_KEY|CEREBRAS_API_KEY)\s*=') {
    throw "An external provider API key was serialized into Codex config. Remove it and use configure-external-provider.ps1."
}
$StartScript = Join-Path $Root "start.ps1"
$StartScriptText = Get-Content -LiteralPath $StartScript -Raw -Encoding UTF8
if ($StartScriptText -notmatch 'patch-codex-desktop\.mjs') {
    throw "Startup no longer reapplies the Codex Desktop Fast compatibility patch."
}

$models = Get-Content -LiteralPath $ModelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $ExpectedAliases.GetEnumerator()) {
    $actual = $models.friendly_aliases.PSObject.Properties[$entry.Key].Value
    if ($actual -ne $entry.Value) {
        throw "Incorrect model alias for $($entry.Key): expected $($entry.Value), got $actual"
    }
}

$baseCatalog = Get-Content -LiteralPath (Join-Path $Root "config\codex-models.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$baseSlugs = @($baseCatalog.models | ForEach-Object { $_.slug })
if (($baseSlugs -join ",") -ne "gpt-5.5,gpt-5.6-sol,opus-5") {
    throw "Unexpected base Codex model catalog: $($baseSlugs -join ', ')"
}
foreach ($model in $baseCatalog.models) {
    $efforts = @($model.supportedReasoningEfforts | ForEach-Object { $_.reasoningEffort })
    $expectedEffortList = $ExpectedEfforts[$model.slug]
    if (-not $expectedEffortList -or ($efforts -join ",") -ne $expectedEffortList) {
        throw "Unexpected reasoning efforts for $($model.slug): $($efforts -join ', ')"
    }
}
$fastModels = @($baseCatalog.models | Where-Object { $_.slug -in @("gpt-5.5", "gpt-5.6-sol") })
foreach ($model in $fastModels) {
    if (@($model.additional_speed_tiers) -notcontains "fast") {
        throw "Fast speed tier is missing for $($model.slug)"
    }
    if (@($model.service_tiers | ForEach-Object { $_.id }) -notcontains "priority") {
        throw "Priority service tier is missing for $($model.slug)"
    }
}

$catalog = Get-Content -LiteralPath $CodexModelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$slugs = @($catalog.models | ForEach-Object { $_.slug })
foreach ($requiredSlug in @("gpt-5.5", "gpt-5.6-sol", "opus-5")) {
    if ($slugs -notcontains $requiredSlug) {
        throw "Dynamic Codex model catalog is missing base model $requiredSlug"
    }
}
$expectedGpt56Efforts = "low,medium,high,xhigh,max,ultra"
foreach ($requiredSlug in @("gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra")) {
    $model = @($catalog.models | Where-Object { $_.slug -eq $requiredSlug })
    if ($model.Count -ne 1) {
        throw "Dynamic Codex model catalog must contain exactly one $requiredSlug entry."
    }
    $efforts = @($model[0].supportedReasoningEfforts | ForEach-Object { $_.reasoningEffort })
    if (($efforts -join ",") -ne $expectedGpt56Efforts) {
        throw "Dynamic $requiredSlug reasoning efforts are incomplete or out of order: $($efforts -join ', ')"
    }
    if (@($model[0].additional_speed_tiers) -notcontains "fast") {
        throw "Dynamic $requiredSlug metadata is missing the Fast speed tier."
    }
    if (@($model[0].service_tiers | ForEach-Object { $_.id }) -notcontains "priority") {
        throw "Dynamic $requiredSlug metadata is missing the priority service tier."
    }
}

if (-not $SkipLiveChecks) {
    if (-not (Test-TcpPort 8787)) { throw "MCP runtime is not listening on 127.0.0.1:8787" }
    if (-not (Test-TcpPort 8765)) { throw "Notion bridge is not listening on 127.0.0.1:8765" }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/healthz" -TimeoutSec 10
    if (-not $health.ok) { throw "Bridge health check reports no valid Notion accounts." }
    if ($health.model_refresh.state -ne "ok") {
        throw "Dynamic Notion model refresh is not healthy: $($health.model_refresh.state)"
    }
    $remoteModels = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/models" -TimeoutSec 10
    $remoteIds = @($remoteModels.data | ForEach-Object { $_.id })
    foreach ($requiredId in @("gpt-5.5", "gpt-5.6-sol", "opus-5")) {
        if ($remoteIds -notcontains $requiredId) {
            throw "Bridge model list is missing base model $requiredId"
        }
    }
    foreach ($requiredId in @("gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra")) {
        $remoteModel = @($remoteModels.data | Where-Object { $_.id -eq $requiredId })
        if ($remoteModel.Count -ne 1) {
            throw "Bridge model list must contain exactly one $requiredId entry."
        }
        $remoteEfforts = @($remoteModel[0].supportedReasoningEfforts | ForEach-Object { $_.reasoningEffort })
        if (($remoteEfforts -join ",") -ne $expectedGpt56Efforts) {
            throw "Live $requiredId reasoning efforts are incomplete or out of order: $($remoteEfforts -join ', ')"
        }
        if (@($remoteModel[0].additional_speed_tiers) -notcontains "fast") {
            throw "Live $requiredId metadata is missing the Fast speed tier."
        }
        if (@($remoteModel[0].service_tiers | ForEach-Object { $_.id }) -notcontains "priority") {
            throw "Live $requiredId metadata is missing the priority service tier."
        }
    }
}

[pscustomobject]@{
    ok = $true
    project_root = $Root
    model_aliases = $ExpectedAliases
    models = $slugs
    live_checks = -not $SkipLiveChecks
} | ConvertTo-Json -Depth 10
