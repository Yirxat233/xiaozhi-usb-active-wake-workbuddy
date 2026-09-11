param([int]$Port = 8787, [string]$DevicePort = 'COM5')
$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $bridgeRoot 'data\runtime'
$stdoutLog = Join-Path $runtimeDirectory 'bridge.stdout.log'
$stderrLog = Join-Path $runtimeDirectory 'bridge.stderr.log'
$foregroundScript = Join-Path $PSScriptRoot 'start-local-usb.ps1'

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $foregroundScript -Port $Port -DevicePort $DevicePort `
  1>> $stdoutLog 2>> $stderrLog
exit $LASTEXITCODE
