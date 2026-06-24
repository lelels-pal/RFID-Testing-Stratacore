# Generates deploy/dnsmasq/*.conf with the detected LAN IP.
# Same output is used on Windows (Docker) and Xubuntu (native dnsmasq).

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Get-StratacoreLanIp {
  # Prefer real Wi-Fi/LAN (192.168.x / 10.x). Skip Docker/WSL/Hyper-V (172.x) and VPN (100.x).
  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.IPAddress -notlike '172.*' -and
    $_.IPAddress -notlike '100.*' -and
    $_.PrefixOrigin -ne 'WellKnown'
  }
  $lan192 = $candidates | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1
  if ($lan192) { return $lan192.IPAddress }
  $lan10 = $candidates | Where-Object { $_.IPAddress -like '10.*' } | Select-Object -First 1
  if ($lan10) { return $lan10.IPAddress }
  return $null
}

$lanIp = Get-StratacoreLanIp
if (-not $lanIp) {
  throw 'Could not detect LAN IPv4 address. Connect to Wi-Fi and retry.'
}

$dnsmasqDir = Join-Path $Root 'deploy\dnsmasq'
New-Item -ItemType Directory -Force -Path $dnsmasqDir | Out-Null

$stratacoreHosts = @"
# Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') — LAN IP: $lanIp
# Xubuntu: sudo cp deploy/dnsmasq/stratacore.conf /etc/dnsmasq.d/stratacore.conf && sudo systemctl restart dnsmasq

address=/stratacore.tech/$lanIp
address=/api.stratacore.tech/$lanIp
address=/admin.stratacore.tech/$lanIp
address=/guest.stratacore.tech/$lanIp
address=/ocpp.stratacore.tech/$lanIp
"@

$dockerConf = @"
# Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') — LAN IP: $lanIp
# Used by Docker on Windows (deploy/docker-compose.dnsmasq.yml)

no-hosts
no-resolv
bind-interfaces
listen-address=0.0.0.0
port=53

server=8.8.8.8
server=1.1.1.1

address=/stratacore.tech/$lanIp
address=/api.stratacore.tech/$lanIp
address=/admin.stratacore.tech/$lanIp
address=/guest.stratacore.tech/$lanIp
address=/ocpp.stratacore.tech/$lanIp
"@

Set-Content -Path (Join-Path $dnsmasqDir 'stratacore.conf') -Value $stratacoreHosts.TrimEnd() -Encoding ASCII
Set-Content -Path (Join-Path $dnsmasqDir 'dnsmasq-docker.conf') -Value $dockerConf.TrimEnd() -Encoding ASCII

# Backward-compatible path referenced in XUBUNTU.md
Set-Content -Path (Join-Path $Root 'deploy\dnsmasq-local.conf') -Value $stratacoreHosts.TrimEnd() -Encoding ASCII

Write-Host "Generated dnsmasq config for LAN IP: $lanIp" -ForegroundColor Green
Write-Host "  deploy\dnsmasq\stratacore.conf"
Write-Host "  deploy\dnsmasq\dnsmasq-docker.conf"
Write-Host "  deploy\dnsmasq-local.conf"

return $lanIp
