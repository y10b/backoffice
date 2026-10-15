"""썰 릴스 공용 그림·소리 도구 (1080x1920, 30fps).
텍스트/이모지 렌더링, 그려진 소품(눈, 휴대폰, 거울, 화장실 표시, 게임 UI...), 배경, 효과음 합성.
"""
import math, re, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1080, 1920, 30
SR = 44100

CACHE_DIR = os.environ.get("SSEOL_CACHE", os.path.expanduser("~/.cache/sseol-reel"))
FONT_DIR = os.path.join(CACHE_DIR, "fonts")
F_BOLD = os.path.join(FONT_DIR, "BlackHanSans.ttf")
F_SOFT = os.path.join(FONT_DIR, "Jua.ttf")
_SYS_EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
F_EMOJI = _SYS_EMOJI if os.path.exists(_SYS_EMOJI) else os.path.join(FONT_DIR, "NotoColorEmoji.ttf")

COLORS = {"w": (255, 255, 255), "y": (255, 225, 77), "r": (255, 77, 77),
          "p": (255, 143, 199), "c": (110, 220, 255), "g": (160, 160, 170)}

_font_cache = {}
def font(path, size):
    k = (path, size)
    if k not in _font_cache:
        _font_cache[k] = ImageFont.truetype(path, size)
    return _font_cache[k]

_emoji_cache = {}
def emoji_img(ch, size):
    k = (ch, size)
    if k not in _emoji_cache:
        f = font(F_EMOJI, 109)
        im = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((80, 80), ch, font=f, embedded_color=True, anchor="mm")
        im = im.crop(im.getbbox())
        r = size / max(im.size)
        _emoji_cache[k] = im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))), Image.LANCZOS)
    return _emoji_cache[k]

def is_emoji(ch):
    cp = ord(ch)
    return cp >= 0x1F000 or 0x2600 <= cp <= 0x27BF or 0x23E9 <= cp <= 0x23FA or cp in (0x2B50, 0x2B55, 0x203C, 0x2049)

def parse(line):
    """'안에 [r:사람이 있었다]' -> [(text, color)]"""
    segs, pos = [], 0
    for m in re.finditer(r"\[(\w):(.*?)\]", line):
        if m.start() > pos:
            segs.append((line[pos:m.start()], "w"))
        segs.append((m.group(2), m.group(1)))
        pos = m.end()
    if pos < len(line):
        segs.append((line[pos:], "w"))
    return segs

def text_img(lines, size=88, fpath=F_BOLD, stroke=9, default="w", max_w=980, spacing=1.28, stroke_fill=(15, 15, 25)):
    if isinstance(lines, str):
        lines = [lines]
    f = font(fpath, size)
    rendered = []
    for line in lines:
        runs = []  # (kind, text, color)
        for txt, col in parse(line):
            col = default if col == "w" else col
            txt = txt.replace("️", "")
            for ch in txt:
                kind = "e" if is_emoji(ch) else "t"
                if runs and runs[-1][0] == kind and runs[-1][2] == col and kind == "t":
                    runs[-1] = (kind, runs[-1][1] + ch, col)
                else:
                    runs.append((kind, ch, col))
        widths = []
        for kind, txt, col in runs:
            widths.append(int(size * 1.08) + 6 if kind == "e" else int(f.getlength(txt)) + stroke)
        lw = sum(widths)
        lh = int(size * spacing)
        im = Image.new("RGBA", (lw + stroke * 2 + 4, lh + stroke * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        x = stroke
        cy = im.height // 2
        for (kind, txt, col), w in zip(runs, widths):
            if kind == "e":
                e = emoji_img(txt, int(size * 1.05))
                im.alpha_composite(e, (x + 3, cy - e.height // 2))
            else:
                d.text((x, cy), txt, font=f, fill=COLORS[col], anchor="lm",
                       stroke_width=stroke, stroke_fill=stroke_fill)
            x += w
        rendered.append(im)
    tw = max(i.width for i in rendered)
    th = sum(i.height for i in rendered) - stroke * 2 * (len(rendered) - 1)
    out = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    y = 0
    for i in rendered:
        out.alpha_composite(i, ((tw - i.width) // 2, y))
        y += i.height - stroke * 2
    if out.width > max_w:
        r = max_w / out.width
        out = out.resize((int(out.width * r), int(out.height * r)), Image.LANCZOS)
    return out

def pill(text, size=46, bg=(255, 225, 77), fg=(20, 20, 30)):
    t = text_img(text, size=size, fpath=F_BOLD, stroke=0, default="w")
    # recolor text by drawing on a pill
    pad_x, pad_y = 34, 14
    im = Image.new("RGBA", (t.width + pad_x * 2, t.height + pad_y * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius=im.height // 2, fill=bg)
    f = font(F_BOLD, size)
    x = pad_x
    for ch in text:
        if is_emoji(ch):
            e = emoji_img(ch, int(size * 1.05))
            im.alpha_composite(e, (x + 3, im.height // 2 - e.height // 2))
            x += int(size * 1.08) + 6
        else:
            d.text((x, im.height // 2), ch, font=f, fill=fg, anchor="lm")
            x += int(f.getlength(ch))
    return im

# ---------------- drawn assets ----------------
def sign_img(kind, s=300):
    """일부러 헷갈리게 만든 네모네모 화장실 표시"""
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=28, fill=(58, 60, 72), outline=(200, 200, 210), width=6)
    fg = (225, 225, 230)
    c = s // 2
    d.rectangle((c - 30, 50, c + 30, 110), fill=fg)          # 네모 머리
    if kind == "A":
        d.rectangle((c - 48, 125, c + 48, 250), fill=fg)      # 네모 몸
    else:
        d.rectangle((c - 48, 125, c + 48, 250), fill=fg)
        d.rectangle((c - 62, 185, c + 62, 200), fill=fg)      # 이게 치마야...?
    return im

def eyes_img(tl, w=820, h=330, stare=False):
    """의심 가득한 아주머니 눈초리. 동공이 좌우로 훑다가 정면 응시."""
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if stare:
        look = 0.0
    else:
        look = math.sin(tl * 5.0) * (1.0 if tl < 1.4 else max(0, 1 - (tl - 1.4) * 2))
    squint = min(1.0, tl / 0.8)
    for i, cx in enumerate((w * 0.27, w * 0.73)):
        cy = h * 0.6
        ew, eh = 300, 170
        box = (cx - ew / 2, cy - eh / 2, cx + ew / 2, cy + eh / 2)
        d.ellipse(box, fill=(250, 250, 250), outline=(30, 20, 20), width=8)
        px = cx + look * 70
        d.ellipse((px - 58, cy - 58, px + 58, cy + 58), fill=(90, 55, 35))
        d.ellipse((px - 30, cy - 30, px + 30, cy + 30), fill=(10, 10, 10))
        d.ellipse((px + 8, cy - 26, px + 24, cy - 10), fill=(255, 255, 255))
        # 윗눈꺼풀 (실눈)
        lid = cy - eh / 2 + eh * (0.18 + 0.32 * squint)
        d.rectangle((cx - ew / 2 - 10, 0, cx + ew / 2 + 10, lid), fill=(0, 0, 0, 0))
        mask = Image.new("L", (w, h), 0)
        md = ImageDraw.Draw(mask)
        md.rectangle((cx - ew / 2 - 12, 0, cx + ew / 2 + 12, lid), fill=255)
        im.paste((0, 0, 0, 0), mask=mask)
        d.line((cx - ew / 2 + 10, lid, cx + ew / 2 - 10, lid), fill=(30, 20, 20), width=12)
        # 눈썹 (안쪽으로 내려간 의심 눈썹)
        inner = 1 if i == 0 else -1
        x_out, x_in = cx - inner * ew * 0.55, cx + inner * ew * 0.45
        d.line((x_out, lid - 70, x_in, lid - 30 + 10 * squint), fill=(40, 25, 20), width=26)
    return im

def mirror_img(face):
    im = Image.new("RGBA", (560, 660), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, 559, 659), radius=40, fill=(205, 175, 120))
    d.rounded_rectangle((26, 26, 533, 633), radius=26, fill=(175, 215, 235))
    d.line((90, 120, 190, 60), fill=(230, 245, 255), width=18)
    d.line((90, 200, 260, 90), fill=(230, 245, 255), width=12)
    e = emoji_img(face, 300)
    im.alpha_composite(e, ((560 - e.width) // 2, (660 - e.height) // 2 + 20))
    return im

def bubble_img(text, side, size=56):
    f = font(F_SOFT, size)
    t = text_img(text, size=size, fpath=F_SOFT, stroke=0, max_w=560)
    pad = 26
    im = Image.new("RGBA", (t.width + pad * 2, t.height + pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    bg = (255, 255, 255) if side == "L" else (255, 226, 60)
    d.rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius=30, fill=bg)
    # 텍스트를 검정으로 다시 그림
    tx = text_img(text, size=size, fpath=F_SOFT, stroke=0, max_w=560)
    arr = np.array(tx)
    arr_rgb = arr[..., :3]
    is_white = (arr_rgb[..., 0] > 200) & (arr_rgb[..., 1] > 200) & (arr_rgb[..., 2] > 200)
    arr[is_white, :3] = (25, 25, 30)
    im.alpha_composite(Image.fromarray(arr), (pad, pad // 2))
    return im

def typing_img(tl):
    im = Image.new("RGBA", (150, 80), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, 149, 79), radius=30, fill=(255, 255, 255))
    for i in range(3):
        a = 0.5 + 0.5 * math.sin(tl * 9 - i * 1.1)
        c = int(120 + 100 * (1 - a))
        d.ellipse((30 + i * 34 - 10, 40 - 10 - a * 6, 30 + i * 34 + 10, 40 + 10 - a * 6), fill=(c, c, c))
    return im

def phone_fn(title, msgs, w=760, h=800):
    """msgs: [(time, side, text)] - time 이전 0.7초 동안 왼쪽 메시지는 '입력중' 표시"""
    bubbles = [(tm, side, bubble_img(tx, side)) for tm, side, tx in msgs]
    head = text_img(title, size=48, fpath=F_SOFT, stroke=0)
    def fn(tl):
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=60, fill=(25, 25, 32))
        d.rounded_rectangle((18, 18, w - 19, h - 19), radius=46, fill=(171, 193, 209))
        d.rounded_rectangle((18, 18, w - 19, 130), radius=46, fill=(150, 172, 190))
        d.rectangle((18, 90, w - 19, 130), fill=(150, 172, 190))
        hh = head.copy()
        arr = np.array(hh); wm = (arr[..., :3].min(axis=2) > 200); arr[wm, :3] = (30, 30, 40); hh = Image.fromarray(arr)
        im.alpha_composite(hh, ((w - hh.width) // 2, 74 - hh.height // 2))
        y = 160
        for tm, side, b in bubbles:
            if tl >= tm:
                k = min(1.0, (tl - tm) / 0.2)
                bb = b if k >= 1 else b.resize((max(1, int(b.width * (0.6 + 0.4 * k))), max(1, int(b.height * (0.6 + 0.4 * k)))))
                x = 44 if side == "L" else w - 44 - bb.width
                im.alpha_composite(bb, (x, y))
                y += b.height + 26
            elif side == "L" and tl >= tm - 0.7:
                im.alpha_composite(typing_img(tl), (44, y))
                break
            else:
                break
        return im
    return fn

# ---------------- render ----------------
def ease_out_back(x):
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2

def ease_out_cubic(x):
    return 1 - (1 - x) ** 3

_bg_cache = {}
def bg(top, bot):
    k = (top, bot)
    if k not in _bg_cache:
        g = np.linspace(0, 1, H)[:, None, None]
        arr = (np.array(top)[None, None] * (1 - g) + np.array(bot)[None, None] * g).astype(np.uint8)
        arr = np.repeat(arr, W, axis=1)
        _bg_cache[k] = Image.fromarray(arr, "RGB").convert("RGBA")
    return _bg_cache[k]

_blob_cache = {}
def blob(col, size=1150):
    """가장자리로 갈수록 투명해지는 둥근 빛 번짐"""
    if col not in _blob_cache:
        r = np.hypot(*np.meshgrid(np.linspace(-1, 1, size), np.linspace(-1, 1, size)))
        a = (np.clip(1 - r, 0, 1) ** 2.2 * 120).astype(np.uint8)
        arr = np.zeros((size, size, 4), np.uint8)
        arr[..., :3] = col; arr[..., 3] = a
        _blob_cache[col] = Image.fromarray(arr, "RGBA")
    return _blob_cache[col]

BLOB_PATHS = [  # (중심 x, 중심 y, 진폭 x, 진폭 y, 속도, 위상)
    (250, 500, 260, 220, 0.23, 0.0),
    (850, 1100, 240, 300, 0.19, 2.1),
    (420, 1600, 300, 200, 0.27, 4.0),
]

def background(sc, t):
    canvas = bg(sc[2], sc[3]).copy()
    for col, (bx, by, ax, ay, sp, ph) in zip(sc[4], BLOB_PATHS):
        paste(canvas, blob(col), bx + ax * math.sin(t * sp * 2 + ph), by + ay * math.cos(t * sp * 1.6 + ph))
    return canvas

def paste(canvas, im, cx, cy, scale=1.0, alpha=1.0):
    if scale != 1.0:
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.BILINEAR)
    if alpha < 1.0:
        im = im.copy()
        a = im.getchannel("A").point(lambda v: int(v * alpha))
        im.putalpha(a)
    x, y = int(cx - im.width / 2), int(cy - im.height / 2)
    sx, sy = max(0, -x), max(0, -y)
    ex, ey = min(im.width, W - x), min(im.height, H - y)
    if ex <= sx or ey <= sy:
        return
    canvas.alpha_composite(im.crop((sx, sy, ex, ey)), (x + sx, y + sy))

# ---------------- audio ----------------
def synth(kind):
    if kind == "pop":
        n = int(SR * 0.08); t = np.arange(n) / SR
        return 0.35 * np.sin(2 * np.pi * (500 + 2500 * t) * t) * np.exp(-t * 45)
    if kind == "whoosh":
        n = int(SR * 0.35); t = np.arange(n) / SR
        noise = np.random.randn(n)
        noise = np.convolve(noise, np.ones(18) / 18, mode="same")
        env = np.sin(np.pi * t / t[-1]) ** 2
        return 0.9 * noise * env
    if kind == "boom":
        n = int(SR * 0.7); t = np.arange(n) / SR
        return 0.9 * np.sin(2 * np.pi * (90 * np.exp(-t * 4) + 40) * t) * np.exp(-t * 5) + 0.15 * np.random.randn(n) * np.exp(-t * 40)
    if kind == "ding":
        n = int(SR * 0.45); t = np.arange(n) / SR
        return 0.22 * (np.sin(2 * np.pi * 1318 * t) + 0.6 * np.sin(2 * np.pi * 1975 * t)) * np.exp(-t * 9)
    if kind == "creak":
        n = int(SR * 0.7); t = np.arange(n) / SR
        f = 180 + 60 * np.sin(2 * np.pi * 7 * t) - 60 * t
        ph = 2 * np.pi * np.cumsum(f) / SR
        saw = 2 * (ph / (2 * np.pi) % 1) - 1
        return 0.25 * saw * np.minimum(1, t * 20) * np.exp(-t * 2)
    raise ValueError(kind)



# ---------------- 팔레트: (그라데이션 위, 아래, 떠다니는 빛 번짐 색 3개) ----------------
NAVY = ((24, 22, 54), (40, 22, 66), ((120, 80, 255), (255, 90, 170), (60, 160, 255)))
DARK = ((8, 8, 16), (22, 14, 30), ((90, 60, 160), (40, 70, 140), (140, 50, 110)))
RED = ((58, 6, 16), (24, 4, 12), ((255, 50, 60), (255, 120, 40), (180, 20, 90)))
TEAL = ((10, 40, 54), (20, 26, 56), ((40, 200, 200), (60, 120, 255), (120, 255, 180)))
PINK = ((60, 14, 44), (30, 10, 40), ((255, 90, 170), (255, 150, 200), (160, 80, 255)))

# ---------------- 추가 소품 ----------------
def phone_from(msgs_by_beat, h=640, start=0, title="썸녀 💘"):
    """대사 타이밍에 맞춰 카톡이 뜨는 휴대폰. msgs_by_beat: [(대사번호, 그 대사 시작 후 초, "L"/"R", 텍스트)]
    start: 이 휴대폰이 등장하는 대사 번호 (visual의 첫 값과 같게)"""
    def make(bt):
        return phone_fn(title, [(bt[b] - bt[start] + dt, side, txt) for b, dt, side, txt in msgs_by_beat], h=h)
    return make

def teaser_card(lines, label="🔜 다음 썰 예고"):
    """다음 썰 예고 카드. lines: 자막 문법 문자열 리스트 (예: ["그 후로", "[r:썸 깨진 썰] 💔"])"""
    w, h = 860, 400
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=40, fill=(20, 20, 30), outline=(255, 225, 77), width=6)
    t = text_img(label, size=56, stroke=0)
    im.alpha_composite(t, ((w - t.width) // 2, 36))
    d.line((80, 130, w - 80, 130), fill=(70, 70, 90), width=3)
    q = text_img(lines, size=92, max_w=w - 80)
    q = q if q.height <= 230 else q.resize((int(q.width * 230 / q.height), 230))
    im.alpha_composite(q, ((w - q.width) // 2, 150 + (230 - q.height) // 2))
    return im

def follow_btn(text="➕ 팔로우"):
    return pill(text, size=72, bg=(255, 70, 130), fg=(255, 255, 255))

def boss_bar(name="화장실 아주머니 [y:Lv.99]"):
    """게임 보스 체력바"""
    w = 900
    im = Image.new("RGBA", (w, 170), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    tag = pill("BOSS", size=44, bg=(220, 30, 40), fg=(255, 255, 255))
    im.alpha_composite(tag, (0, 0))
    n = text_img(name, size=56, stroke=7, max_w=w - tag.width - 30)
    im.alpha_composite(n, (tag.width + 20, (tag.height - n.height) // 2))
    d.rounded_rectangle((0, 100, w - 1, 150), radius=14, fill=(30, 10, 14), outline=(255, 255, 255), width=4)
    d.rounded_rectangle((8, 108, w - 9, 142), radius=10, fill=(230, 30, 50))
    return im

def quest_banner(title="화장실을 찾아라!", sub="[g:제한시간: 얼마 안 남음]", label="⚠️ 긴급 퀘스트 발생"):
    """게임 퀘스트 알림창"""
    w, h = 900, 330
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=26, fill=(25, 18, 8, 235), outline=(255, 200, 60), width=8)
    d.rectangle((0, 70, w, 76), fill=(255, 200, 60))
    t = text_img(label, size=50, stroke=0, default="y")
    im.alpha_composite(t, ((w - t.width) // 2, 10))
    q = text_img(title, size=96, max_w=w - 60)
    im.alpha_composite(q, ((w - q.width) // 2, 100))
    r = text_img(sub, size=46, stroke=0, max_w=w - 60)
    im.alpha_composite(r, ((w - r.width) // 2, 245))
    return im

def choice_menu(opts, pick=None, show_from=1, pick_at=None):
    """게임 선택지. 팩토리라서 visual에 그대로 넣는다.
    opts[i]는 (show_from + i)번째 대사 때 등장하고, pick번째가 선택된다(나머지는 줄 그어짐).
    선택 시점: pick_at(대사 번호)이 있으면 그 대사 시작, 없으면 마지막 선택지 대사 0.5초 뒤 (퀴즈는 pick_at으로 정답 공개 대사 지정)."""
    pick = len(opts) - 1 if pick is None else pick
    rows = [text_img(o, size=62, stroke=6, max_w=820) for o in opts]
    w, rh = 920, 120
    def make(bt):
        shows = [bt[show_from + i] - bt[0] for i in range(len(opts))]
        pick_t = (bt[pick_at] - bt[0]) if pick_at is not None else shows[-1] + 0.5
        def fn(tl):
            im = Image.new("RGBA", (w, 110 + rh * len(opts)), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            d.rounded_rectangle((0, 0, w - 1, im.height - 1), radius=26, fill=(10, 10, 30, 230), outline=(255, 255, 255), width=5)
            im.alpha_composite(text_img("[c:🎮 선택지를 고르시오]", size=46, stroke=0), (40, 22))
            for i, (r, st) in enumerate(zip(rows, shows)):
                if tl < st:
                    continue
                y = 100 + i * rh
                if tl >= pick_t and i == pick:
                    d.rounded_rectangle((20, y, w - 21, y + rh - 14), radius=18, fill=(255, 225, 77, 70), outline=(255, 225, 77), width=4)
                elif tl >= pick_t:
                    d.line((50, y + rh // 2 - 7, w - 50, y + rh // 2 - 7), fill=(255, 80, 80), width=6)
                im.alpha_composite(r, (50, y + (rh - 14 - r.height) // 2))
            return im
        return fn
    return make

_scan = None
def rewind_overlay(tl):
    """⏪ 되감기 화면 효과 (주사선)"""
    global _scan
    if _scan is None:
        _scan = Image.new("RGBA", (W, H * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(_scan)
        for y in range(0, H * 2, 6):
            d.line((0, y, W, y), fill=(0, 0, 0, 70), width=2)
        for y in range(0, H * 2, 420):
            d.rectangle((0, y, W, y + 26), fill=(255, 255, 255, 40))
    off = int(tl * 2600) % H
    return _scan.crop((0, off, W, off + H))

def synth_fx(kind):
    """효과음: pop whoosh boom ding creak beep rewind thud fizz"""
    if kind == "thud":  # 묵직하게 '쿵' (고구마 쌓일 때)
        n = int(SR * 0.3); tt = np.arange(n) / SR
        return 0.8 * np.sin(2 * np.pi * (140 * np.exp(-tt * 12) + 55) * tt) * np.exp(-tt * 14)
    if kind == "fizz":  # 탄산 '치이익' (사이다)
        n = int(SR * 0.9); tt = np.arange(n) / SR
        hiss = np.diff(np.random.randn(n + 1)) * 0.25
        bubbles = (np.random.rand(n) < 0.004) * np.random.rand(n)
        bubbles = np.convolve(bubbles, np.sin(2 * np.pi * 2400 * np.arange(300) / SR) * np.exp(-np.arange(300) / 60), "same")
        return (hiss + bubbles) * np.minimum(1, tt * 25) * np.exp(-tt * 2.2)
    if kind == "beep":
        n = int(SR * 0.4); tt = np.arange(n) / SR
        return 0.5 * np.sin(2 * np.pi * 1000 * tt) * np.minimum(1, np.minimum(tt, tt[-1] - tt) * 200)
    if kind == "rewind":
        n = int(SR * 0.9); tt = np.arange(n) / SR
        f = 900 - 500 * tt + 250 * np.sin(2 * np.pi * 22 * tt)
        ph = 2 * np.pi * np.cumsum(f) / SR
        return 0.3 * np.sign(np.sin(ph)) * np.exp(-tt * 1.5) * np.minimum(1, tt * 30)
    return synth(kind)
