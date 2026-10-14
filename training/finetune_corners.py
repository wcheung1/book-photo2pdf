#!/usr/bin/env python3
"""
書影 BookScan — 用你自己嘅相微調「搵書角」AI 模型

用法（喺 training 資料夾入面）：
    python finetune_corners.py --data training_書名.zip
    python finetune_corners.py --data a.zip --data b.zip --epochs 40

做咩：
  1. 讀 app 匯出嘅訓練資料（相片 + 你確認過 / 調整過嘅四隻角）
  2. 將現有模型 (models/manifest.json 指定嗰個) 轉成 PyTorch
  3. 用你嘅相訓練（有 NVIDIA GPU 就自動用）
  4. 用預留嘅驗證相比較新舊模型；新模型準啲先會輸出
  5. 輸出 models/corner_ft_日期.onnx，同埋更新 models/manifest.json
之後將呢兩個檔案上載去 GitHub 嘅 models 資料夾就用得。
"""
import argparse, datetime, hashlib, io, json, math, os, random, sys, zipfile

import numpy as np
import cv2
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn
from onnx2torch import convert

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.normpath(os.path.join(HERE, '..', 'models'))
S = 224
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


# ---------------------------------------------------------------- 資料
def load_items(zips, only_edited):
    items = []
    for zp in zips:
        with zipfile.ZipFile(zp) as z:
            meta = json.loads(z.read('labels.json').decode('utf-8'))
            for it in meta['items']:
                if only_edited and not it.get('edited'):
                    continue
                q = it.get('quad')
                if not q or len(q) != 8:
                    continue
                # 成幅相（搵唔到書）嘅唔要
                if np.allclose(q, [0, 0, 1, 0, 1, 1, 0, 1], atol=1e-3):
                    continue
                buf = np.frombuffer(z.read(it['file']), np.uint8)
                img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
                if img is None:
                    continue
                img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                h, w = img.shape[:2]
                pts = np.array(q, np.float32).reshape(4, 2) * [w, h]
                key = hashlib.md5((zp + it['file']).encode()).hexdigest()
                items.append({'img': img, 'pts': pts, 'key': key, 'edited': bool(it.get('edited'))})
    return items


def order_tl_tr_br_bl(p):
    c = p.mean(0)
    ang = np.arctan2(p[:, 1] - c[1], p[:, 0] - c[0])
    p = p[np.argsort(ang)]
    k = np.argmin(p[:, 0] + p[:, 1])
    return np.roll(p, -k, axis=0)


def augment(img, pts, rng):
    h, w = img.shape[:2]
    # 隨機透視 / 旋轉 / 縮放 / 平移，確保四隻角仲喺相入面
    for _ in range(10):
        ang = rng.uniform(-12, 12)
        sc = rng.uniform(0.8, 1.12)
        M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, sc)
        M[:, 2] += [rng.uniform(-0.08, 0.08) * w, rng.uniform(-0.08, 0.08) * h]
        H = np.vstack([M, [0, 0, 1]]).astype(np.float64)
        jit = rng.uniform(-0.04, 0.04, (4, 2)) * [w, h]
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        P = cv2.getPerspectiveTransform(src, (src + jit).astype(np.float32)).astype(np.float64)
        T = P @ H
        q = cv2.perspectiveTransform(pts[None].astype(np.float64), T)[0]
        if (q[:, 0] > -0.01 * w).all() and (q[:, 0] < 1.01 * w).all() and (q[:, 1] > -0.01 * h).all() and (q[:, 1] < 1.01 * h).all():
            border = tuple(int(x) for x in rng.integers(0, 255, 3))
            img = cv2.warpPerspective(img, T, (w, h), borderMode=cv2.BORDER_REFLECT if rng.random() < 0.5 else cv2.BORDER_CONSTANT, borderValue=border)
            pts = q.astype(np.float32)
            break
    if rng.random() < 0.5:  # 左右鏡像
        img = img[:, ::-1].copy()
        pts = pts.copy(); pts[:, 0] = w - pts[:, 0]
        pts = order_tl_tr_br_bl(pts)
    img = img.astype(np.float32)
    img = img * rng.uniform(0.7, 1.3) + rng.uniform(-30, 30)                      # 光暗 / 對比
    gray = img.mean(2, keepdims=True); img = gray + (img - gray) * rng.uniform(0.6, 1.4)  # 飽和度
    img = img * rng.uniform(0.9, 1.1, 3)                                             # 色溫
    if rng.random() < 0.3:
        img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.5, 2.0))
    if rng.random() < 0.4:
        img = img + rng.normal(0, rng.uniform(2, 8), img.shape)
    return np.clip(img, 0, 255).astype(np.uint8), pts


def to_input(img):
    h, w = img.shape[:2]
    x = cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    return (x - MEAN) / STD  # NHWC, 同網頁版一樣將成幅相拉成 224×224


class DS(torch.utils.data.Dataset):
    def __init__(self, items, train, seed=0):
        self.items, self.train, self.seed = items, train, seed

    def __len__(self):
        return len(self.items) * (8 if self.train else 1)

    def __getitem__(self, i):
        it = self.items[i % len(self.items)]
        img, pts = it['img'], it['pts']
        if self.train:
            rng = np.random.default_rng(random.getrandbits(32))
            img, pts = augment(img, pts, rng)
        h, w = img.shape[:2]
        y = (pts / [w, h]).reshape(-1).astype(np.float32)
        return torch.from_numpy(to_input(img)), torch.from_numpy(y)


# ---------------------------------------------------------------- 評估
def corner_err(pred, y):
    # 平均角點誤差（以 224 格計嘅像素）
    d = (pred.view(-1, 4, 2) - y.view(-1, 4, 2)) * S
    return d.norm(dim=-1).mean().item()


@torch.no_grad()
def evaluate(model, loader, dev):
    model.eval(); tot, n = 0.0, 0
    for x, y in loader:
        x, y = x.to(dev), y.to(dev)
        out = model(x)
        coords = out[0] if isinstance(out, (tuple, list)) else out
        tot += corner_err(coords, y) * len(x); n += len(x)
    return tot / max(1, n)


def main():
    ap = argparse.ArgumentParser(description='微調書角偵測模型')
    ap.add_argument('--data', action='append', required=True, help='app 匯出嘅 training_*.zip（可以寫幾次）')
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--lr', type=float, default=1e-4)
    ap.add_argument('--batch', type=int, default=32)
    ap.add_argument('--only-edited', action='store_true', help='只用你手動調整過嘅相')
    ap.add_argument('--val', type=float, default=0.12, help='留幾多比例做驗證')
    ap.add_argument('--base', default=None, help='基礎模型（預設用 manifest.json 指定嗰個）')
    ap.add_argument('--force', action='store_true', help='就算冇改善都輸出')
    a = ap.parse_args()

    random.seed(0); torch.manual_seed(0)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'用 {"GPU：" + torch.cuda.get_device_name(0) if dev == "cuda" else "CPU（會慢好多）"}')

    man_path = os.path.join(MODELS, 'manifest.json')
    manifest = json.load(open(man_path, encoding='utf-8')) if os.path.exists(man_path) else {'corner': 'doccornernet_lean.onnx', 'uvdoc': 'uvdoc.onnx'}
    base = a.base or os.path.join(MODELS, manifest['corner'])
    print('基礎模型：', base)

    items = load_items(a.data, a.only_edited)
    if len(items) < 8:
        sys.exit(f'得 {len(items)} 張可用嘅相，太少喇（最少 8 張，建議 100 張以上）。')
    is_val = [int(it['key'][:6], 16) / 0xFFFFFF < a.val for it in items]
    if not any(is_val):
        is_val = [i < max(1, len(items) // 8) for i in range(len(items))]
    val = [it for it, v in zip(items, is_val) if v]
    tr = [it for it, v in zip(items, is_val) if not v]
    print(f'訓練 {len(tr)} 張，驗證 {len(val)} 張（其中手動調整過 {sum(i["edited"] for i in items)} 張）')

    model = convert(onnx.load(base)).to(dev)
    # 確認轉換冇問題
    sess = ort.InferenceSession(base, providers=['CPUExecutionProvider'])
    x0 = torch.from_numpy(to_input(tr[0]['img']))[None]
    ref = sess.run(None, {sess.get_inputs()[0].name: x0.numpy()})[0]
    with torch.no_grad():
        got = model(x0.to(dev))
    got = (got[0] if isinstance(got, (tuple, list)) else got).cpu().numpy()
    print('轉換檢查（應該好細）：', float(np.abs(ref - got).max()))

    tl = torch.utils.data.DataLoader(DS(tr, True), batch_size=a.batch, shuffle=True, num_workers=0 if os.name == 'nt' else min(8, os.cpu_count() or 1), drop_last=len(tr) * 8 > a.batch, persistent_workers=False)
    vl = torch.utils.data.DataLoader(DS(val, False), batch_size=64)
    before = evaluate(model, vl, dev)
    print(f'微調前驗證誤差：{before:.2f} px（224 格）')

    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    steps = a.epochs * len(tl)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=max(1, steps), pct_start=0.1)
    best, best_state = before, {k: v.detach().clone() for k, v in model.state_dict().items()}
    for ep in range(a.epochs):
        model.train(); run = 0.0
        for x, y in tl:
            x, y = x.to(dev), y.to(dev)
            out = model(x)
            coords = out[0] if isinstance(out, (tuple, list)) else out
            loss = nn.functional.smooth_l1_loss(coords * S, y * S, beta=2.0)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            run += loss.item()
        err = evaluate(model, vl, dev)
        flag = ''
        if err < best:
            best, best_state, flag = err, {k: v.detach().clone() for k, v in model.state_dict().items()}, '  ← 最好'
        print(f'第 {ep + 1}/{a.epochs} 輪  訓練損失 {run / max(1, len(tl)):.3f}  驗證誤差 {err:.2f} px{flag}')

    print(f'\n微調前 {before:.2f} px → 最好 {best:.2f} px')
    if best >= before and not a.force:
        print('冇改善，唔輸出新模型。可以試多啲相、多啲輪數（--epochs），或者用 --force。')
        return
    model.load_state_dict(best_state); model.eval().cpu()
    name = 'corner_ft_' + datetime.datetime.now().strftime('%Y%m%d_%H%M') + '.onnx'
    out = os.path.join(MODELS, name)
    dummy = torch.zeros(1, S, S, 3)
    torch.onnx.export(model, dummy, out, input_names=['input'], output_names=['coords', 'score_logit'], opset_version=17, dynamo=False)
    # 驗證輸出檔
    s2 = ort.InferenceSession(out, providers=['CPUExecutionProvider'])
    o = s2.run(None, {'input': x0.numpy()})
    with torch.no_grad():
        t = model(x0)
    t = (t[0] if isinstance(t, (tuple, list)) else t).numpy()
    print('匯出檢查（應該好細）：', float(np.abs(o[0] - t).max()), ' 輸出：', [x.shape for x in o])
    manifest['corner'] = name
    json.dump(manifest, open(man_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'\n完成！新模型：{out}\n已更新：{man_path}')
    print('下一步：將呢兩個檔案上載去 GitHub repo 嘅 models 資料夾（覆蓋 manifest.json）。')


if __name__ == '__main__':
    main()
