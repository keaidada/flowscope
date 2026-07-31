# Capybara v1.0 - Windows PowerShell Installer
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Capybara v1.0 - Windows Installer" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$FLOWSCOPE_HOME = "D:\tmp\capybara"
$FLOWSCOPE_DATA = "D:\tmp\capybara-data"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Installation directory: $FLOWSCOPE_HOME"
Write-Host "Data directory:        $FLOWSCOPE_DATA"
Write-Host ""

# Create directories
try {
    if (-not (Test-Path "D:\tmp")) {
        Write-Host "Creating D:\tmp..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Path "D:\tmp" -Force | Out-Null
    }
    New-Item -ItemType Directory -Path $FLOWSCOPE_HOME -Force | Out-Null
    New-Item -ItemType Directory -Path $FLOWSCOPE_DATA -Force | Out-Null
    Write-Host "[OK] Directories created" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Cannot create directories: $_" -ForegroundColor Red
    Write-Host "Falling back to script directory..."
    $FLOWSCOPE_HOME = Join-Path $ScriptDir "capybara"
    $FLOWSCOPE_DATA = Join-Path $ScriptDir "capybara-data"
}

# Copy binary
$sourceExe = Join-Path $ScriptDir "capybara.exe"
$destExe = Join-Path $FLOWSCOPE_HOME "capybara.exe"

if (Test-Path $sourceExe) {
    try {
        Copy-Item $sourceExe $destExe -Force
        Write-Host "[OK] capybara.exe installed" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Failed to copy: $_" -ForegroundColor Red
    }
} else {
    Write-Host "[INFO] capybara.exe not found in package" -ForegroundColor Yellow
    Write-Host "       Download from: https://github.com/keaidada/capybara/releases/tag/v1.0"
}

# Add to PATH
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$FLOWSCOPE_HOME*") {
    $answer = Read-Host "Add Capybara to user PATH? (Y/n)"
    if ($answer -eq "" -or $answer -eq "Y" -or $answer -eq "y") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$FLOWSCOPE_HOME", "User")
        Write-Host "[OK] Added to PATH. Restart terminal to take effect." -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Start server: capybara --serve --port 3000 --watch $FLOWSCOPE_DATA"
Write-Host "  Web UI:       http://localhost:3000"
Write-Host ""
