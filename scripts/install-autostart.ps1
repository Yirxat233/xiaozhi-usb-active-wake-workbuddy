param([int]$Port = 8787, [string]$DevicePort = 'COM5')
$ErrorActionPreference = 'Stop'

$taskName = 'XiaozhiWorkBuddyBridge'
$runner = Join-Path $PSScriptRoot 'run-local-usb-autostart.ps1'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Port $Port -DevicePort `"$DevicePort`""

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description 'Xiaozhi USB WorkBuddy Bridge' -Force | Out-Null
Write-Output "Installed Windows logon task: $taskName"
Write-Output "It will start at the next logon. Run start-local-usb-background.ps1 to start now."
