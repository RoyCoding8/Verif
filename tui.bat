@echo off
setlocal
rem Launch the Verity TUI from any cwd. Forwards args and the child's exit code.
set "HERE=%~dp0"

where python >nul 2>nul
if not errorlevel 1 (
  python "%HERE%tui.py" %*
  exit /b %ERRORLEVEL%
)
where py >nul 2>nul
if not errorlevel 1 (
  py "%HERE%tui.py" %*
  exit /b %ERRORLEVEL%
)
where python3 >nul 2>nul
if not errorlevel 1 (
  python3 "%HERE%tui.py" %*
  exit /b %ERRORLEVEL%
)

echo tui.bat: no python interpreter found on PATH 1>&2
exit /b 1
