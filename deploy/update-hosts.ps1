# Updates Windows hosts file for local stratacore.tech routing. Requires Administrator.
$ErrorActionPreference = 'Stop'

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

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$line = '127.0.0.1 api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech'
$marker = '# stratacore.tech local routing'

$content = if (Test-Path $hostsPath) { Get-Content $hostsPath -Raw } else { '' }
if ($null -eq $content) { $content = '' }

if ($content -match 'kiosk\.stratacore\.tech') {
  $content = $content -replace 'kiosk\.stratacore\.tech', 'admin.stratacore.tech'
  Write-Host 'Updated kiosk.stratacore.tech -> admin.stratacore.tech' -ForegroundColor Green
}

if ($content -match 'api\.stratacore\.tech') {
  if ($content -notmatch 'admin\.stratacore\.tech') {
    Write-Host 'WARNING: api.stratacore.tech present but admin.stratacore.tech missing.' -ForegroundColor Red
    exit 1
  }
  Write-Host 'Hosts file already has stratacore.tech entries.' -ForegroundColor Yellow
} else {
  if ($content.Trim().Length -eq 0) {
    $content = @"
# Copyright (c) 1993-2009 Microsoft Corp.
#
# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.
#
127.0.0.1       localhost
::1             localhost

"@
  }
  if ($content -notmatch [regex]::Escape($marker)) {
    $content = $content.TrimEnd() + "`r`n`r`n$marker`r`n$line`r`n"
  }
  Set-Content -Path $hostsPath -Value $content -NoNewline -Encoding ASCII
  Write-Host 'Added stratacore.tech entries to hosts file.' -ForegroundColor Green
}

ipconfig /flushdns | Out-Null
Write-Host 'DNS cache flushed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Test: https://admin.stratacore.tech' -ForegroundColor Cyan
Write-Host ''
Read-Host 'Press Enter to close'
