@echo off
setlocal
chcp 65001 >nul 2>nul
title Aurora - YouTube Downloader
cd /d "%~dp0"

set "APP=%~dp0Aurora.exe"
set "URL=http://127.0.0.1:8765"

if not exist "%APP%" (
    echo.
    echo   Aurora.exe was not found in this folder.
    echo   Keep Aurora.bat and Aurora.exe together, then double-click this again.
    echo.
    pause
    exit /b 1
)

rem Already running? Then just open the browser.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try{ $r=Invoke-WebRequest -Uri '%URL%/api/health' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } }catch{} ; exit 1" >nul 2>&1
if not errorlevel 1 (
    echo   Aurora is already running - opening your browser...
    start "" "%URL%"
    exit /b 0
)

echo   Starting Aurora...
start "Aurora" "%APP%"

echo   Waiting for the download engine to be ready...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $ok=$false; for($i=0;$i -lt 60;$i++){ try{ $r=Invoke-WebRequest -Uri '%URL%/api/health' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){ $ok=$true; break } }catch{} ; Start-Sleep -Milliseconds 700 }; if($ok){ Start-Process '%URL%' } else { Write-Host '    Aurora did not start - read the Aurora window for the reason.' }"

echo.
echo   Aurora is running in its own window.
echo   Close that window to stop it.
echo.
ping -n 7 127.0.0.1 >nul
exit /b 0
