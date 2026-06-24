# Opens Windows Firewall for Stratacore LAN access (phones, chargers on Wi-Fi).
# Run once as Administrator: powershell -ExecutionPolicy Bypass -File deploy\open-lan-firewall.ps1
param(
  [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  if ($NoPrompt) { throw 'Administrator required for firewall rules.' }
  Write-Host 'Re-launching as Administrator (UAC)...' -ForegroundColor Yellow
  $scriptPath = $MyInvocation.MyCommand.Path
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`""
  )
  exit 0
}

$rules = @(
  @{ Name = 'Stratacore HTTPS (443)'; Port = 443 },
  @{ Name = 'Stratacore OCPP direct (9000)'; Port = 9000 }
)

foreach ($rule in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $($rule.Name)" -ForegroundColor Yellow
    continue
  }
  New-NetFirewallRule -DisplayName $rule.Name `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Port `
    -Profile Private, Domain | Out-Null
  Write-Host "Added firewall rule: $($rule.Name) (TCP $($rule.Port))" -ForegroundColor Green
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1).IPAddress

Write-Host ''
Write-Host 'LAN access checklist:' -ForegroundColor Cyan
Write-Host "  1. This PC LAN IP: $lanIp"
Write-Host '  2. Point router DNS or dnsmasq at that IP for *.stratacore.tech'
Write-Host '     (see deploy/dnsmasq-local.conf — same file used on Xubuntu)'
Write-Host '  3. Phone on same Wi-Fi: https://admin.stratacore.tech (accept cert once)'
Write-Host ''
if (-not $NoPrompt) {
  Read-Host 'Press Enter to close'
}
