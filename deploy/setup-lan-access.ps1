# One-click universal LAN access: dnsmasq + firewall + verification.
# After this, set router DHCP DNS to the printed IP — then ANY device on same Wi-Fi works.
param(
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$dnsmasqScript = Join-Path $Root 'deploy\setup-dnsmasq.ps1'
if (-not (Test-Path $dnsmasqScript)) {
  Write-Host 'deploy\setup-dnsmasq.ps1 not found.' -ForegroundColor Red
  exit 1
}

# setup-dnsmasq.ps1 handles Admin UAC and ends with Read-Host — call parts directly if already admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host 'Requesting Administrator (UAC)...' -ForegroundColor Yellow
  $self = $MyInvocation.MyCommand.Path
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$self`""
  )
  exit 0
}

Write-Host '==> Stratacore universal LAN access setup' -ForegroundColor Cyan
Write-Host ''

$lanIp = & (Join-Path $Root 'deploy\generate-dnsmasq-conf.ps1')

# Start dnsmasq (reuse logic without second UAC / Read-Host)
Set-Location $Root
docker compose -f deploy\docker-compose.dnsmasq.yml up -d --force-recreate
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Failed to start dnsmasq. Is Docker Desktop running?' -ForegroundColor Red
  exit 1
}

& (Join-Path $Root 'deploy\open-lan-firewall.ps1') -NoPrompt

# DNS firewall
foreach ($rule in @(
  @{ Name = 'Stratacore DNS (53 TCP)'; Port = 53; Protocol = 'TCP' },
  @{ Name = 'Stratacore DNS (53 UDP)'; Port = 53; Protocol = 'UDP' }
)) {
  if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $rule.Name `
      -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Port `
      -Profile Private, Domain | Out-Null
  }
}

# Write quick reference card
$card = @"
Stratacore — Universal Wi-Fi access
====================================
PC LAN IP:     $lanIp
Router admin:  http://192.168.254.4  (your gateway — check router label if different)

ONE-TIME ROUTER SETTING (makes ALL devices work):
  DHCP / LAN / DNS server -> $lanIp

Then any phone/charger on this Wi-Fi can open:
  https://admin.stratacore.tech
  https://guest.stratacore.tech

Keep running on this PC:
  START-STRATACORE.bat  (apps)
  Docker Desktop        (dnsmasq DNS)

Verify: VERIFY-LAN-ACCESS.bat
"@
Set-Content -Path (Join-Path $Root 'deploy\LAN-ACCESS.txt') -Value $card -Encoding UTF8

Write-Host ''
Write-Host $card -ForegroundColor White
Write-Host ''

if (-not $SkipVerify) {
  & (Join-Path $Root 'deploy\verify-lan-access.ps1') -LanIp $lanIp
}

Write-Host ''
Read-Host 'Press Enter to close'
