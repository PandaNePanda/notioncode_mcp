$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\common.ps1")

$Root = Get-NotionCodeRoot
$PidDir = Join-Path $Root ".runtime\pids"
$PidFile = Join-Path $PidDir "notioncode-node.pid"

if (Test-Path $PidFile) {
    $processId = 0
    $rawPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if (-not [int]::TryParse($rawPid, [ref]$processId) -or $processId -le 0) {
        Write-Warning "Removing invalid unified server PID file."
        Remove-Item -LiteralPath $PidFile -Force
    }
    else {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process) {
            Write-Host "Removing stale unified server PID file."
            Remove-Item -LiteralPath $PidFile -Force
        }
        else {
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
            $commandLine = if ($processInfo) { [string]$processInfo.CommandLine } else { "" }
            $isUnifiedNode = $process.ProcessName -like "node*" -and $commandLine -match 'bridge[\\/]server\.js'
            if (-not $isUnifiedNode) {
                Write-Warning "PID $processId does not identify the unified notioncode Node server; it will not be stopped."
                Remove-Item -LiteralPath $PidFile -Force
            }
            else {
                Stop-Process -Id $processId
                if (-not $process.WaitForExit(10000)) {
                    Stop-Process -Id $processId -Force
                }
                Remove-Item -LiteralPath $PidFile -Force
                Write-Host "Stopped unified Node server (PID $processId)."
            }
        }
    }
}
else {
    Write-Host "Unified Node server PID file is not present."
}

foreach ($legacyName in @("bridge.pid", "runtime.pid")) {
    $legacyPath = Join-Path $PidDir $legacyName
    if (Test-Path $legacyPath) {
        Remove-Item -LiteralPath $legacyPath -Force
        Write-Host "Removed stale legacy PID file: $legacyName"
    }
}
