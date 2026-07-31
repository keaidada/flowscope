@echo off
setlocal enabledelayedexpansion
title Capybara v1.0 Installer

echo ============================================
echo   Capybara v1.0 - Windows Installer
echo ============================================
echo.

:: Default installation directory
set FLOWSCOPE_HOME=D:\tmp\capybara
set FLOWSCOPE_DATA=D:\tmp\capybara-data

echo Installation directory: %FLOWSCOPE_HOME%
echo Data directory:        %FLOWSCOPE_DATA%
echo.

:: Create directories if not exists
if not exist "D:\tmp" (
    echo Creating D:\tmp...
    mkdir "D:\tmp" 2>nul
    if errorlevel 1 (
        echo [WARN] Cannot create D:\tmp. Using current directory.
        set FLOWSCOPE_HOME=%~dp0capybara
        set FLOWSCOPE_DATA=%~dp0capybara-data
    )
)

if not exist "%FLOWSCOPE_HOME%" mkdir "%FLOWSCOPE_HOME%"
if not exist "%FLOWSCOPE_DATA%" mkdir "%FLOWSCOPE_DATA%"

:: Check for existing installation
if exist "%FLOWSCOPE_HOME%\capybara.exe" (
    echo Existing installation found.
    choice /C YN /M "Overwrite existing installation?"
    if errorlevel 2 goto :skip_install
    echo Removing old installation...
    del /Q "%FLOWSCOPE_HOME%\capybara.exe" 2>nul
)

:install
echo.
echo Installing Capybara v1.0...
echo.

:: Copy binary from package
if exist "%~dp0capybara.exe" (
    echo Copying capybara.exe...
    copy /Y "%~dp0capybara.exe" "%FLOWSCOPE_HOME%\capybara.exe" >nul
    if errorlevel 1 (
        echo [ERROR] Failed to copy capybara.exe
        goto :error
    )
) else (
    echo [INFO] capybara.exe not found in package.
    echo [INFO] Please download capybara.exe from:
    echo        https://github.com/keaidada/capybara/releases/tag/v1.0
    echo [INFO] and place it in %FLOWSCOPE_HOME%
)

:: Create launcher script
echo @echo off > "%FLOWSCOPE_HOME%\capybara.bat"
echo set FLOWSCOPE_DATA=%FLOWSCOPE_DATA% >> "%FLOWSCOPE_HOME%\capybara.bat"
echo "%FLOWSCOPE_HOME%\capybara.exe" %%* >> "%FLOWSCOPE_HOME%\capybara.bat"

:: Create serve mode script
echo @echo off > "%FLOWSCOPE_HOME%\capybara-serve.bat"
echo set FLOWSCOPE_DATA=%FLOWSCOPE_DATA% >> "%FLOWSCOPE_HOME%\capybara-serve.bat"
echo "%FLOWSCOPE_HOME%\capybara.exe" --serve --port 3000 --watch "%FLOWSCOPE_DATA%" %%* >> "%FLOWSCOPE_HOME%\capybara-serve.bat"

:: Create analyze script
echo @echo off > "%FLOWSCOPE_HOME%\capybara-analyze.bat"
echo set FLOWSCOPE_DATA=%FLOWSCOPE_DATA% >> "%FLOWSCOPE_HOME%\capybara-analyze.bat"
echo "%FLOWSCOPE_HOME%\capybara.exe" analyze %%* >> "%FLOWSCOPE_HOME%\capybara-analyze.bat"

:: Add to user PATH
echo.
choice /C YN /M "Add Capybara to user PATH?"
if errorlevel 2 goto :skip_path

:: Check if already in PATH
echo %PATH% | findstr /I /C:"%FLOWSCOPE_HOME%" >nul
if errorlevel 1 (
    echo Adding %FLOWSCOPE_HOME% to PATH...
    setx PATH "%PATH%;%FLOWSCOPE_HOME%" >nul
    if errorlevel 1 (
        echo [WARN] Failed to update PATH. You may need to add it manually:
        echo        %FLOWSCOPE_HOME%
    ) else (
        echo [OK] Added to PATH. Restart terminal to take effect.
    )
) else (
    echo [OK] Already in PATH.
)

:skip_path
echo.
echo ============================================
echo   Installation Complete!
echo ============================================
echo.
echo   Capybara home:  %FLOWSCOPE_HOME%
echo   Data directory:  %FLOWSCOPE_DATA%
echo.
echo   Quick start:
echo     capybara --help
echo     capybara analyze [file.sql]
echo     capybara --serve --port 3000 --watch %FLOWSCOPE_DATA%
echo.
echo   For web UI, open http://localhost:3000 after starting serve mode.
echo ============================================
goto :end

:error
echo.
echo [ERROR] Installation failed!
pause
exit /b 1

:end
endlocal
pause
