"""연기하는 2D 캐릭터 + 장소 배경.

캐릭터는 visual 팩토리로 쓴다:
    (0, actor("me", {0: "happy", 2: "shock"}, talk=[0], pose={0: "phone"}), 300, 1560, "none", None)
 - x, y는 '발 위치'가 아니라 이미지 중심이므로 actor는 발이 y에 오도록 내부에서 맞춘다 (anchor="feet")
 - expr: {대사번호: 표정}  표정 = neutral happy angry shock deadpan smug sad love
 - talk: 이 캐릭터가 말하는 대사 번호들 (그 대사 동안 입이 움직임)
 - pose: {대사번호: 포즈}  포즈 = idle phone fists shrug facepalm point
"""
import math
import numpy as np
from PIL import Image, ImageDraw
from assets import W, H, emoji_img, text_img

SKIN = (255, 222, 196)
LOOKS = {
    "me":     dict(hair=(40, 34, 38), style="short", shirt=(70, 110, 230), pants=(40, 44, 70), scale=1.0),
    "she":    dict(hair=(110, 64, 40), style="long", shirt=(255, 140, 180), pants=(70, 70, 110), scale=0.92),
    "ajumma": dict(hair=(120, 100, 150), style="perm", shirt=(150, 60, 90), pants=(60, 40, 60), scale=0.9),
    "guy":    dict(hair=(30, 30, 30), style="short", shirt=(40, 40, 40), pants=(30, 30, 40), scale=1.12, buff=True),
}
CW, CH = 600, 1000  # 캐릭터 캔버스 (발 = 아래 중앙)


def _arm(d, sx, sy, ex, ey, hx, hy, col):
    d.line((sx, sy, ex, ey), fill=col, width=34, joint="curve")
    d.line((ex, ey, hx, hy), fill=col, width=30, joint="curve")
    d.ellipse((ex - 17, ey - 17, ex + 17, ey + 17), fill=col)
    d.ellipse((hx - 22, hy - 22, hx + 22, hy + 22), fill=SKIN)


def draw_char(who, expr="neutral", pose="idle", mouth_open=False, tl=0.0, flip=False):
    L = LOOKS[who]
    im = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = CW // 2
    shake = 6 * math.sin(tl * 60) if expr == "angry" else 0
    jump = -40 * max(0, math.sin(min(tl, 0.3) / 0.3 * math.pi)) if expr == "shock" and tl < 0.3 else 0
    bob = 6 * math.sin(tl * 4)
    oy = bob + jump
    hx, hy, hr = cx + shake, 330 + oy, 150
    bw = 260 if L.get("buff") else 210
    # 다리
    for dx in (-50, 50):
        d.rounded_rectangle((cx + dx - 34, 760 + oy, cx + dx + 34, 990), radius=30, fill=L["pants"])
    # 긴 머리 (뒤)
    if L["style"] == "long":
        d.rounded_rectangle((hx - hr - 10, hy - 60, hx + hr + 10, hy + 230), radius=90, fill=L["hair"])
    # 몸통
    d.rounded_rectangle((cx - bw // 2 + shake, 500 + oy, cx + bw // 2 + shake, 800 + oy), radius=70, fill=L["shirt"])
    # 팔 (포즈)
    sxL, sxR, sy = cx - bw // 2 + 20 + shake, cx + bw // 2 - 20 + shake, 545 + oy
    sw = 10 * math.sin(tl * 30)
    if pose == "fists":
        _arm(d, sxL, sy, sxL - 70, sy - 40 + sw, sxL - 40, sy - 150 + sw, L["shirt"])
        _arm(d, sxR, sy, sxR + 70, sy - 40 - sw, sxR + 40, sy - 150 - sw, L["shirt"])
    elif pose == "phone":
        _arm(d, sxL, sy, sxL - 30, sy + 140, sxL - 20, sy + 250, L["shirt"])
        _arm(d, sxR, sy, sxR + 60, sy + 110, sxR - 10, sy + 20, L["shirt"])
        d.rounded_rectangle((sxR - 60, sy - 70, sxR + 20, sy + 60), radius=14, fill=(30, 30, 40))
        d.rounded_rectangle((sxR - 52, sy - 60, sxR + 12, sy + 48), radius=10, fill=(150, 200, 255))
    elif pose == "shrug":
        _arm(d, sxL, sy, sxL - 110, sy + 40, sxL - 150, sy - 40, L["shirt"])
        _arm(d, sxR, sy, sxR + 110, sy + 40, sxR + 150, sy - 40, L["shirt"])
    elif pose == "point":
        _arm(d, sxL, sy, sxL - 30, sy + 140, sxL - 20, sy + 250, L["shirt"])
        _arm(d, sxR, sy, sxR + 120, sy - 20, sxR + 230, sy - 60, L["shirt"])
    else:  # idle / facepalm (손은 얼굴 위에 나중에)
        _arm(d, sxL, sy, sxL - 30, sy + 140, sxL - 20, sy + 250, L["shirt"])
        _arm(d, sxR, sy, sxR + 30, sy + 140, sxR + 20, sy + 250, L["shirt"])
    # 머리
    face = SKIN if expr != "angry" else (255, 160, 140)
    d.ellipse((hx - hr, hy - hr, hx + hr, hy + hr), fill=face)
    if L["style"] in ("short", "long"):
        d.pieslice((hx - hr - 6, hy - hr - 10, hx + hr + 6, hy + hr - 40), 180, 360, fill=L["hair"])
        d.polygon([(hx - hr + 10, hy - 50), (hx - 40, hy - 70), (hx - hr + 30, hy - 10)], fill=L["hair"])
    elif L["style"] == "perm":
        for i in range(11):
            a = math.pi + math.pi * i / 10
            px, py = hx + (hr + 5) * math.cos(a), hy - 20 + (hr - 10) * math.sin(a)
            d.ellipse((px - 48, py - 48, px + 48, py + 48), fill=L["hair"])
    # 얼굴
    ex, ey, gap = hx, hy + 20, 55
    for s in (-1, 1):
        x = ex + s * gap
        if expr in ("happy", "love"):
            d.arc((x - 26, ey - 22, x + 26, ey + 22), 200, 340, fill=(40, 30, 30), width=9)
        elif expr == "shock":
            d.ellipse((x - 30, ey - 34, x + 30, ey + 34), fill=(255, 255, 255), outline=(40, 30, 30), width=6)
            d.ellipse((x - 9, ey - 9, x + 9, ey + 9), fill=(20, 20, 20))
        elif expr in ("deadpan", "smug"):
            d.line((x - 26, ey, x + 26, ey), fill=(40, 30, 30), width=10)
        else:
            d.ellipse((x - 13, ey - 18, x + 13, ey + 18), fill=(40, 30, 30))
        if expr == "angry":  # 눈썹 안쪽으로 내려감
            d.line((x - s * 40, ey - 60, x + s * 6, ey - 34), fill=(40, 30, 30), width=12)
        elif expr == "sad":
            d.line((x - s * 40, ey - 36, x + s * 6, ey - 58), fill=(40, 30, 30), width=10)
        elif expr == "smug":
            d.line((x - 30, ey - 40, x + 30, ey - 46 + s * 6), fill=(40, 30, 30), width=9)
    if expr in ("happy", "love", "angry"):
        for s in (-1, 1):
            d.ellipse((hx + s * 95 - 26, ey + 30, hx + s * 95 + 26, ey + 56), fill=(255, 130, 140, 160))
    my = ey + 75
    if mouth_open:
        mh = 26 if expr != "shock" else 40
        d.ellipse((hx - 30, my - mh // 2, hx + 30, my + mh // 2), fill=(120, 30, 40))
    elif expr == "shock":
        d.ellipse((hx - 20, my - 22, hx + 20, my + 22), fill=(120, 30, 40))
    elif expr in ("happy", "love"):
        d.arc((hx - 34, my - 30, hx + 34, my + 14), 20, 160, fill=(120, 30, 40), width=9)
    elif expr == "sad":
        d.arc((hx - 30, my - 4, hx + 30, my + 34), 200, 340, fill=(120, 30, 40), width=8)
    elif expr == "smug":
        d.arc((hx - 10, my - 26, hx + 40, my + 8), 20, 140, fill=(120, 30, 40), width=8)
    elif expr == "angry":
        d.rectangle((hx - 34, my - 8, hx + 34, my + 10), fill=(255, 255, 255), outline=(120, 30, 40), width=5)
        for k in (-17, 0, 17):
            d.line((hx + k, my - 8, hx + k, my + 10), fill=(120, 30, 40), width=3)
    else:
        d.line((hx - 26, my, hx + 26, my), fill=(120, 30, 40), width=8)
    if pose == "facepalm":
        d.ellipse((hx - 10, ey - 50, hx + 110, ey + 60), fill=SKIN, outline=(220, 180, 160), width=4)
    # 감정 효과
    if expr == "angry":
        for i in range(3):  # 머리 위 김
            p = (tl * 1.6 + i / 3) % 1
            r = 22 + 30 * p
            px, py = hx + (i - 1) * 90, hy - hr - 20 - 120 * p
            d.ellipse((px - r, py - r, px + r, py + r), fill=(255, 255, 255, int(200 * (1 - p))))
        m = emoji_img("💢", 110)
        im.alpha_composite(m, (int(hx + hr - 40), int(hy - hr - 30)))
    elif expr == "shock":
        m = emoji_img("❗", 120)
        im.alpha_composite(m, (int(hx - 60), int(hy - hr - 160 + 10 * math.sin(tl * 20))))
    elif expr == "love":
        for i in range(2):
            p = (tl * 0.9 + i / 2) % 1
            m = emoji_img("💕", int(70 + 30 * p))
            m.putalpha(m.getchannel("A").point(lambda v: int(v * (1 - p))))
            im.alpha_composite(m, (int(hx + (110 if i else -170)), int(hy - hr - 40 - 160 * p)))
    elif expr == "sad":
        p = (tl * 1.5) % 1
        d.ellipse((hx - gap - 10, ey + 20 + 80 * p, hx - gap + 10, ey + 50 + 80 * p), fill=(120, 190, 255))
    sc = L["scale"]
    if flip:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    if sc != 1.0:
        im = im.resize((int(CW * sc), int(CH * sc)))
    return im


def actor(who, expr=None, talk=(), pose=None, size=0.82, flip=False, start=0):
    """visual 팩토리. expr/pose: {대사번호: 값}. talk: 말하는 대사 번호. start: 이 캐릭터가 등장하는 대사 번호(visual 첫 값과 같게)"""
    expr, pose = expr or {0: "neutral"}, pose or {0: "idle"}
    def make(bt):
        off = bt[start]
        ends = list(bt[1:]) + [bt[-1] + 30]
        def at(table, t):
            v = None
            for b in sorted(table):
                if t >= bt[b] - off:
                    v = table[b]
            return v if v is not None else table[min(table)]
        def fn(tl):
            e, p = at(expr, tl), at(pose, tl)
            talking = any(bt[b] - off <= tl < ends[b] - off - 0.15 for b in talk)
            mouth = talking and int(tl * 9) % 2 == 0
            since = max([tl - (bt[b] - off) for b in expr if tl >= bt[b] - off] or [tl])
            c = draw_char(who, e, p, mouth, since, flip)
            c = c.resize((int(c.width * size), int(c.height * size)))
            out = Image.new("RGBA", (c.width, c.height * 2), (0, 0, 0, 0))  # 중심 = 발 위치
            out.alpha_composite(c, (0, 0))
            return out
        return fn
    return make


# ---------------- 장소 배경 (sc, t) -> RGBA ----------------
_bg = {}


def place_station(sc, t):
    if "station" not in _bg:
        im = Image.new("RGBA", (W, H), (214, 222, 230, 255))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, W, 360), fill=(60, 66, 80))
        for x in range(0, W, 180):
            d.rectangle((x + 60, 0, x + 120, 1380), fill=(190, 200, 210))
        d.rounded_rectangle((300, 500, 780, 620), radius=16, fill=(30, 90, 160))
        im.alpha_composite(text_img("🚉 대구역", size=70, stroke=0), (370, 520))
        d.rectangle((0, 1380, W, H), fill=(150, 150, 160))
        d.rectangle((0, 1380, W, 1420), fill=(250, 210, 40))
        for x in range(0, W, 60):
            d.rectangle((x, 1388, x + 30, 1412), fill=(40, 40, 40))
        _bg["station"] = im
    return _bg["station"].copy()


def place_room_night(sc, t):
    if "room" not in _bg:
        im = Image.new("RGBA", (W, H), (60, 58, 90, 255))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle((620, 420, 980, 820), radius=20, fill=(20, 26, 60), outline=(200, 190, 160), width=14)
        d.line((800, 420, 800, 820), fill=(200, 190, 160), width=10)
        d.ellipse((680, 470, 760, 550), fill=(255, 245, 190))
        d.rectangle((0, 1380, W, H), fill=(120, 90, 70))
        d.rounded_rectangle((60, 1150, 520, 1420), radius=30, fill=(90, 110, 170))
        d.rounded_rectangle((80, 1120, 240, 1200), radius=30, fill=(240, 240, 250))
        _bg["room"] = im
    return _bg["room"].copy()


def place_speedlines(sc, t, base=(80, 20, 30)):
    """만화 집중선 (빡침/충격)"""
    import random
    key = ("speed", base, int(t * 10) % 3)
    if key not in _bg:
        rnd = random.Random(key[2])
        g = np.linspace(0, 1, H)[:, None, None]
        arr = (np.array(base) * (1 - g) + np.array((20, 6, 12)) * g).astype(np.uint8).repeat(W, 1)
        im = Image.fromarray(arr, "RGB").convert("RGBA")
        d = ImageDraw.Draw(im, "RGBA")
        cx, cy, R = W / 2, H * 0.5, 2400
        for i in range(120):
            a = 2 * math.pi * i / 120 + rnd.uniform(-0.01, 0.01)
            w = rnd.uniform(0.004, 0.016)
            r0 = rnd.uniform(380, 620)
            d.polygon([(cx + r0 * math.cos(a), cy + r0 * math.sin(a)),
                       (cx + R * math.cos(a - w), cy + R * math.sin(a - w)),
                       (cx + R * math.cos(a + w), cy + R * math.sin(a + w))], fill=(255, 255, 255, rnd.randint(40, 100)))
        _bg[key] = im
    return _bg[key].copy()


# ---------------- 그림 캐릭터 (cast/ 폴더의 AI 캐릭터 시트) ----------------
import os as _os
CAST_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "cast")
SLOTS = {"neutral": 1, "happy": 2, "phone": 3, "love": 3, "shock": 4, "angry": 5,
         "deadpan": 6, "sad": 7, "smug": 8, "shrug": 8}
NO_FLIP = {8}  # 8번 컷엔 "왜?" 말풍선 글자가 있음
_sprites = {}


def cast_list():
    return sorted(d for d in _os.listdir(CAST_DIR) if _os.path.isdir(_os.path.join(CAST_DIR, d)))


def sprite(who, expr):
    slot = SLOTS.get(expr, expr) if not isinstance(expr, int) else expr
    k = (who, slot)
    if k not in _sprites:
        p = _os.path.join(CAST_DIR, who, f"{slot}.png")
        if not _os.path.exists(p):
            raise SystemExit(f"캐스트 그림 없음: {p} (등록된 캐스트: {cast_list()})")
        _sprites[k] = Image.open(p).convert("RGBA")
    return _sprites[k]


def cast(who, expr=None, talk=(), size=1.35, flip=False, start=0):
    """그림 캐릭터 visual 팩토리 (x, y = 발 위치).
    who: cast/ 폴더 이름 (me, buddy, hunk, she, chic, ajumma...)
    expr: {대사번호: 표정}  표정 = neutral happy phone(=love) shock angry deadpan sad smug(=shrug)
    talk: 말하는 대사 번호들 (그동안 통통 튐)"""
    expr = expr or {0: "neutral"}
    def make(bt):
        off = bt[start]
        ends = list(bt[1:]) + [bt[-1] + 30]
        keys = sorted(expr)
        def fn(tl):
            cur = keys[0]
            for b in keys:
                if tl >= bt[b] - off:
                    cur = b
            e = expr[cur]
            since = tl - max(0, bt[cur] - off)
            im = sprite(who, e)
            s = size * (1 + 0.012 * math.sin(tl * 3))
            dx = dy = 0
            if since < 0.18:                                  # 표정 바뀔 때 '툭'
                s *= 1 + 0.12 * (1 - since / 0.18)
            talking = any(bt[b] - off <= tl < ends[b] - off - 0.12 for b in talk)
            if talking:
                dy -= 14 * abs(math.sin(tl * 13))
            if e == "angry":
                dx += 7 * math.sin(tl * 70)
            if e == "shock" and since < 0.35:
                dy -= 70 * math.sin(since / 0.35 * math.pi)
            if flip and SLOTS.get(e, e) not in NO_FLIP:  # 글자 말풍선이 든 컷은 뒤집지 않음
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
            w, h = int(im.width * s), int(im.height * s)
            im = im.resize((w, h), Image.BILINEAR)
            out = Image.new("RGBA", (w + 40, h * 2), (0, 0, 0, 0))   # 중심 = 발 위치
            fy = int(620 / 640 * h)
            out.alpha_composite(im, (20 + int(dx), max(0, h - fy + int(dy))))
            return out
        return fn
    return make
