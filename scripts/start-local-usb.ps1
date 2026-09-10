param([int]$Port = 8787, [string]$DevicePort = 'COM5')
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $bridgeRoot
$env:BRIDGE_HOST = '127.0.0.1'
$env:BRIDGE_PORT = [string]$Port
$env:XIAOZHI_NOTIFIER = 'usb'
$env:XIAOZHI_USB_PORT = $DevicePort
$env:WORKBUDDY_ADAPTER = 'codebuddy'
$env:WORKBUDDY_CWD = $bridgeRoot
$env:WORKBUDDY_PROJECT_ROOTS = Join-Path $env:USERPROFILE 'WorkBuddy'
$env:WORKBUDDY_CONFIG_DIR = Join-Path $env:USERPROFILE '.workbuddy'
$env:WORKBUDDY_SESSION_ROOT = Join-Path $env:USERPROFILE '.workbuddy\projects'
$env:WORKBUDDY_STATE_FILE = Join-Path $bridgeRoot 'data\workbuddy-state.json'
$env:WORKBUDDY_TRANSPORT = 'auto'
$env:CODEBUDDY_CLI_SCRIPT = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy.js'
& node (Join-Path $bridgeRoot 'dist\src\index.js')
exit $LASTEXITCODE
