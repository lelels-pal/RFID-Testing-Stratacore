<#
.SYNOPSIS
  One-time setup for stratacore.tech on this Windows machine.

.DESCRIPTION
  1. Adds stratacore.tech subdomains to the hosts file (127.0.0.1)
  2. Downloads Caddy if missing
  3. Builds all apps
  4. Starts backend, kiosk, guest-app, and Caddy

  Easiest: double-click deploy\setup-stratacore.bat (requests Admin via UAC)

  Or from Admin PowerShell:
    powershell -ExecutionPolicy Bypass -File deploy\setup-stratacore.ps1
#>

$ErrorActionPreference = 'Stop'

# Re-launch as Administrator if needed (hosts file requires it)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host "Requesting Administrator access (UAC prompt)..." -ForegroundColor Yellow
  $scriptPath = $MyInvocation.MyCommand.Path
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`""
  )
  exit 0
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "==> Stratacore domain setup" -ForegroundColor Cyan

# --- Hosts file ---
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$hostsLine = '127.0.0.1 api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech'
$hostsContent = Get-Content $hostsPath -Raw

if ($null -eq $hostsContent) { $hostsContent = '' }

if ($hostsContent -match 'kiosk\.stratacore\.tech') {
  $hostsContent = $hostsContent -replace 'kiosk\.stratacore\.tech', 'admin.stratacore.tech'
  Set-Content -Path $hostsPath -Value $hostsContent.TrimEnd() -NoNewline -Encoding ASCII
  Write-Host "Updated hosts file: kiosk.stratacore.tech -> admin.stratacore.tech" -ForegroundColor Green
} elseif ($hostsContent -notmatch 'api\.stratacore\.tech') {
  if ($hostsContent.Trim().Length -eq 0) {
    $hostsContent = @"
# Copyright (c) 1993-2009 Microsoft Corp.
#
# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.
#
127.0.0.1       localhost
::1             localhost

"@
  }
  $hostsContent = $hostsContent.TrimEnd() + "`r`n`r`n# stratacore.tech local routing (added by deploy/setup-stratacore.ps1)`r`n$hostsLine`r`n"
  Set-Content -Path $hostsPath -Value $hostsContent -NoNewline -Encoding ASCII
  Write-Host "Added stratacore.tech entries to hosts file." -ForegroundColor Green
} else {
  Write-Host "Hosts file already contains stratacore.tech entries." -ForegroundColor Yellow
}

ipconfig /flushdns | Out-Null
Write-Host "DNS cache flushed." -ForegroundColor Green

# --- Caddy binary ---
$caddyDir = Join-Path $Root 'deploy\bin'
$caddyExe = Join-Path $caddyDir 'caddy.exe'
if (-not (Test-Path $caddyExe)) {
  New-Item -ItemType Directory -Force -Path $caddyDir | Out-Null
  $zip = Join-Path $env:TEMP 'caddy_windows_amd64.zip'
  $url = 'https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_windows_amd64.zip'
  Write-Host "Downloading Caddy..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $caddyDir -Force
  Remove-Item $zip -Force
  Write-Host "Caddy installed to deploy\bin\caddy.exe" -ForegroundColor Green
} else {
  Write-Host "Caddy already present." -ForegroundColor Yellow
}

# --- Build ---
Write-Host "Building apps..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

# --- Stop previous + start (shared with deploy/start-stratacore.ps1) ---
& (Join-Path $Root 'deploy\start-stratacore.ps1')

Write-Host ""
Write-Host 'Press Enter to close this window...'
Read-Host | Out-Null
