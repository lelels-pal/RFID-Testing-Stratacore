@echo off
:: Fixes ERR_NAME_NOT_RESOLVED — maps stratacore.tech to this PC (127.0.0.1)
:: Double-click this file and click Yes on UAC, OR right-click -> Run as administrator

set HOSTS=%SystemRoot%\System32\drivers\etc\hosts
set LINE=127.0.0.1 api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech

findstr /C:"api.stratacore.tech" %HOSTS% >nul
if %errorlevel%==0 (
  echo Hosts file already has stratacore.tech entries.
  findstr /C:"admin.stratacore.tech" %HOSTS% >nul
  if %errorlevel%==0 (
    echo admin.stratacore.tech is present - OK.
  ) else (
    echo WARNING: api.stratacore.tech found but admin.stratacore.tech is missing.
    echo Edit %HOSTS% manually and replace kiosk with admin, or delete the old line and re-run.
  )
) else (
  if not exist %HOSTS% echo.> %HOSTS%
  for %%A in (%HOSTS%) do if %%~zA==0 (
    echo # Copyright (c) 1993-2009 Microsoft Corp.>> %HOSTS%
    echo #>> %HOSTS%
    echo 127.0.0.1       localhost>> %HOSTS%
    echo ::1             localhost>> %HOSTS%
  )
  echo.>> %HOSTS%
  echo # stratacore.tech local routing>> %HOSTS%
  echo %LINE%>> %HOSTS%
  echo Added stratacore.tech to hosts file.
)

echo.
echo Test in a NEW browser tab: https://admin.stratacore.tech
echo.
pause
