@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"

set "PY="

rem 1) 本机 DSH 运行时自带的 Python
set "DSHPY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if exist "%DSHPY%" set "PY=%DSHPY%"
if defined PY goto run

rem 2) 系统自带的 py 启动器
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto run

rem 3) PATH 里的 python（Microsoft Store 的占位程序会以 9009 失败，自动跳过）
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto run

echo [x] 没有找到可用的 Python 3
echo     请手动执行: python build-index.py
pause
exit /b 1

:run
echo 使用: %PY%
%PY% "%~dp0build-index.py"
echo.
pause
