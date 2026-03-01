@echo off
setlocal

cd /d "%~dp0"

echo [modelrelay] Starting bootstrap...

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
  echo [modelrelay] ERROR: pnpm is not installed or not on PATH.
  echo Install pnpm first: npm install -g pnpm
  exit /b 1
)

if not exist "node_modules" (
  echo [modelrelay] Installing dependencies...
  call pnpm install
  if %errorlevel% neq 0 (
    echo [modelrelay] ERROR: pnpm install failed.
    exit /b 1
  )
)

echo [modelrelay] Running tests...
call pnpm test
if %errorlevel% neq 0 (
  echo [modelrelay] ERROR: tests failed. Server will not start.
  exit /b 1
)

echo [modelrelay] Launching server...
call pnpm start

endlocal
