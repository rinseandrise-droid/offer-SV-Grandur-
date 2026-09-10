@echo off
title SV Granges — Coupon Admin
setlocal

set "ROOT=%~dp0"
set "BILLING=%ROOT%..\laundry-billing"
set "PORT=5090"

echo.
echo  SV Granges Coupon Campaign
echo  ==========================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Python not found. Install Python 3.10+ and try again.
  pause
  exit /b 1
)

echo  [1/2] Checking WhatsApp bridge ^(from billing app^)...
curl -s http://127.0.0.1:3001/health >nul 2>&1
if errorlevel 1 (
  if exist "%BILLING%\Start Billing.bat" (
    echo        Bridge not running — starting billing WhatsApp bridge...
    start "WhatsApp Bridge" /MIN cmd /c "cd /d \"%BILLING%\whatsapp-bridge\" && node server.js"
    timeout /t 4 /nobreak >nul
  ) else (
    echo        [WARN] WhatsApp bridge offline. Start laundry-billing first for WhatsApp send.
  )
) else (
  echo        WhatsApp bridge is running.
)

echo  [2/2] Starting coupon admin on http://localhost:%PORT%
start "SV Granges Admin" cmd /k "cd /d \"%ROOT%server\" && python app.py"

timeout /t 2 /nobreak >nul
start http://localhost:%PORT%/

echo.
echo  Admin login password: SVGranges@22
echo  ^(change via SV_GRANGES_ADMIN_PASSWORD environment variable^)
echo.
pause
