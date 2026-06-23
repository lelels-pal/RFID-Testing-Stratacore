# Stratacore external watchdog scheduled task setup
# Run as Administrator

Write-Host "=============================================="
Write-Host "Stratacore Watchdog Scheduled Task Setup"
Write-Host "=============================================="

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $nodePath) {
  Write-Error "Node.js not found in PATH."
  exit 1
}

$watchdogScript = Join-Path $projectRoot "tools\watchdog\service-watchdog.js"

Write-Host "`nCreating Service Watchdog task..."
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$watchdogScript`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 9999)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3
Register-ScheduledTask -TaskName "Stratacore_Service_Watchdog" -Action $action -Trigger $trigger -Settings $settings -Description "Monitor Stratacore backend and OCPP health" -Force

Write-Host "  -> Stratacore_Service_Watchdog created (every 5 minutes)"
Write-Host "`nSetup complete."
