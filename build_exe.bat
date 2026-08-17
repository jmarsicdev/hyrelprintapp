@echo off
rem Test, then build a self-contained HyrelAssistant.exe, then optionally
rem install it over your local copy.
rem
rem   build_exe.bat                 build only, leaves it in dist\
rem   build_exe.bat C:\hyrel-assistant   build and install into that folder
rem
rem Run this on any Windows machine with Python; the Hyrel PC needs only the
rem exe plus a .env.
cd /d %~dp0

echo === tests ===
call test.bat
if errorlevel 1 (
    echo.
    echo Tests failed - not building. Fix them first, or run pyinstaller by hand.
    pause
    exit /b 1
)

echo.
echo === build ===
if not exist .buildvenv (
    py -3 -m venv .buildvenv || goto :err
    .buildvenv\Scripts\pip install --upgrade pip -q
)
.buildvenv\Scripts\pip install -q -r requirements.txt pyinstaller || goto :err
.buildvenv\Scripts\pyinstaller --noconfirm --onefile --name HyrelAssistant ^
    --add-data "static;static" launcher.py || goto :err

if "%~1"=="" (
    echo.
    echo Built dist\HyrelAssistant.exe
    echo Copy it, plus a filled-in .env, to the Hyrel PC.
    echo Tip: pass a folder to install it directly, e.g.
    echo     build_exe.bat C:\hyrel-assistant
    pause
    exit /b 0
)

echo.
echo === install into %~1 ===
tasklist /fi "imagename eq HyrelAssistant.exe" | find /i "HyrelAssistant.exe" >nul
if not errorlevel 1 (
    echo The app is running from that folder. Close its console window and re-run.
    pause
    exit /b 1
)
if not exist "%~1" mkdir "%~1"
if exist "%~1\HyrelAssistant.exe" move /y "%~1\HyrelAssistant.exe" "%~1\HyrelAssistant-previous.exe" >nul
copy /y dist\HyrelAssistant.exe "%~1\HyrelAssistant.exe" >nul || goto :err
echo Installed. Previous build kept as HyrelAssistant-previous.exe
echo Your data\ folder was not touched.
pause
exit /b 0

:err
echo.
echo Build failed - see messages above.
pause
exit /b 1
