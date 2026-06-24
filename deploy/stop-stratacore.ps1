# Stop Stratacore services (backend, kiosk, guest app, Caddy)
$ports = @(4001, 3001, 3002, 443, 9000)
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique

if (-not $pids) {
  Write-Host 'No Stratacore processes found on ports 4001, 3001, 3002, 443, 9000.'
  exit 0
}

foreach ($procId in $pids) {
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  Write-Host "Stopping PID $procId ($name)..."
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}

Write-Host 'Done. Ports should be free now.'
Start-Sleep -Seconds 1
netstat -ano | findstr "LISTENING" | findstr ":9000 :4001 :3001 :3002 :443"
