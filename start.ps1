[CmdletBinding()]
param([switch]$Foreground)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

$Root = Get-NotionCodeRoot
$RuntimeEnv = Join-Path $Root "runtime\.env"
$PythonExe = Join-Path $Root ".runtime\notion-agent-cli-venv\Scripts\python.exe"
$NodeServer = Join-Path $Root "runtime\server.js"
$BridgeDir = Join-Path $Root "bridge"
$AccountHome = Join-Path $HOME ".notionagents"
$LogDir = Join-Path $Root ".runtime\logs"
$PidDir = Join-Path $Root ".runtime\pids"

if (-not (Test-Path $RuntimeEnv)) { throw "runtime\.env is missing. Run install.ps1 first." }
if (-not (Test-Path $PythonExe)) { throw "Python virtual environment is missing. Run install.ps1 first." }
if (-not (Test-Path (Join-Path $AccountHome "models.json"))) { throw "$AccountHome\models.json is missing. Run install.ps1 first." }

New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null
$envValues = Get-DotEnv $RuntimeEnv
foreach ($entry in $envValues.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
}
$env:NOTION_AGENT_HOME = $AccountHome
$env:NOTION_RUNTIME_ENV = $RuntimeEnv
$env:PYTHONUNBUFFERED = "1"

$runtimePortValue = $envValues["PORT"]
if (-not $runtimePortValue) { $runtimePortValue = "8787" }
$runtimePort = [int]$runtimePortValue
if (-not (Test-TcpPort $runtimePort)) {
    $runtimeOut = Join-Path $LogDir "runtime.out.log"
    $runtimeErr = Join-Path $LogDir "runtime.err.log"
    $runtime = Start-Process -FilePath "node.exe" -ArgumentList @($NodeServer) -WorkingDirectory (Join-Path $Root "runtime") -WindowStyle Hidden -RedirectStandardOutput $runtimeOut -RedirectStandardError $runtimeErr -PassThru
    Set-Content -LiteralPath (Join-Path $PidDir "runtime.pid") -Value $runtime.Id -Encoding ASCII
}

if (-not (Test-TcpPort 8765)) {
    $bridgeOut = Join-Path $LogDir "bridge.out.log"
    $bridgeErr = Join-Path $LogDir "bridge.err.log"
    $arguments = @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8765")
    if ($Foreground) {
        Push-Location $BridgeDir
        try { & $PythonExe @arguments } finally { Pop-Location }
        exit $LASTEXITCODE
    }
    $bridge = Start-Process -FilePath $PythonExe -ArgumentList $arguments -WorkingDirectory $BridgeDir -WindowStyle Hidden -RedirectStandardOutput $bridgeOut -RedirectStandardError $bridgeErr -PassThru
    Set-Content -LiteralPath (Join-Path $PidDir "bridge.pid") -Value $bridge.Id -Encoding ASCII
}

$health = Wait-HttpOk "http://127.0.0.1:8765/healthz" 30
$health | ConvertTo-Json -Depth 10
