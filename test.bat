@echo off
rem Run every test suite. Offline - no API calls, no key needed.
cd /d %~dp0
if not exist .venv (
    py -3 -m venv .venv || goto :nopython
    .venv\Scripts\pip install -q -r requirements.txt
)
set FAILED=0

echo [1/3] smoke_test.py  (app behaviour, tuning loop, path safety)
.venv\Scripts\python smoke_test.py >nul 2>&1
if errorlevel 1 (echo       FAILED & set FAILED=1) else (echo       passed)

where node >nul 2>&1
if errorlevel 1 (
    echo [2/3] test_diff.js       SKIPPED - node not installed
    echo [3/3] test_markdown.js   SKIPPED - node not installed
    goto :done
)

echo [2/3] test_diff.js      (revision diff)
node test_diff.js >nul 2>&1
if errorlevel 1 (echo       FAILED & set FAILED=1) else (echo       passed)

echo [3/3] test_markdown.js  (chat rendering)
node test_markdown.js >nul 2>&1
if errorlevel 1 (echo       FAILED & set FAILED=1) else (echo       passed)

:done
echo.
if "%FAILED%"=="1" (
    echo One or more suites FAILED. Re-run the failing one directly to see why.
    exit /b 1
)
echo All suites passed.
exit /b 0

:nopython
echo ERROR: Python 3 not found.
exit /b 1
