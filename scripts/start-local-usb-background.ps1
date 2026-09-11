param([int]$Port = 8787, [string]$DevicePort = 'COM5')
$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $bridgeRoot 'data\runtime'
$pidFile = Join-Path $runtimeDirectory 'bridge.pid'
$stdoutLog = Join-Path $runtimeDirectory 'bridge.stdout.log'
$stderrLog = Join-Path $runtimeDirectory 'bridge.stderr.log'
$healthUrl = "http://127.0.0.1:$Port/health"

try {
  Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 | Out-Null
  Write-Output "Bridge is already running at http://127.0.0.1:$Port"
  exit 0
} catch {
  # Start a detached local process below.
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$foregroundScript = Join-Path $PSScriptRoot 'start-local-usb.ps1'
$arguments = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', ('"{0}"' -f $foregroundScript),
  '-Port', [string]$Port,
  '-DevicePort', $DevicePort
)
$process = Start-Process `
  -FilePath 'powershell.exe' `
  -ArgumentList $arguments `
  -WorkingDirectory $bridgeRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 250
  if ($process.HasExited) {
    $errorText = if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -Raw } else { '' }
    throw "Bridge exited during startup. $errorText"
  }
  try {
    Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 | Out-Null
    Write-Output "Bridge started in background (PID $($process.Id)): http://127.0.0.1:$Port"
    Write-Output "Logs: $runtimeDirectory"
    exit 0
  } catch {
    # Keep waiting until the health endpoint is ready.
  }
} while ((Get-Date) -lt $deadline)

throw "Bridge process started, but the health endpoint did not become ready. Check $stderrLog"
