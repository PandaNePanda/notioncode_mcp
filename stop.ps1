$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

$Root = Get-NotionCodeRoot
$PidDir = Join-Path $Root ".runtime\pids"

$targetPorts = @(8765, 8787)
$stopTargets = @{}

foreach ($name in @("bridge", "runtime")) {
    $pidFile = Join-Path $PidDir "$name.pid"
    if (-not (Test-Path $pidFile)) { continue }
    $processId = [int](Get-Content -LiteralPath $pidFile -Raw)
    if (-not $stopTargets.ContainsKey($processId)) {
        $stopTargets[$processId] = "$name pid file"
    }
}

try {
    $listeners = Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -in $targetPorts } |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $listeners) {
        if ($processId -gt 0 -and -not $stopTargets.ContainsKey($processId)) {
            $stopTargets[$processId] = "port listener"
        }
    }
} catch {
    Write-Warning "Could not inspect listening ports: $($_.Exception.Message)"
}

foreach ($entry in $stopTargets.GetEnumerator()) {
    $processId = [int]$entry.Key
    $source = [string]$entry.Value
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Write-Host "Stopped PID $processId from $source."
    } catch {
        Write-Warning ("Stop-Process failed for PID {0} from {1}: {2}" -f $processId, $source, $_.Exception.Message)
        try {
            & taskkill.exe /PID $processId /T /F | Out-Null
            Start-Sleep -Milliseconds 300
            if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                Write-Host "Stopped PID $processId from $source via taskkill."
            } else {
                Write-Warning ("PID {0} from {1} is still running after taskkill." -f $processId, $source)
                $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
                if ($cimProcess) {
                    try {
                        Invoke-CimMethod -InputObject $cimProcess -MethodName Terminate -ErrorAction Stop | Out-Null
                        Start-Sleep -Milliseconds 300
                        if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                            Write-Host "Stopped PID $processId from $source via CIM terminate."
                        } else {
                            Write-Warning ("PID {0} from {1} is still running after CIM terminate." -f $processId, $source)
                        }
                    } catch {
                        Write-Warning ("CIM terminate also failed for PID {0} from {1}: {2}" -f $processId, $source, $_.Exception.Message)
                    }
                }
            }
        } catch {
            Write-Warning ("taskkill also failed for PID {0} from {1}: {2}" -f $processId, $source, $_.Exception.Message)
        }
    }
}

Get-ChildItem -LiteralPath $PidDir -Filter '*.pid' -File -ErrorAction SilentlyContinue |
    ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }

if ($stopTargets.Count -eq 0) {
    Write-Host "No bridge/runtime processes found."
}
