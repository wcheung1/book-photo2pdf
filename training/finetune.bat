@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo 請先雙擊 setup_windows.bat 安裝
  pause
  exit /b 1
)
if "%~1"=="" (
  echo 用法: 將網頁匯出嘅 training_xxx.zip 拖落呢個 finetune.bat 圖示上面
  pause
  exit /b 1
)
set ARGS=
:loop
if "%~1"=="" goto run
set ARGS=%ARGS% --data "%~1"
shift
goto loop
:run
.venv\Scripts\python.exe finetune_corners.py %ARGS% --epochs 40
pause
