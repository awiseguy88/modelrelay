@echo off
setlocal

set "KEEP_OPEN=1"
if /I "%~1"=="--no-pause" set "KEEP_OPEN=0"

set "EXITCODE=0"

cd /d "%~dp0"

echo [modelrelay] Starting bootstrap...

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
  echo [modelrelay] ERROR: pnpm is not installed or not on PATH.
  echo Install pnpm first: npm install -g pnpm
  set "EXITCODE=1"
  goto :finish
)

if not exist "node_modules" (
  echo [modelrelay] Installing dependencies...
  call pnpm install
  if %errorlevel% neq 0 (
    echo [modelrelay] ERROR: pnpm install failed.
    set "EXITCODE=1"
    goto :finish
  )
)

echo [modelrelay] Running tests...
call pnpm test
if %errorlevel% neq 0 (
  echo [modelrelay] ERROR: tests failed. Server will not start.
  set "EXITCODE=1"
  goto :finish
)

echo [modelrelay] Launching server...
call pnpm start
if %errorlevel% neq 0 (
  set "EXITCODE=%errorlevel%"
)

:finish
if "%KEEP_OPEN%"=="1" (
  echo.
  if "%EXITCODE%"=="0" (
    echo [modelrelay] Process exited. Press any key to close this window.
  ) else (
    echo [modelrelay] Exited with code %EXITCODE%. Press any key to close this window.
  )
  pause >nul
)

endlocal
exit /b %EXITCODE%
