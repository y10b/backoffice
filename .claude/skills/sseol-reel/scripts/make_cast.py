"""초록 배경(#00FF00) 캐릭터 시트(2줄 x 4칸, 8컷)를 잘라 캐스트로 등록한다.

  python3 make_cast.py SHEET.png NAME [--label "나"]

결과: cast/NAME/1.png ~ 8.png (배경 투명, 발 중심이 캔버스 아래 가운데에 오도록 정렬)
컷 순서 (프롬프트와 동일): 1 기본 2 웃음 3 폰 4 놀람 5 빡침 6 현타 7 슬픔 8 뻔뻔
"""
import argparse, json, os
import numpy as np
from PIL import Image

CAST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cast")
OUT_W, OUT_H, FEET_Y = 560, 640, 620   # 정규화 캔버스와 발바닥 y


def key_green(rgb):
    """초록 크로마키 → 알파 + 가장자리 초록 번짐 제거"""
    a = rgb.astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    greenness = g - np.maximum(r, b)
    alpha = np.clip(1 - (greenness - 50) / 90.0, 0, 1)
    out = np.zeros(rgb.shape[:2] + (4,), np.uint8)
    g2 = np.where(greenness > 0, np.maximum(r, b) + np.minimum(greenness, 20), g)  # despill
    out[..., 0], out[..., 1], out[..., 2] = r, np.clip(g2, 0, 255), b
    out[..., 3] = (alpha * 255).astype(np.uint8)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("name")
    ap.add_argument("--label", default="")
    a = ap.parse_args()
    sheet = np.array(Image.open(a.sheet).convert("RGB"))
    rgba = key_green(sheet)
    h, w = rgba.shape[:2]
    cw, ch = w // 4, h // 2
    out_dir = os.path.join(CAST_DIR, a.name)
    os.makedirs(out_dir, exist_ok=True)
    meta = {"label": a.label, "slots": {}}
    for i in range(8):
        r, c = divmod(i, 4)
        cell = rgba[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw].copy()
        cell[..., 3][cell[..., 3] < 40] = 0
        ys, xs = np.nonzero(cell[..., 3] > 128)
        if len(ys) == 0:
            raise SystemExit(f"{i + 1}번 칸이 비어 있음")
        bottom = ys.max()
        feet = xs[ys > bottom - 40]            # 신발 부근 픽셀로 발 중심 x
        fx = int(np.median(feet))
        img = Image.fromarray(cell, "RGBA")
        canvas = Image.new("RGBA", (OUT_W, OUT_H), (0, 0, 0, 0))
        canvas.alpha_composite(img, (OUT_W // 2 - fx, FEET_Y - bottom)) if OUT_W // 2 - fx >= 0 and FEET_Y - bottom >= 0 \
            else canvas.paste(img, (OUT_W // 2 - fx, FEET_Y - bottom), img)
        canvas.save(os.path.join(out_dir, f"{i + 1}.png"), optimize=True)
        meta["slots"][str(i + 1)] = {"height": int(bottom - ys.min())}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print("등록:", out_dir)


if __name__ == "__main__":
    main()
