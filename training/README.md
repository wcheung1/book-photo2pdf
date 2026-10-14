# 喺電腦微調「搵書角」模型

目的：用你自己影嘅相（同你調整過嘅角點）再訓練個模型，令佢對你嘅書、你張枱、你嘅影相習慣更準。

你部 RTX 5090 做呢件事好快，幾百張相大約幾分鐘。

## 第一次：安裝（Windows）

1. 安裝 **Python 3.12**：去 https://www.python.org/downloads/ 下載。安裝畫面**一定要剔「Add python.exe to PATH」**。
2. 確保 NVIDIA 顯示卡驅動程式係新嘅（GeForce Experience 或者 NVIDIA App 入面更新）。
3. 喺呢個 `training` 資料夾，雙擊 **`setup_windows.bat`**。佢會：
   - 喺呢度開一個獨立嘅 Python 環境（`.venv` 資料夾，唔會影響你部機其他嘢）
   - 安裝支援 RTX 50 系列嘅 PyTorch 同其他需要嘅套件（要下載幾 GB，等一陣）
   - 最後顯示 `GPU: True NVIDIA GeForce RTX 5090` 就代表成功

## 每次微調

1. 喺網頁每本書：**設定 → 匯出訓練資料（zip）**，得到 `training_書名.zip`。可以匯出幾本書。
2. 將 zip 檔（可以一次揀幾個）**拖落 `finetune.bat` 個圖示上面**。
3. 等佢完成。畫面會顯示「微調前 X px → 最好 Y px」。
   - 數字愈細愈準（單位係 224×224 縮圖上面嘅像素）。
   - 如果新模型冇改善，佢唔會輸出，舊模型照用。
4. 成功嘅話，`models` 資料夾會多咗一個 `corner_ft_日期.onnx`，同埋 `manifest.json` 會更新。
5. 去 GitHub repo → 入 `models` 資料夾 → **Add file → Upload files**，上載呢兩個檔案（覆蓋 `manifest.json`）→ Commit。
6. 等一兩分鐘，重新打開網頁，就會自動用新模型（會重新下載一次，大約 2 MB）。

> 注意：`.venv` 資料夾好大，**唔好**上載去 GitHub。

> 想還原：將 `manifest.json` 入面 `"corner"` 改返做 `"doccornernet_lean.onnx"` 再上載。

## 提示

- 相愈多、情況愈多樣（唔同枱面、光線、角度、封面）就愈好。建議最少 100 張。
- 你**冇改過**嘅相亦會用嚟訓練（當你接受咗自動結果）。如果只想用你調整過嘅，喺命令加 `--only-edited`。
- 想訓練耐啲：`--epochs 60`。
- 唔係 Windows：
  ```
  python3 -m venv .venv && source .venv/bin/activate
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130
  pip install -r requirements.txt
  python finetune_corners.py --data training_書名.zip
  ```
