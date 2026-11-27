@echo off
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-demo.ps1" -Provider deepseek -ResetApiKey
if errorlevel 1 pause
