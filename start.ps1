[CmdletBinding()]
param([switch]$Foreground)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")
. (Join-Path $PSScriptRoot "scripts\startup-guard.ps1")

$Root = Get-NotionCodeRoot
$RuntimeEnv = Join-Path $Root "runtime\.env"
$PythonExe = Join-Path $Root ".runtime\notion-agent-cli-venv\Scripts\python.exe"
$NotionAgentExe = Join-Path $Root ".runtime\notion-agent-cli-venv\Scripts\notion-agent.exe"
$NodeServer = Join-Path $Root "runtime\server.js"
$BridgeDir = Join-Path $Root "bridge"
$AccountHome = Join-Path $HOME ".notionagents"
$LogDir = Join-Path $Root ".runtime\logs"
$PidDir = Join-Path $Root ".runtime\pids"

if (-not (Test-Path $RuntimeEnv)) { throw "runtime\.env is missing. Run install.ps1 first." }
if (-not (Test-Path $PythonExe)) { throw "Python virtual environment is missing. Run install.ps1 first." }
if (-not (Test-Path (Join-Path $AccountHome "models.json"))) { throw "$AccountHome\models.json is missing. Run install.ps1 first." }

New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null
$StartupMutex = Enter-NotionCodeStartupLock
try {
$envValues = Get-DotEnv $RuntimeEnv
foreach ($entry in $envValues.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
}
$env:NOTION_AGENT_HOME = $AccountHome
$env:NOTION_RUNTIME_ENV = $RuntimeEnv
$env:PYTHONUNBUFFERED = "1"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

Assert-Command "node.exe" "Install Node.js 18 or newer."
$NodeExe = (Get-Command "node.exe").Source
$DesktopPatchScript = Join-Path $Root "scripts\patch-codex-desktop.mjs"
if (-not (Test-Path $DesktopPatchScript)) {
    throw "scripts\patch-codex-desktop.mjs is missing. Run install.ps1 first."
}

# Reapply the user-owned Codex Desktop patch on every startup so desktop
# updates or restored archives do not silently remove the Fast selector.
& node.exe $DesktopPatchScript
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Codex Desktop Fast compatibility patch failed; local services will still be started. Reapply the Desktop patch after startup."
}

# Keep the local bridge and tool runtime responsive under CPU contention.
# High is deliberate but Realtime is never used because it can starve Windows.
function Set-NotionCodeProcessPriority {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
    try {
        $Process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::High
    } catch {
        Write-Warning "Could not raise process priority for PID $($Process.Id): $($_.Exception.Message)"
    }
}

# Notion ships a new web client version almost every day and rejects versions
# that fall too far behind. Refresh every configured account before startup so
# a valid token is not misdiagnosed as expired after a Notion deployment.
# A refresh check is advisory: a temporary upstream/network failure must not
# turn a usable existing account into a full local-service startup outage.
$accountPaths = @()
$primaryAccount = Join-Path $AccountHome "notion_account.json"
if (Test-Path -LiteralPath $primaryAccount) { $accountPaths += $primaryAccount }
$secondaryDir = Join-Path $AccountHome "accounts"
if (Test-Path -LiteralPath $secondaryDir) {
    $accountPaths += @(Get-ChildItem -LiteralPath $secondaryDir -Filter "*.json" -File | Select-Object -ExpandProperty FullName)
}
$accountPaths = @($accountPaths | Select-Object -Unique)
if ($accountPaths.Count -eq 0) {
    throw "No Notion account files were found in $AccountHome. Configure an account before starting the bridge."
}
$refreshFailures = 0
foreach ($accountPath in $accountPaths) {
    try {
        & $NotionAgentExe doctor --account $accountPath --refresh-client-version --json | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $refreshFailures++
            Write-Warning "Notion client refresh failed for one configured account; retaining its existing session and continuing startup."
        }
    } catch {
        $refreshFailures++
        Write-Warning "Notion client refresh could not be completed for one configured account; retaining its existing session and continuing startup."
    }
}
if ($refreshFailures -gt 0) {
    Write-Warning "$refreshFailures of $($accountPaths.Count) configured account refresh checks failed. The bridge will make the final runtime health decision without disabling credentials."
}

$runtimePortValue = $envValues["PORT"]
if (-not $runtimePortValue) { $runtimePortValue = "8787" }
$runtimePort = [int]$runtimePortValue
$runtimePidFile = Join-Path $PidDir "runtime.pid"
$runtimeFragments = @($NodeServer)
$runtimeOwner = Get-VerifiedListenerProcess -Port $runtimePort -CommandLineFragments $runtimeFragments
if ($null -eq $runtimeOwner) {
    $runtimeOut = Join-Path $LogDir "runtime.out.log"
    $runtimeErr = Join-Path $LogDir "runtime.err.log"
    $runtime = Start-Process -FilePath $NodeExe -ArgumentList @($NodeServer) -WorkingDirectory (Join-Path $Root "runtime") -WindowStyle Hidden -RedirectStandardOutput $runtimeOut -RedirectStandardError $runtimeErr -PassThru
    Set-NotionCodeProcessPriority -Process $runtime
    Set-VerifiedPidFile -Path $runtimePidFile -ProcessId $runtime.Id
} else {
    Set-VerifiedPidFile -Path $runtimePidFile -ProcessId $runtimeOwner.ProcessId
}

$bridgePidFile = Join-Path $PidDir "bridge.pid"
$bridgeFragments = @($PythonExe, "-m uvicorn", "server:app", "--port 8765")
$bridgeOwner = Get-VerifiedListenerProcess -Port 8765 -CommandLineFragments $bridgeFragments
if ($null -eq $bridgeOwner) {
    $bridgeOut = Join-Path $LogDir "bridge.out.log"
    $bridgeErr = Join-Path $LogDir "bridge.err.log"
    $arguments = @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8765")
    if ($Foreground) {
        Push-Location $BridgeDir
        try { & $PythonExe @arguments } finally { Pop-Location }
        exit $LASTEXITCODE
    }
    $bridge = Start-Process -FilePath $PythonExe -ArgumentList $arguments -WorkingDirectory $BridgeDir -WindowStyle Hidden -RedirectStandardOutput $bridgeOut -RedirectStandardError $bridgeErr -PassThru
    Set-NotionCodeProcessPriority -Process $bridge
    Set-VerifiedPidFile -Path $bridgePidFile -ProcessId $bridge.Id
} else {
    Set-VerifiedPidFile -Path $bridgePidFile -ProcessId $bridgeOwner.ProcessId
}

$health = Wait-HttpOk "http://127.0.0.1:8765/healthz" 30
$runtimeOwner = Wait-VerifiedListenerProcess -Port $runtimePort -CommandLineFragments $runtimeFragments -TimeoutSeconds 30
$bridgeOwner = Wait-VerifiedListenerProcess -Port 8765 -CommandLineFragments $bridgeFragments -TimeoutSeconds 30
Set-VerifiedPidFile -Path $runtimePidFile -ProcessId $runtimeOwner.ProcessId
Set-VerifiedPidFile -Path $bridgePidFile -ProcessId $bridgeOwner.ProcessId
$health | ConvertTo-Json -Depth 10
}
finally {
    Exit-NotionCodeStartupLock -Mutex $StartupMutex
}
