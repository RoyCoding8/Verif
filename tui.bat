@echo off
setlocal
rem Launch the Verity TUI from any cwd. Forwards args and the child's exit code.
rem Each interpreter branch exits outside its block so %ERRORLEVEL% is expanded
rem after the child ran, not when the block was parsed.
set "HERE=%~dp0"

where python >nul 2>nul
if errorlevel 1 goto try_py
python "%HERE%tui.py" %*
exit /b %ERRORLEVEL%

:try_py
where py >nul 2>nul
if errorlevel 1 goto try_python3
py "%HERE%tui.py" %*
exit /b %ERRORLEVEL%

:try_python3
where python3 >nul 2>nul
if errorlevel 1 goto none
python3 "%HERE%tui.py" %*
exit /b %ERRORLEVEL%

:none
echo tui.bat: no python interpreter found on PATH 1>&2
exit /b 1
