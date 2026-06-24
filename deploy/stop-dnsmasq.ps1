# Stop Stratacore dnsmasq Docker container (Windows)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location (Join-Path $Root 'deploy')
docker compose -f docker-compose.dnsmasq.yml down
Write-Host 'Stratacore dnsmasq stopped.' -ForegroundColor Green
