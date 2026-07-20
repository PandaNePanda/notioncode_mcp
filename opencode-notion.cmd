@echo off
setlocal
set "NOTIONCODE_ROOT=%~dp0"
set "OPENCODE_CONFIG_DIR=%NOTIONCODE_ROOT%state\opencode"
where opencode >nul 2>nul
if errorlevel 1 (
  echo OpenCode was not found in PATH. Install OpenCode and retry. 1>&2
  exit /b 127
)
opencode %*
exit /b %errorlevel%
