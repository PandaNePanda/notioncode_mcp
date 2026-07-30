$ErrorActionPreference = "Stop"

function Enter-NotionCodeStartupLock {
    $mutex = [System.Threading.Mutex]::new($false, "Local\notioncode_mcp_start")
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(60))
    }
    catch [System.Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) {
        $mutex.Dispose()
        throw "Timed out waiting for the NotionCode startup lock."
    }
    return $mutex
}

function Exit-NotionCodeStartupLock {
    param([Parameter(Mandatory = $true)][System.Threading.Mutex]$Mutex)
    try { $Mutex.ReleaseMutex() }
    finally { $Mutex.Dispose() }
}

function Get-VerifiedListenerProcess {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string[]]$CommandLineFragments
    )

    $listeners = @(
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in @("127.0.0.1", "::1") }
    )
    if ($listeners.Count -eq 0) { return $null }

    $ownerIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($ownerIds.Count -ne 1) {
        throw "Port $Port has multiple listener owners: $($ownerIds -join ', ')."
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($ownerIds[0])" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        throw "Port $Port is listening, but its owning process could not be inspected."
    }

    $commandLine = [string]$process.CommandLine
    foreach ($fragment in $CommandLineFragments) {
        if ($commandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "Port $Port is owned by unexpected PID $($process.ProcessId) ($($process.Name)); refusing to reuse or replace it."
        }
    }
    return $process
}

function Wait-VerifiedListenerProcess {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string[]]$CommandLineFragments,
        [int]$TimeoutSeconds = 30
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $process = Get-VerifiedListenerProcess -Port $Port -CommandLineFragments $CommandLineFragments
        if ($null -ne $process) { return $process }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for the verified local listener on port $Port."
}

function Set-VerifiedPidFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$ProcessId
    )
    Set-Content -LiteralPath $Path -Value $ProcessId -Encoding ASCII
}
