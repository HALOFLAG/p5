@echo off
REM Activate portable Node environment (current cmd session only)
REM Usage: env.bat
set "NODE_DIR=%~dp0tools\node"
if not exist "%NODE_DIR%\node.exe" (
    echo [ERROR] portable Node not found: %NODE_DIR%
    exit /b 1
)
set "PATH=%NODE_DIR%;%PATH%"
echo Node environment activated:
node --version
npm --version