# Stratacore smoke test — ports, HTTPS domains, watchdogs, hosts file.
# Usage: powershell -ExecutionPolicy Bypass -File deploy\health-check.ps1
param(
  [int]$WaitSeconds = 0
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if ($WaitSeconds -gt 0) {
  Write-Host "Waiting ${WaitSeconds}s for services to start..." -ForegroundColor DarkGray
  Start-Sleep -Seconds $WaitSeconds
}

$passed = 0
$failed = 0
$warned = 0

function Test-Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  if ($Ok) {
    Write-Host "  [OK]   $Name" -ForegroundColor Green
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
    $script:passed++
  } else {
    Write-Host "  [FAIL] $Name" -ForegroundColor Red
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor Yellow }
    $script:failed++
  }
}

function Test-Warn {
  param([string]$Name, [string]$Detail = '')
  Write-Host "  [WARN] $Name" -ForegroundColor Yellow
  if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
  $script:warned++
}

Write-Host ''
Write-Host '==> Stratacore health check' -ForegroundColor Cyan
Write-Host ''

# --- Hosts file ---
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$hostsContent = if (Test-Path $hostsPath) { Get-Content $hostsPath -Raw } else { '' }
Test-Check 'Hosts file has admin.stratacore.tech' ($hostsContent -match 'admin\.stratacore\.tech')

# --- Env sanity ---
$backendEnv = Join-Path $Root 'apps\backend\.env'
if (Test-Path $backendEnv) {
  $envText = Get-Content $backendEnv -Raw
  Test-Check 'GUEST_APP_URL=https://guest.stratacore.tech' ($envText -match 'GUEST_APP_URL=https://guest\.stratacore\.tech')
  Test-Check 'CORS includes admin + guest HTTPS origins' ($envText -match 'CORS_ALLOWED_ORIGINS=.*admin\.stratacore\.tech.*guest\.stratacore\.tech')
} else {
  Test-Check 'apps/backend/.env exists' $false 'Copy from apps/backend/.env.example'
}

# --- Listening ports ---
$requiredPorts = @(4001, 3001, 3002, 443, 9000)
$listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $requiredPorts -contains $_.LocalPort } |
  Select-Object LocalPort, LocalAddress -Unique

foreach ($port in $requiredPorts) {
  $conn = $listening | Where-Object { $_.LocalPort -eq $port }
  $detail = if ($conn) {
    ($conn | ForEach-Object { $_.LocalAddress }) -join ', '
  } else {
    'not listening'
  }
  Test-Check "Port $port listening" ([bool]$conn) $detail
}

$caddy443 = $listening | Where-Object { $_.LocalPort -eq 443 -and $_.LocalAddress -in @('0.0.0.0', '::', '[::]') }
if (-not $caddy443) {
  $any443 = $listening | Where-Object { $_.LocalPort -eq 443 }
  if ($any443) {
    Test-Warn 'Caddy may not be LAN-reachable' "443 bound to $($any443.LocalAddress) only - phones need 0.0.0.0:443"
  }
}

# --- HTTPS endpoints ---
function Invoke-HttpsStatus {
  param([string]$Url)
  $code = curl.exe -sk -o NUL -w '%{http_code}' $Url 2>$null
  if ($code -match '^\d+$') { return [int]$code }
  return 0
}

$apiHealth = Invoke-HttpsStatus 'https://api.stratacore.tech/api/health'
Test-Check 'https://api.stratacore.tech/api/health' ($apiHealth -eq 200) "HTTP $apiHealth"

$adminCode = Invoke-HttpsStatus 'https://admin.stratacore.tech'
Test-Check 'https://admin.stratacore.tech' ($adminCode -eq 200) "HTTP $adminCode"

$guestCode = Invoke-HttpsStatus 'https://guest.stratacore.tech'
Test-Check 'https://guest.stratacore.tech' ($guestCode -eq 200) "HTTP $guestCode"

# --- Watchdogs ---
try {
  $watchdog = Invoke-RestMethod -Uri 'http://localhost:4001/api/watchdog' -TimeoutSec 10
  $staleActive = $watchdog.staleSessionMonitor.active -eq $true
  $healthActive = $watchdog.healthMonitor.active -eq $true
  Test-Check 'Stale session monitor running' $staleActive
  Test-Check 'Health monitor running' $healthActive
  if (-not $watchdog.active) {
    Test-Warn 'Service watchdog poller not running' 'Set WATCHDOG_AUTOSTART=1 in apps/backend/.env to enable'
  } else {
    Test-Check 'Service watchdog poller running' $true
  }
} catch {
  Test-Check 'GET /api/watchdog' $false $_.Exception.Message
}

$summaryColor = if ($failed -eq 0) { 'Green' } else { 'Red' }
Write-Host ''
Write-Host "Summary: $passed passed, $failed failed, $warned warnings" -ForegroundColor $summaryColor
Write-Host ''

if ($failed -gt 0) { exit 1 }
exit 0
