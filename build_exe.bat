@echo off
rem Build a self-contained HyrelAssistant.exe. Run this on ANY Windows
rem machine with Python (e.g. your laptop) — the Hyrel PC then needs only
rem the exe + a .env file, no Python install.
cd /d %~dp0
py -3 -m venv .buildvenv || goto :err
.buildvenv\Scripts\pip install --upgrade pip
.buildvenv\Scripts\pip install -r requirements.txt pyinstaller || goto :err
.buildvenv\Scripts\pyinstaller --noconfirm --onefile --name HyrelAssistant ^
    --add-data "static;static" launcher.py || goto :err
echo.
echo Done. Copy these to the Hyrel PC (any folder, e.g. C:\hyrel-assistant):
echo   dist\HyrelAssistant.exe
echo   .env            (copy .env.example, fill in the API key)
echo Then double-click HyrelAssistant.exe. Data is stored next to the exe.
pause
exit /b 0
:err
echo Build failed - see messages above.
pause
exit /b 1
