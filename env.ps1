# Activate portable Node environment (current PowerShell session only)
# Usage: . .\env.ps1   (note the leading dot and space)

$nodeDir = Join-Path $PSScriptRoot "tools\node"

if (-not (Test-Path "$nodeDir\node.exe")) {
    Write-Host "ERROR: portable Node not found at $nodeDir" -ForegroundColor Red
    return
}

if ($env:Path -notlike "*$nodeDir*") {
    $env:Path = "$nodeDir;$env:Path"
}

Write-Host "Node environment activated:" -ForegroundColor Green
node --version
npm --version