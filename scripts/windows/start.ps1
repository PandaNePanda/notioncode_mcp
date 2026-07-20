[CmdletBinding()]
param([switch]$Foreground)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\common.ps1")

$Root = Get-NotionCodeRoot
$RuntimeEnv = Join-Path $Root "runtime\.env"
$NodeServer = Join-Path $Root "bridge\server.js"
$BridgeDir = Join-Path $Root "bridge"
$AccountHome = Join-Path $HOME ".notionagents"
$LogDir = Join-Path $Root ".runtime\logs"
$PidDir = Join-Path $Root ".runtime\pids"
$PidFile = Join-Path $PidDir "notioncode-node.pid"
$OutLog = Join-Path $LogDir "notioncode-node.out.log"
$ErrLog = Join-Path $LogDir "notioncode-node.err.log"

Assert-Command "node.exe" "Install Node.js 20 or newer."
Assert-Command "npm.cmd" "Install Node.js 20 or newer."
Assert-Node20

if (-not (Test-Path $RuntimeEnv)) { throw "runtime\.env is missing. Run run-full.ps1 first." }
if (-not (Test-Path $NodeServer)) { throw "bridge\server.js is missing." }
if (-not (Test-Path (Join-Path $AccountHome "models.json"))) { throw "$AccountHome\models.json is missing. Run run-full.ps1 first." }

& npm.cmd --prefix $BridgeDir ls --omit=dev --depth=0 *> $null
if ($LASTEXITCODE -ne 0) { throw "Unified Node bridge dependencies are missing. Run run-full.ps1 first." }

New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null

$requestedBridgePort = $env:NOTION_FABLE_PORT
$requestedMcpPort = $env:MCP_PORT
$envValues = Get-DotEnv $RuntimeEnv
foreach ($entry in $envValues.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
}

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

$env:NOTION_AGENT_HOME = $AccountHome
$env:NOTION_RUNTIME_ENV = $RuntimeEnv
$env:NOTION_FABLE_PORT = [string]$bridgePort
$env:MCP_PORT = [string]$mcpPort
if ([string]::IsNullOrWhiteSpace($env:NOTION_LOG_FORMAT)) {
    $env:NOTION_LOG_FORMAT = "pretty"
}
if ([string]::IsNullOrWhiteSpace($env:NOTION_COLOR)) {
    $env:NOTION_COLOR = "1"
}

if (Test-Path $PidFile) {
    $recordedId = 0
    [void][int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$recordedId)
    if ($recordedId -gt 0 -and (Get-Process -Id $recordedId -ErrorAction SilentlyContinue)) {
        throw "The unified server PID file points to an active process ($recordedId). Use run-full.ps1 -Action Stop first."
    }
    Remove-Item -LiteralPath $PidFile -Force
}

if (Test-TcpPort $bridgePort) { throw "Refusing to start: 127.0.0.1:$bridgePort is already occupied." }
if (Test-TcpPort $mcpPort) { throw "Refusing to start: 127.0.0.1:$mcpPort is already occupied." }

if ($Foreground) {
    Push-Location $Root
    try {
        & node.exe $NodeServer
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

$server = Start-Process -FilePath "node.exe" -ArgumentList @("`"$NodeServer`"") -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
Set-Content -LiteralPath $PidFile -Value $server.Id -Encoding ASCII

$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
    if ($server.HasExited) { break }
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/v1/models" -TimeoutSec 2 | Out-Null
        if (Test-TcpPort $mcpPort) {
            $ready = $true
            break
        }
    }
    catch {
    }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $ready) {
    if (-not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    throw "Unified Node server failed to become ready. See $ErrLog."
}

$bridgeOwner = Get-ListeningProcessId $bridgePort
$mcpOwner = Get-ListeningProcessId $mcpPort
if ($bridgeOwner -ne $server.Id -or $mcpOwner -ne $server.Id) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    throw "Unified PID verification failed. See $ErrLog."
}

Write-Host "Unified Node server started (PID $($server.Id))."
Write-Host "Bridge API: http://127.0.0.1:$bridgePort"
Write-Host "MCP runtime: 127.0.0.1:$mcpPort"
