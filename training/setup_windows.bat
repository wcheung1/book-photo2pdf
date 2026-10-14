@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
echo === 書影 BookScan 微調環境安裝 ===
where py >nul 2>nul
if errorlevel 1 (
  echo 搵唔到 Python。請先安裝 Python 3.12: https://www.python.org/downloads/
  echo 安裝時記得剔 "Add python.exe to PATH"
  pause
  exit /b 1
)
if not exist .venv\Scripts\python.exe (
  py -3.12 -m venv .venv 2>nul || py -3 -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
echo 安裝 PyTorch (CUDA 13.0, 支援 RTX 50 系列)... 要下載幾 GB, 請等等
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130
pip install -r requirements.txt
python -c "import torch;print('GPU:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
echo.
echo 安裝完成。之後將 training_xxx.zip 拖落 finetune.bat 就可以微調。
pause
