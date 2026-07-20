[CmdletBinding()]
param(
    [ValidateSet("Menu", "Start", "Stop", "Status", "CheckAccounts", "AddAccount", "RefreshClientVersion", "Install", "Verify", "OpenCode")]
    [string]$Action = "Menu",
    [string]$CodeRoot = $HOME,
    [switch]$NoAutoStart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

$Root = Get-NotionCodeRoot
$WindowsScripts = Join-Path $Root "scripts\windows"
$InstallScript = Join-Path $WindowsScripts "install.ps1"
$StartScript = Join-Path $WindowsScripts "start.ps1"
$StopScript = Join-Path $WindowsScripts "stop.ps1"
$StatusScript = Join-Path $WindowsScripts "status.ps1"
$VerifyScript = Join-Path $WindowsScripts "verify.ps1"
$BridgeDir = Join-Path $Root "bridge"
$NodeCli = Join-Path $BridgeDir "bin\notion-agent.mjs"
$AccountHome = Join-Path $HOME ".notionagents"

function Get-AccountFiles {
    $files = @()
    $main = Join-Path $AccountHome "notion_account.json"
    if (Test-Path $main) {
        $files += Get-Item -LiteralPath $main
    }
    $additional = Join-Path $AccountHome "accounts"
    if (Test-Path $additional) {
        $files += @(Get-ChildItem -LiteralPath $additional -Filter "*.json" -File | Sort-Object Name)
    }
    return @($files)
}

function Assert-LauncherReady {
    Assert-Command "node.exe" "Install Node.js 20 or newer."
    Assert-Command "npm.cmd" "Install Node.js 20 or newer."
    Assert-Node20
    if (-not (Test-Path $NodeCli)) {
        throw "Node notion-agent CLI is missing: $NodeCli"
    }
}

function Invoke-Install {
    param([switch]$StartAfterInstall)

    $arguments = @{
        CodeRoot = $CodeRoot
    }
    if ($NoAutoStart) {
        $arguments.NoAutoStart = $true
    }
    if (-not $StartAfterInstall) {
        $arguments.NoStart = $true
    }
    & $InstallScript @arguments
}

function Invoke-CheckAccounts {
    Assert-LauncherReady
    $files = @(Get-AccountFiles)

    Write-Host ""
    Write-Host "======================================================"
    Write-Host " Account Status"
    Write-Host "======================================================"

    if ($files.Count -eq 0) {
        Write-Host "  No accounts configured."
        Write-Host "  Use AddAccount to add one."
        return
    }

    $failed = 0
    foreach ($file in $files) {
        Write-Host ""
        Write-Host "  [>] $($file.FullName)"
        # Normal doctor deliberately skips the slow live-client-version request.
        & node.exe $NodeCli doctor --account $file.FullName
        if ($LASTEXITCODE -eq 0) {
            Write-Host "      [OK] Account verified" -ForegroundColor Green
        }
        else {
            Write-Host "      [!] Doctor check failed" -ForegroundColor Red
            $failed += 1
        }
    }

    Write-Host ""
    Write-Host "  Total accounts found: $($files.Count)"
    if ($failed -gt 0) {
        throw "$failed account check(s) failed."
    }
}

function Invoke-AddAccount {
    Invoke-Install
    New-Item -ItemType Directory -Force -Path $AccountHome, (Join-Path $AccountHome "accounts") | Out-Null

    Write-Host ""
    Write-Host "======================================================"
    Write-Host " How to get token_v2"
    Write-Host "  1. Open Notion in your browser"
    Write-Host "  2. Open DevTools -> Application -> Cookies"
    Write-Host "  3. Open the notion.so cookie list"
    Write-Host "  4. Copy the token_v2 value"
    Write-Host "======================================================"
    Write-Host ""

    $secureToken = Read-Host "Paste token_v2 (input is hidden)" -AsSecureString
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try {
        $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
        if ([string]::IsNullOrWhiteSpace($token)) {
            throw "No token was entered."
        }
        $output = @(
            $token | & node.exe $NodeCli init --token-v2 - --all-workspaces --account-home $AccountHome 2>&1
        )
        $exitCode = $LASTEXITCODE
    }
    finally {
        if ($tokenPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
        }
        $token = $null
        $secureToken = $null
    }

    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) {
        throw "Account initialization failed."
    }

    $createdFiles = @(
        $output | ForEach-Object {
            $line = [string]$_
            if ($line -match '^\[init\] wrote (.+)$') {
                $Matches[1]
            }
        }
    )

    if ($createdFiles.Count -eq 0) {
        Write-Host "Every discovered workspace was already configured." -ForegroundColor Green
        return
    }

    $failed = 0
    foreach ($file in $createdFiles) {
        Write-Host ""
        Write-Host "[>] Verifying $file"
        & node.exe $NodeCli doctor --account $file --json
        if ($LASTEXITCODE -ne 0) {
            $failed += 1
        }
    }
    if ($failed -gt 0) {
        throw "$failed newly created account(s) failed verification."
    }

    # Re-render Codex configuration only after the new accounts pass doctor.
    Invoke-Install
    Write-Host "All newly created accounts were verified." -ForegroundColor Green
}

function Invoke-RefreshClientVersion {
    Assert-LauncherReady
    $files = @(Get-AccountFiles)
    if ($files.Count -eq 0) {
        Write-Host "No accounts found to refresh."
        return
    }

    $failed = 0
    foreach ($file in $files) {
        Write-Host ""
        Write-Host "[>] Refreshing client version: $($file.Name)"
        & node.exe $NodeCli doctor --refresh-client-version --account $file.FullName
        if ($LASTEXITCODE -ne 0) {
            $failed += 1
        }
    }
    if ($failed -gt 0) {
        throw "Client-version refresh failed for $failed account(s)."
    }
    Write-Host "Client-version refresh completed." -ForegroundColor Green
}

function Invoke-Start {
    if (@(Get-AccountFiles).Count -eq 0) {
        $answer = Read-Host "No Notion accounts are configured. Add one now? [Y/n]"
        if ($answer -match '^[Nn]') {
            return
        }
        Invoke-AddAccount
    }
    Invoke-Install -StartAfterInstall
}

function Invoke-OpenCode {
    Assert-Command "opencode" "Install OpenCode and retry."
    $env:OPENCODE_CONFIG_DIR = Join-Path $Root ".runtime\opencode"
    & opencode
}

function Show-Menu {
    Clear-Host
    $accountCount = @(Get-AccountFiles).Count
    Write-Host ""
    Write-Host "  +------------------------------------------+"
    Write-Host "  |      NotionCode MCP - Windows Launcher   |"
    Write-Host "  +------------------------------------------+"
    Write-Host ""
    if ($accountCount -gt 0) {
        Write-Host "  Status: $accountCount account(s) configured" -ForegroundColor Green
    }
    else {
        Write-Host "  Status: No accounts configured" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "  1) Start unified Node server"
    Write-Host "  2) Check accounts (fast)"
    Write-Host "  3) Add a new account"
    Write-Host "  4) Refresh account client versions"
    Write-Host "  5) Stop unified Node server"
    Write-Host "  6) Show status"
    Write-Host "  7) Open OpenCode"
    Write-Host "  8) Exit"
    Write-Host ""

    switch (Read-Host "Select an option [1-8]") {
        "1" { Invoke-Start }
        "2" { Invoke-CheckAccounts }
        "3" { Invoke-AddAccount }
        "4" { Invoke-RefreshClientVersion }
        "5" { & $StopScript }
        "6" { & $StatusScript }
        "7" { Invoke-OpenCode }
        "8" { return }
        default { throw "Invalid option." }
    }
}

switch ($Action) {
    "Menu" { Show-Menu }
    "Start" { Invoke-Start }
    "Stop" { & $StopScript }
    "Status" { & $StatusScript }
    "CheckAccounts" { Invoke-CheckAccounts }
    "AddAccount" { Invoke-AddAccount }
    "RefreshClientVersion" { Invoke-RefreshClientVersion }
    "Install" { Invoke-Install }
    "Verify" { & $VerifyScript }
    "OpenCode" { Invoke-OpenCode }
}
