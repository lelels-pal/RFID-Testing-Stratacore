# Install/start Stratacore dnsmasq on Windows (Docker) — same config as Xubuntu.
# Run as Admin: powershell -ExecutionPolicy Bypass -File deploy\setup-dnsmasq.ps1
# Or double-click SETUP-DNSMASQ.bat

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host 'Re-launching as Administrator (UAC)...' -ForegroundColor Yellow
  $scriptPath = $MyInvocation.MyCommand.Path
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`""
  )
  exit 0
}

Write-Host '==> Stratacore dnsmasq setup (Windows / Docker)' -ForegroundColor Cyan

# --- Generate config with detected LAN IP ---
$lanIp = & (Join-Path $Root 'deploy\generate-dnsmasq-conf.ps1')

# --- Docker ---
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  Write-Host 'Docker not found. Install Docker Desktop, or use deploy/setup-dnsmasq.sh on Xubuntu.' -ForegroundColor Red
  exit 1
}

try {
  docker info *> $null
} catch {
  Write-Host 'Docker is not running. Start Docker Desktop and retry.' -ForegroundColor Red
  exit 1
}

Write-Host 'Starting dnsmasq container...' -ForegroundColor Cyan
Set-Location (Join-Path $Root 'deploy')
docker compose -f docker-compose.dnsmasq.yml up -d
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Failed to start dnsmasq. Port 53 may be in use by another service.' -ForegroundColor Red
  exit 1
}
Set-Location $Root

# --- Firewall ---
$dnsRules = @(
  @{ Name = 'Stratacore DNS (53 TCP)'; Port = 53; Protocol = 'TCP' },
  @{ Name = 'Stratacore DNS (53 UDP)'; Port = 53; Protocol = 'UDP' }
)
foreach ($rule in $dnsRules) {
  $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule exists: $($rule.Name)" -ForegroundColor Yellow
    continue
  }
  New-NetFirewallRule -DisplayName $rule.Name `
    -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Port `
    -Profile Private, Domain | Out-Null
  Write-Host "Added firewall rule: $($rule.Name)" -ForegroundColor Green
}

# HTTPS / OCPP rules (same as OPEN-LAN-FIREWALL.bat)
$lanScript = Join-Path $Root 'deploy\open-lan-firewall.ps1'
if (Test-Path $lanScript) {
  & $lanScript -NoPrompt
}

Write-Host ''
Write-Host 'dnsmasq is running on this PC.' -ForegroundColor Green
Write-Host ''
Write-Host 'PHONE ACCESS (no router change):' -ForegroundColor Cyan
Write-Host "  On YOUR phone only: Wi-Fi DNS -> Manual -> $lanIp" -ForegroundColor White
Write-Host '  Then open https://admin.stratacore.tech on that phone'
Write-Host ''
Write-Host '  Full guide: deploy\PHONE-ACCESS-NO-ROUTER.md' -ForegroundColor DarkGray
Write-Host ''
Write-Host 'PRODUCTION (large company): ask IT for internal DNS A records' -ForegroundColor Yellow
Write-Host '  Do NOT change router DHCP DNS on shared company Wi-Fi.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Optional (dedicated site YOU control): set router DHCP DNS to' -ForegroundColor DarkGray
Write-Host "  $lanIp  — see deploy\LAN-ACCESS.txt" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Xubuntu later: sudo bash deploy/setup-dnsmasq.sh OR corporate IT DNS' -ForegroundColor DarkGray
Write-Host ''
Read-Host 'Press Enter to close'
