param([int]$Port = 8787)
$ErrorActionPreference = 'Stop'

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
  [ordered]@{
    bridge = 'online'
    device = $health.deviceState
    workbuddy = if ($health.workbuddy.connected) { 'connected' } else { 'disconnected' }
    projectCount = $health.workbuddy.projectCount
    sessionCount = $health.workbuddy.sessionCount
    xiaozhiMcp = $health.xiaozhiMcp.state
  } | ConvertTo-Json
} catch {
  [ordered]@{ bridge = 'offline'; error = $_.Exception.Message } | ConvertTo-Json
  exit 1
}
