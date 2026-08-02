@echo off
title Aetheria RP Studio - BYOK AI Roleplay App
color 0B
echo ===================================================
echo     Aetheria RP Studio - BYOK AI Roleplay Client   
echo ===================================================
echo.
echo Menjalankan local server di http://localhost:8080 ...
echo (Browser Caching Di-disable agar update selalu fresh)
echo.

start "" "http://localhost:8080"

where python >nul 2>nul
if %errorlevel%==0 (
    python server.py 8080
    goto :end
)

if exist "C:\Program Files\PyManager\python.exe" (
    "C:\Program Files\PyManager\python.exe" server.py 8080
    goto :end
)

echo [ERROR] Python tidak ditemukan di sistem!
pause

:end
