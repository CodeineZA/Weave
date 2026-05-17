@echo off
set PORT=3000
set PID=

echo Scanning for processes listening on port %PORT%...

:: Find the PID associated with the port
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R /C:":%PORT% "') do (
    set PID=%%a
)

:: Check if a PID was found
if "%PID%"=="" (
    echo No active process found on port %PORT%.
    echo You are clear to start your server.
    echo.
    pause
    exit /b
)

echo Found process with PID: %PID% holding port %PORT%.
echo Attempting to terminate...

:: Kill the process
taskkill /F /PID %PID%

:: Check if the kill command was successful
if %errorlevel% EQU 0 (
    echo.
    echo Successfully killed process %PID%. Port %PORT% is now free.
) else (
    echo.
    echo Failed to kill process %PID%. 
    echo Please right-click this script and select "Run as Administrator".
)

echo.
pause