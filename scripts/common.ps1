$ErrorActionPreference = "Stop"

function Get-NotionCodeRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-DotEnv([string]$Path) {
    $values = @{}
    if (Test-Path $Path) {
        foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
                continue
            }
            $parts = $trimmed.Split("=", 2)
            $values[$parts[0].Trim()] = $parts[1].Trim()
        }
    }
    return $values
}

function New-RandomHex([int]$ByteCount = 32) {
    $bytes = New-Object byte[] $ByteCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Assert-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $InstallHint"
    }
}

function Assert-Node20 {
    & node.exe -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'
    if ($LASTEXITCODE -ne 0) {
        throw "Node.js 20 or newer is required."
    }
}

function Test-TcpPort([int]$Port) {
    try {
        $client = [Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(500)) {
            $client.Dispose()
            return $false
        }
        $connected = $client.Connected
        $client.Dispose()
        return $connected
    }
    catch {
        return $false
    }
}

function Wait-TcpPort([int]$Port, [int]$TimeoutSeconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-TcpPort $Port) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Get-ListeningProcessId([int]$Port) {
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        return $null
    }
    try {
        $owners = @(
            Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
        if ($owners.Count -eq 1) {
            return [int]$owners[0]
        }
    }
    catch {
        return $null
    }
    return $null
}

function Wait-HttpOk([string]$Uri, [int]$TimeoutSeconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            return Invoke-RestMethod -Uri $Uri -TimeoutSec 3
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Uri"
}
