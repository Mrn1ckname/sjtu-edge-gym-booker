$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $root "config.json"
$bookerPath = Join-Path $root "booker.mjs"

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "config.json was not found."
}

$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
if ($config.targetDate -ne "auto" -or $config.releaseAt -ne "auto") {
    throw 'A recurring task requires targetDate and releaseAt to both be "auto".'
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$taskName = "SJTU-Gym-Booker-Recurring"
$arguments = '"' + $bookerPath + '" --scheduled'
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday, Monday, Tuesday, Thursday, Friday, Saturday -At "11:59:50"
$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "SJTU booking except Wednesday 11:59:50; Sunday air-dome badminton, otherwise Student Center gym; seven days ahead 17:00-18:00" `
    -Force | Out-Null

$cleanupAction = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + (Join-Path $root "log-retention.mjs") + '"') -WorkingDirectory $root
$cleanupTrigger = New-ScheduledTaskTrigger -Daily -At "03:00"
$cleanupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "SJTU-Gym-Booker-LogCleanup" -Action $cleanupAction -Trigger $cleanupTrigger -Settings $cleanupSettings -Principal $principal -Description "Delete booking logs and snapshots older than 72 hours; authentication files are excluded" -Force | Out-Null

Write-Host "Scheduled task created: $taskName"
Write-Host "Starts: 11:59:50 every day except Wednesday; booking starts at 12:00"
Write-Host "Target: Sunday air-dome badminton; otherwise Student Center gym; seven days ahead, 17:00-18:00"
Write-Host "Keep Windows signed in and online, and allow wake timers."
