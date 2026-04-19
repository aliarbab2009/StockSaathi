@echo off
REM =============================================================================
REM StockSaathi — Backend launcher (Python SMTP + static)
REM =============================================================================
REM Runs backend.py, which serves the SPA AND handles /api/send-consent email.
REM Configure SMTP or Resend in .env (see .env.example). Without config, emails
REM log to app/logs/emails/ (dev mode).
REM =============================================================================

SET PYEXE="%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
IF NOT EXIST %PYEXE% SET PYEXE=python

cd /d "%~dp0"

REM Find free port 7340-7360
FOR /L %%P IN (7340,1,7360) DO (
  netstat -ano | findstr /r /c:":%%P *LISTENING" >nul 2>&1
  IF ERRORLEVEL 1 (
    SET STOCKSAATHI_PORT=%%P
    GOTO :FOUND
  )
)
SET STOCKSAATHI_PORT=7350
:FOUND

echo.
echo  =====================================================
echo           StockSaathi backend + frontend
echo  =====================================================
echo   http://127.0.0.1:%STOCKSAATHI_PORT%/
echo   Ctrl+C to stop.
echo.
start /b "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:%STOCKSAATHI_PORT%/"
%PYEXE% backend.py
