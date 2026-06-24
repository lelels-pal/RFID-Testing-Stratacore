# Verifies any device on the same Wi-Fi can reach Stratacore (DNS + HTTPS).
param(
  [string]$LanIp = ''
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $LanIp) {
  $LanIp = & (Join-Path $Root 'deploy\generate-dnsmasq-conf.ps1') 2>$null
  if (-not $LanIp) {
    $LanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -like '192.168.*' -and $_.PrefixOrigin -ne 'WellKnown'
      } | Select-Object -First 1).IPAddress
  }
}

$passed = 0
$failed = 0
$warned = 0

function Test-Item {
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

function Test-WarnItem {
  param([string]$Name, [string]$Detail = '')
  Write-Host "  [WARN] $Name" -ForegroundColor Yellow
  if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
  $script:warned++
}

Write-Host ''
Write-Host '==> Stratacore LAN access verification' -ForegroundColor Cyan
Write-Host "    PC LAN IP: $LanIp" -ForegroundColor White
Write-Host ''

# Network profile (firewall rules use Private profile)
$netProfile = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  Where-Object { $_.IPv4Connectivity -eq 'Internet' -or $_.IPv4Connectivity -eq 'LocalNetwork' } |
  Select-Object -First 1
if ($netProfile -and $netProfile.NetworkCategory -eq 'Public') {
  Test-WarnItem 'Wi-Fi network is Public' 'Set to Private: Settings > Network > Wi-Fi > your network > Private'
} else {
  Test-Item 'Wi-Fi network profile allows LAN firewall rules' $true ($netProfile.NetworkCategory)
}

# dnsmasq container
$dnsRunning = docker ps --filter name=stratacore-dnsmasq --format '{{.Names}}' 2>$null
Test-Item 'dnsmasq container running' ([bool]$dnsRunning) $dnsRunning

# DNS resolution via PC IP (simulates phone using PC as DNS)
$dnsResult = nslookup admin.stratacore.tech $LanIp 2>&1 | Out-String
$dnsOk = $dnsResult -match [regex]::Escape($LanIp)
Test-Item "DNS: admin.stratacore.tech -> $LanIp" $dnsOk ($dnsResult.Trim() -replace '\r?\n', ' | ')

# HTTPS via domain (uses PC hosts file - confirms apps are up)
$adminCode = curl.exe -sk -o NUL -w '%{http_code}' "https://admin.stratacore.tech/" 2>$null
Test-Item 'https://admin.stratacore.tech (on this PC)' ($adminCode -eq '200') "HTTP $adminCode"

# HTTPS via LAN IP would fail (cert is for domain) - expected
$ports = @(443, 53)
foreach ($port in $ports) {
  $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $port -and $_.LocalAddress -in @('0.0.0.0', '::', '[::]') }
  Test-Item "Port $port reachable on all interfaces" ([bool]$listening)
}

# Router DNS check - PC's current DNS server
$pcDns = (Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.ServerAddresses } |
  Select-Object -ExpandProperty ServerAddresses -First 1)
if ($pcDns -eq $LanIp) {
  Test-Item 'This PC uses Stratacore DNS' $true $pcDns
} else {
  Test-WarnItem 'Per-phone DNS not configured yet' "Set Wi-Fi DNS to $LanIp on your phone only (see deploy\PHONE-ACCESS-NO-ROUTER.md). Router change NOT required."
}

Write-Host ''
Write-Host 'Phone access WITHOUT router changes:' -ForegroundColor Cyan
Write-Host "  iPhone/Android: Wi-Fi DNS Manual -> $LanIp (this phone only)" -ForegroundColor White
Write-Host '  Production: corporate IT internal DNS records' -ForegroundColor White
Write-Host '  Guide: deploy\PHONE-ACCESS-NO-ROUTER.md' -ForegroundColor DarkGray
Write-Host ''

$summaryColor = if ($failed -eq 0) { 'Green' } else { 'Red' }
Write-Host "Summary: $passed passed, $failed failed, $warned warnings" -ForegroundColor $summaryColor
if ($failed -gt 0) { exit 1 }
