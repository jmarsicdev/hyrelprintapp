@echo off
rem Development server: edit -> save -> refresh the browser. No rebuild.
rem Python code reloads automatically; static/*.js and *.css are read from
rem disk on every request, so a plain browser refresh picks them up.
cd /d %~dp0
if not exist .venv (
    echo Creating Python environment...
    py -3 -m venv .venv || goto :nopython
    .venv\Scripts\python -m pip install --upgrade pip
    .venv\Scripts\pip install -r requirements.txt
)
echo.
echo   Dev server:  http://localhost:8137
echo   Editing static\app.js or style.css? Just save and refresh the browser.
echo   Editing app\*.py? It reloads by itself.
echo   Ctrl+C to stop.
echo.
.venv\Scripts\python -m uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port 8137
exit /b 0

:nopython
echo.
echo ERROR: Python 3 not found. Install it from python.org (check "Add to PATH").
pause
exit /b 1
