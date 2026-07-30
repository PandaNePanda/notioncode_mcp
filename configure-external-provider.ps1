[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("openrouter", "vivgrid", "cerebras")]
    [string]$Provider,
    [switch]$Clear
)

$ErrorActionPreference = "Stop"
$EnvironmentVariables = @{
    openrouter = "OPENROUTER_API_KEY"
    vivgrid = "VIVGRID_API_KEY"
    cerebras = "CEREBRAS_API_KEY"
}
$VariableName = $EnvironmentVariables[$Provider]

if ($Clear) {
    [Environment]::SetEnvironmentVariable($VariableName, $null, "User")
    [Environment]::SetEnvironmentVariable($VariableName, $null, "Process")
    Write-Host "$Provider credential removed from the current Windows user environment."
    Write-Host "Restart Codex before using the external-inference MCP again."
    exit 0
}

$SecureValue = Read-Host "Enter the $Provider API key (input is masked)" -AsSecureString
$Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
try {
    $PlainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
    if ([string]::IsNullOrWhiteSpace($PlainValue)) {
        throw "The API key was empty. Nothing was changed."
    }
    [Environment]::SetEnvironmentVariable($VariableName, $PlainValue, "User")
    [Environment]::SetEnvironmentVariable($VariableName, $PlainValue, "Process")
} finally {
    if ($Pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
    }
    $PlainValue = $null
    $SecureValue.Dispose()
}

Write-Host "$Provider credential configured for the current Windows user."
Write-Host "The key was not written to Codex config or console output. Restart Codex, then call external_provider_status."
