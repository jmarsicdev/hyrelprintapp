@echo off
rem Hyrel Print Assistant launcher (Windows). First run creates the venv.
cd /d %~dp0
if not exist .venv (
    echo Creating Python environment...
    py -3 -m venv .venv || goto :nopython
    .venv\Scripts\python -m pip install --upgrade pip
    .venv\Scripts\pip install -r requirements.txt
)
if not exist .env (
    echo.
    echo ERROR: no .env file. Copy .env.example to .env and add the API key.
    pause
    exit /b 1
)
echo Starting Hyrel Print Assistant on http://localhost:8137
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8137
pause
exit /b 0

:nopython
echo.
echo ERROR: Python 3 not found. Install it from python.org (check "Add to PATH").
echo If this PC is offline, download the full installer on another machine.
pause
exit /b 1
