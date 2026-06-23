# Opens Windows Firewall for local OCPP CSMS and prints the charger WebSocket URL.
# Run from an elevated PowerShell session if firewall rules fail.

$ports = @(4001, 9000)
foreach ($port in $ports) {
    $ruleName = "Stratacore EV Charging TCP $port"
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
        Write-Host "Added firewall rule: $ruleName"
    } else {
        Write-Host "Firewall rule already exists: $ruleName"
    }
}

$lanIp = (
    Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -First 1 -ExpandProperty IPAddress
)

Write-Host ""
Write-Host "DELTA123 charger configuration:"
Write-Host "  Charge Point ID: DELTA123"
Write-Host "  Charger IP:      192.168.137.51"
Write-Host "  OCPP URL:        ws://${lanIp}:9000/ocpp/DELTA123"
Write-Host ""
Write-Host "Replace eosvolt URL (wss://cosmos.eosvolt.com/) with the OCPP URL above."
Write-Host "Ensure this PC and the charger can reach each other on TCP 9000."
