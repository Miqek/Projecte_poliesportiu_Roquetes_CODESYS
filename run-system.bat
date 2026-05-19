@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js no esta installat o no es troba al PATH.
    echo Instal·la Node.js 18+ i torna a executar aquest fitxer.
    pause
    exit /b 1
)

if not exist "logs" mkdir "logs"

cd server

if not exist "node_modules" (
    echo Instal·lant dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] No s'han pogut instal·lar les dependencies.
        pause
        exit /b 1
    )
)

start "" cmd /c "timeout /t 2 >nul && start http://127.0.0.1:8090/"

echo.
echo Iniciant bridge HTTP + WebSocket + TCP...
node bridge-server.js

if errorlevel 1 (
    echo.
    echo El servidor s'ha aturat amb error.
    pause
)

endlocal