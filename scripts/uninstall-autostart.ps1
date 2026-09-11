$ErrorActionPreference = 'Stop'
$taskName = 'XiaozhiWorkBuddyBridge'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Removed Windows logon task: $taskName"
} else {
  Write-Output "Windows logon task is not installed: $taskName"
}
