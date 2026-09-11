param([int]$Port = 8787)
$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $bridgeRoot 'data\runtime\bridge.pid'
$stopped = $false
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

foreach ($listener in $listeners) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($process.CommandLine -match 'dist[\\/]src[\\/]index\.js') {
    Stop-Process -Id $listener.OwningProcess -Force
    $stopped = $true
  }
}

if (Test-Path -LiteralPath $pidFile) {
  $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $wrapper = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
  if ($wrapper.CommandLine -match 'start-local-usb\.ps1') {
    Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
    $stopped = $true
  }
  Remove-Item -LiteralPath $pidFile -Force
}

if ($stopped) {
  Write-Output 'Bridge stopped.'
} else {
  Write-Output 'Bridge is not running.'
}
