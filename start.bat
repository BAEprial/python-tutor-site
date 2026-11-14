@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Python 私塾 - starting local server (if needed) and opening the site...
python launcher.py
if errorlevel 1 (
  echo.
  echo Failed to start. Install Python 3 from https://www.python.org/downloads/
  echo and make sure "Add python.exe to PATH" is checked, then run this file again.
  pause
)
