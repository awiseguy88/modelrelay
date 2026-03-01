@echo off
setlocal

set "KEEP_OPEN=1"
if /I "%~1"=="--no-pause" set "KEEP_OPEN=0"

set "EXITCODE=0"

cd /d "%~dp0"

echo [modelrelay] Starting bootstrap...

set "PKG_CMD="

where pnpm >nul 2>nul
if %errorlevel% equ 0 (
  set "PKG_CMD=pnpm"
)

if "%PKG_CMD%"=="" (
  where corepack >nul 2>nul
  if errorlevel 1 (
  ) else (
    echo [modelrelay] pnpm not found. Trying corepack pnpm...
    call corepack pnpm --version >nul 2>nul
    if errorlevel 1 (
    ) else (
      set "PKG_CMD=corepack pnpm"
    )
  )
)

if "%PKG_CMD%"=="" (
  where npm >nul 2>nul
  if errorlevel 1 (
  ) else (
    echo [modelrelay] pnpm not found. Falling back to npm scripts.
    set "PKG_CMD=npm"
  )
)

if "%PKG_CMD%"=="" (
  echo [modelrelay] ERROR: pnpm/corepack/npm not found on PATH.
  echo Install Node.js LTS (includes npm), or install pnpm globally.
  set "EXITCODE=1"
  goto :finish
)

if not exist "node_modules" (
  echo [modelrelay] Installing dependencies...
  call %PKG_CMD% install
  if errorlevel 1 (
    echo [modelrelay] ERROR: install failed.
    set "EXITCODE=1"
    goto :finish
  )
)

echo [modelrelay] Running tests...
call %PKG_CMD% test
if errorlevel 1 (
  echo [modelrelay] ERROR: tests failed. Server will not start.
  set "EXITCODE=1"
  goto :finish
)

echo [modelrelay] Launching server...
call %PKG_CMD% start
if errorlevel 1 (
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
