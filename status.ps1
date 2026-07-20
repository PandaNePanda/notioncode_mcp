$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

$Root = Get-NotionCodeRoot
$AccountHome = Join-Path $HOME ".notionagents"
$result = [ordered]@{
    project_root = $Root
    runtime_port_8787 = Test-TcpPort 8787
    bridge_port_8765 = Test-TcpPort 8765
    account_file = Test-Path (Join-Path $AccountHome "notion_account.json")
    models_file = Test-Path (Join-Path $AccountHome "models.json")
}
if ($result.bridge_port_8765) {
    try { $result.health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/healthz" -TimeoutSec 5 }
    catch { $result.health_error = $_.Exception.Message }
}
[pscustomobject]$result | ConvertTo-Json -Depth 10
