@echo off
setlocal
if defined ECOM_NODE_EXE (
  "%ECOM_NODE_EXE%" "%~dp0scripts\ecom.mjs" %*
  exit /b %ERRORLEVEL%
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Run install.ps1 -InstallSystemDependencies 1>&2
  exit /b 10
)
node "%~dp0scripts\ecom.mjs" %*
exit /b %ERRORLEVEL%
