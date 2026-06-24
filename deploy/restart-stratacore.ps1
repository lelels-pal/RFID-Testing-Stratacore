# Full restart: Stratacore apps + dnsmasq (Docker)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host '==> Stopping Stratacore apps...' -ForegroundColor Cyan
& (Join-Path $Root 'deploy\stop-stratacore.ps1')

Write-Host ''
Write-Host '==> Stopping dnsmasq (Docker)...' -ForegroundColor Cyan
& (Join-Path $Root 'deploy\stop-dnsmasq.ps1')

Start-Sleep -Seconds 2

Write-Host ''
Write-Host '==> Starting dnsmasq (Docker)...' -ForegroundColor Cyan
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
  try {
    docker info *> $null
    & (Join-Path $Root 'deploy\generate-dnsmasq-conf.ps1') | Out-Null
    Set-Location (Join-Path $Root 'deploy')
    docker compose -f docker-compose.dnsmasq.yml up -d --force-recreate
    Set-Location $Root
    Write-Host 'dnsmasq started.' -ForegroundColor Green
  } catch {
    Write-Host 'Docker not running — skip dnsmasq or start Docker Desktop and run SETUP-DNSMASQ.bat' -ForegroundColor Yellow
  }
} else {
  Write-Host 'Docker not installed — skipping dnsmasq.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '==> Starting Stratacore apps...' -ForegroundColor Cyan
& (Join-Path $Root 'deploy\start-stratacore.ps1')
