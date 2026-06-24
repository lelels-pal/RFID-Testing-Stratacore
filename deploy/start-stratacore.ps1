# Start Stratacore (no Admin, no rebuild). Use after first-time setup.
param(
  [switch]$ShowWindows
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$hostsContent = if (Test-Path $hostsPath) { Get-Content $hostsPath -Raw } else { '' }
if ($hostsContent -notmatch 'admin\.stratacore\.tech') {
  Write-Host 'Hosts file missing stratacore.tech entries (ERR_NAME_NOT_RESOLVED).' -ForegroundColor Red
  Write-Host 'Run FIX-HOSTS.bat once (Admin UAC), then start again.' -ForegroundColor Yellow
  $fixHosts = Join-Path $Root 'deploy\update-hosts.ps1'
  if (Test-Path $fixHosts) {
    & $fixHosts
  }
  exit 1
}

$caddyExe = Join-Path $Root 'deploy\bin\caddy.exe'
if (-not (Test-Path $caddyExe)) {
  Write-Host 'Caddy not found. Run deploy\setup-stratacore.bat first (one-time setup).' -ForegroundColor Red
  exit 1
}

$logDir = Join-Path $Root 'deploy\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host '==> Starting Stratacore...' -ForegroundColor Cyan

$ports = @(4001, 3001, 3002, 443, 9000)
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $pids) {
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

function Start-StratacoreService {
  param(
    [string]$Name,
    [string]$Command
  )

  $logFile = Join-Path $logDir "$Name.log"
  Set-Content -Path $logFile -Value "=== Started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -Encoding UTF8

  if ($ShowWindows) {
    Start-Process powershell -ArgumentList @(
      '-NoExit', '-Command',
      "cd '$Root'; `$Host.UI.RawUI.WindowTitle = 'Stratacore $Name'; $Command"
    )
    return
  }

  $hiddenCmd = "/c `"cd /d `"$Root`" && $Command >> `"$logFile`" 2>&1`""
  Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -ArgumentList $hiddenCmd | Out-Null
}

Start-StratacoreService -Name 'backend' -Command 'npm run start --workspace=backend'
Start-Sleep -Seconds 3
Start-StratacoreService -Name 'kiosk' -Command 'npm run start --workspace=kiosk'
Start-StratacoreService -Name 'guest-app' -Command 'npm run start --workspace=guest-app'
Start-Sleep -Seconds 2
Start-StratacoreService -Name 'caddy' -Command "`"$caddyExe`" run --config deploy\Caddyfile.local"

Write-Host ''
if ($ShowWindows) {
  Write-Host 'Stratacore is starting in 4 windows (debug mode).' -ForegroundColor Green
} else {
  Write-Host 'Stratacore is starting in the background (no extra windows).' -ForegroundColor Green
  Write-Host "  Logs: deploy\logs\" -ForegroundColor DarkGray
  Write-Host '  View logs: double-click VIEW-LOGS.bat' -ForegroundColor DarkGray
}
Write-Host '  Admin: https://admin.stratacore.tech'
Write-Host '  Guest: https://guest.stratacore.tech'
Write-Host ''

$healthScript = Join-Path $Root 'deploy\health-check.ps1'
if (Test-Path $healthScript) {
  & $healthScript -WaitSeconds 8
}

Start-Process 'https://admin.stratacore.tech'
