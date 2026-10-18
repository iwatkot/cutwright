param([Parameter(Mandatory=$true)][string]$TaskName,[Parameter(Mandatory=$true)][string]$NodeBinary,[Parameter(Mandatory=$true)][string]$OwnerScript,[Parameter(Mandatory=$true)][string]$StateDirectory)
$ErrorActionPreference = 'Stop'
$taskArguments = '"' + $OwnerScript + '" owner "--state=' + $StateDirectory + '"'
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and ($existingTask.Actions.Execute -ne $NodeBinary -or $existingTask.Actions.Arguments -ne $taskArguments)) { throw 'A different task owns this name; choose different editor ports.' }
if (!$existingTask) {
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  $action = New-ScheduledTaskAction -Execute $NodeBinary -Argument $taskArguments -WorkingDirectory (Split-Path -Parent $OwnerScript)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings | Out-Null
}
Start-ScheduledTask -TaskName $TaskName
