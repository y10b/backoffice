"""썰 릴스 렌더러: 대본 파일(spec) 하나를 받아 1080x1920 릴스 MP4 + 커버 PNG를 만든다.

  python3 render.py SPEC.py --out DIR            # 영상 렌더
  python3 render.py SPEC.py --out DIR --preview  # 장면별 미리보기 한 장(빠름)

대본 형식은 references/spec-format.md 참고. 대사마다 TTS(edge-tts)를 따로 만들고
그 길이에 맞춰 자막·연출 타이밍을 잡는다. TTS 결과는 캐시돼서 다시 렌더할 때 빠르다.
"""
import argparse, asyncio, hashlib, math, os, random, ssl, subprocess, sys, wave
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assets
from assets import (W, H, FPS, SR, CACHE_DIR, text_img, pill, background, paste, ease_out_back,
                    ease_out_cubic, rewind_overlay, synth_fx)

ME, SHE = "ko-KR-InJoonNeural", "ko-KR-SunHiNeural"
# 감정 프리셋: (목소리, 속도, 높낮이, 볼륨). spec의 VOICES로 덮어쓰거나 추가할 수 있다.
PRESETS = {
    "talk":    (ME, "+40%", "+6Hz", "+0%"),     # 기본 수다 (해요체 썰)
    "scream":  (ME, "+30%", "+48Hz", "+40%"),   # 빡쳐서 샤우팅 ("아니 쌰갈!!!")
    "yell":    (ME, "+48%", "+32Hz", "+15%"),   # 흥분
    "rap":     (ME, "+70%", "+14Hz", "+5%"),    # 랩처럼 쏟아내기
    "whisper": (ME, "+12%", "-22Hz", "-35%"),   # 현타 속삭임
    "deadpan": (ME, "+5%", "-30Hz", "+0%"),     # 무표정 현타
    "smug":    (ME, "+28%", "+22Hz", "+0%"),    # 뜸 들이기 / 떡밥
    "tense":   (ME, "+18%", "-20Hz", "+0%"),    # 긴장
    "chill":   (ME, "+18%", "-10Hz", "+0%"),    # 태평
    "plead":   (ME, "+18%", "+38Hz", "+10%"),   # 애원 / 징징
    "she":     (SHE, "+18%", "+15Hz", "+0%"),   # 여자 등장인물 (밝게)
    "ajumma":  (SHE, "-12%", "-38Hz", "+0%"),   # 아주머니 / 무서운 어른
    "guy":     (ME, "+20%", "-35Hz", "+0%"),    # 남자 등장인물 (낮게)
}
LEAD, GAP = 0.04, 0.08


def tts(text, preset, presets):
    voice, rate, pitch, vol = presets[preset]
    h = hashlib.md5(f"{voice}|{rate}|{pitch}|{vol}|{text}".encode()).hexdigest()[:14]
    path = os.path.join(CACHE_DIR, "tts", f"{h}.mp3")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        import edge_tts, edge_tts.communicate as c
        ca = os.environ.get("SSL_CERT_FILE") or ("/root/.ccr/ca-bundle.crt" if os.path.exists("/root/.ccr/ca-bundle.crt") else None)
        if ca:  # 프록시 환경: edge-tts는 certifi만 보므로 CA 번들을 직접 넣어준다
            c._SSL_CTX = ssl.create_default_context(cafile=ca)
        asyncio.run(edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=vol,
                                         proxy=os.environ.get("HTTPS_PROXY")).save(path))
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                         capture_output=True, check=True).stdout
    pcm = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    nz = np.nonzero(np.abs(pcm) > 0.01)[0]
    return pcm[nz[0]:nz[-1] + 1] if len(nz) else pcm


def load_spec(path):
    import characters
    ns = {k: getattr(assets, k) for k in dir(assets) if not k.startswith("_")}
    ns.update({k: getattr(characters, k) for k in dir(characters) if not k.startswith("_")})
    ns.update(ME=ME, SHE=SHE, __file__=path)
    with open(path, encoding="utf-8") as f:
        exec(compile(f.read(), path, "exec"), ns)
    return ns


class Reel:
    def __init__(self, spec):
        self.presets = {**PRESETS, **spec.get("VOICES", {})}
        self.title = pill(spec.get("TITLE", "썰"), size=44, bg=(255, 255, 255))
        self.voices, self.sfx, self.shakes, self.flashes = [], [], [], []
        self.caps, self.vis, self.scenes, self.beat_starts = [], [], [], []
        t = 0.0
        for si, sc in enumerate(spec["SCRIPT"]):
            s0, bts = t, []
            for bi, (say, preset, cap, opt) in enumerate(sc["beats"]):
                b0 = t
                bts.append(b0 - s0)
                if say:
                    if preset not in self.presets:
                        raise SystemExit(f"scene {si} beat {bi}: 알 수 없는 목소리 프리셋 '{preset}'")
                    v = tts(say, preset, self.presets)
                    self.voices.append((b0 + LEAD, v))
                    dur = LEAD + len(v) / SR + opt.get("gap", GAP)
                else:
                    dur = opt["dur"]
                if "sfx" in opt: self.sfx.append((b0, opt["sfx"]))
                if "shake" in opt: self.shakes.append((b0, 0.45, opt["shake"]))
                if "flash" in opt: self.flashes.append((b0, 0.3, opt["flash"]))
                if cap is None:  # 자막 유지하고 이어 말하기
                    self.caps[-1]["t1"] = b0 + dur
                else:
                    img = text_img(cap, size=opt.get("size", 92))
                    if sc.get("cap_box"):  # 밝은 배경: 자막 뒤에 어두운 반투명 박스
                        box = Image.new("RGBA", (img.width + 50, img.height + 20), (0, 0, 0, 0))
                        ImageDraw.Draw(box).rounded_rectangle((0, 0, box.width - 1, box.height - 1), radius=30, fill=(15, 15, 25, 190))
                        box.alpha_composite(img, (25, 10))
                        img = box
                    self.caps.append(dict(t0=b0, t1=b0 + dur, img=img,
                                          y=sc["cap_y"], shake=opt.get("shake", 0)))
                    self.sfx.append((b0, "pop"))
                t += dur
            self.scenes.append((s0, t, sc))
            self.beat_starts.append([s0 + x for x in bts])
            for bi, img, x, y, anim, snd in sc.get("visuals", []):
                if callable(img):  # 대사 타이밍(장면 시작 기준 초 리스트)을 받아 그림/그림함수를 만드는 팩토리
                    img = img(bts)
                self.vis.append(dict(t0=s0 + bts[bi], t1=t, img=img, x=x, y=y, anim=anim,
                                     beats=[s0 + b for b in bts]))
                if snd: self.sfx.append((s0 + bts[bi], snd))
        self.total = t
        self.caps[-1]["t1"] = t + 1
        cs, cb = spec.get("COVER_AT", (0, 1))
        bs = self.beat_starts[cs]
        self.cover_t = (bs[cb] - 0.15) if cb < len(bs) else self.scenes[cs][1] - 0.15

    def frame(self, t):
        s0, s1, sc = next((s for s in self.scenes if s[0] <= t < s[1]), self.scenes[-1])
        pal = sc["pal"]
        canvas = sc.get("bg", background)([s0, s1, *pal], t)  # 장면별 배경 함수 (기본: 빛 번짐)
        for v in self.vis:
            if not (v["t0"] <= t < v["t1"]):
                continue
            tl = t - v["t0"]
            im = v["img"](tl) if callable(v["img"]) else v["img"]
            x, y, s, a = v["x"], v["y"], 1.0, 1.0
            k = min(1.0, tl / 0.3)
            if v["anim"] == "pop":
                s = max(0.05, 0.3 + 0.7 * ease_out_back(k)); a = min(1.0, tl / 0.1)
            elif v["anim"] == "slideL":
                x -= (1 - ease_out_cubic(k)) * W
            elif v["anim"] == "slideR":
                x += (1 - ease_out_cubic(k)) * W
            elif v["anim"] == "slideup":
                y += (1 - ease_out_cubic(k)) * 500; a = min(1.0, tl / 0.15)
            for b in v["beats"]:  # 대사가 바뀔 때마다 '툭' 펀치 줌
                if v["t0"] < b <= t:
                    s *= 1 + 0.07 * math.exp(-(t - b) * 12)
            s *= 1 + 0.015 * math.sin(tl * 3.2)
            paste(canvas, im, x, y, s, a)
        for c in self.caps:
            if not (c["t0"] <= t < c["t1"]):
                continue
            tl = t - c["t0"]
            s = max(0.05, 0.4 + 0.6 * ease_out_back(min(1.0, tl / 0.22)))
            x, y = W // 2, c["y"]
            if c["shake"] and tl < 0.4:
                amp = c["shake"] * (1 - tl / 0.4)
                x += random.uniform(-amp, amp); y += random.uniform(-amp, amp)
            paste(canvas, c["img"], x, y, s, min(1.0, tl / 0.08))
        if sc.get("rewind"):
            canvas.alpha_composite(rewind_overlay(t - s0))
            canvas.alpha_composite(Image.new("RGBA", (W, H), (60, 80, 140, 60)))
        d = ImageDraw.Draw(canvas)  # 상단 진행바 + 타이틀 (인스타 상단 UI 아래)
        d.rounded_rectangle((60, 196, W - 60, 208), radius=6, fill=(255, 255, 255, 50))
        d.rounded_rectangle((60, 196, 60 + int((W - 120) * min(1, t / self.total)), 208), radius=6, fill=(255, 225, 77))
        paste(canvas, self.title, W // 2, 280)
        ox = oy = 0
        for st, du, amp in self.shakes:
            if st <= t < st + du:
                a = amp * (1 - (t - st) / du)
                ox += random.uniform(-a, a); oy += random.uniform(-a, a)
        if ox or oy:
            shifted = Image.new("RGBA", (W, H), pal[1] + (255,))
            shifted.paste(canvas, (int(ox), int(oy)))
            canvas = shifted
        for st, du, col in self.flashes:
            if st <= t < st + du:
                canvas.alpha_composite(Image.new("RGBA", (W, H), col + (int(150 * (1 - (t - st) / du)),)))
        return canvas.convert("RGB")

    def audio(self, path):
        n = int(SR * self.total) + SR
        fx, vo = np.zeros(n), np.zeros(n)
        for tt, kind in self.sfx:
            s = synth_fx(kind); i = int(tt * SR)
            fx[i:i + len(s)] += s[:n - i]
        for tt, v in self.voices:
            i = int(tt * SR)
            vo[i:i + len(v)] += v[:n - i]
        buf = vo / max(1e-6, np.abs(vo).max()) * 0.85 + fx / max(1e-6, np.abs(fx).max()) * 0.26
        pcm = (np.clip(buf, -0.98, 0.98) * 32767).astype(np.int16)
        with wave.open(path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

    def preview(self, path, times=None):
        """기본: 각 대사가 시작하고 0.5초 뒤 화면을 한 장에 모은다"""
        times = times or [b + 0.5 for bs in self.beat_starts for b in bs]
        ims = [self.frame(x).resize((270, 480)) for x in times]
        cols = 8
        sheet = Image.new("RGB", (270 * cols, 480 * math.ceil(len(ims) / cols)), (0, 0, 0))
        for i, im in enumerate(ims):
            sheet.paste(im, ((i % cols) * 270, (i // cols) * 480))
        sheet.save(path)

    def render(self, mp4, cover):
        wav = mp4[:-4] + ".wav"
        self.audio(wav)
        p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                              "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-i", wav,
                              "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-maxrate", "2600k", "-bufsize", "5200k", "-pix_fmt", "yuv420p",
                              "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", mp4],
                             stdin=subprocess.PIPE)
        for i in range(int(self.total * FPS)):
            p.stdin.write(self.frame(i / FPS).tobytes())
        p.stdin.close()
        if p.wait() != 0:
            raise SystemExit("ffmpeg 인코딩 실패")
        os.remove(wav)
        self.frame(self.cover_t).save(cover)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--out", required=True, help="결과물 폴더")
    ap.add_argument("--preview", nargs="*", type=float, help="미리보기만 (초 단위 시각 지정 가능)")
    a = ap.parse_args()
    random.seed(7); np.random.seed(7)
    spec = load_spec(os.path.abspath(a.spec))
    name = spec.get("NAME", os.path.splitext(os.path.basename(a.spec))[0])
    os.makedirs(a.out, exist_ok=True)
    reel = Reel(spec)
    print(f"길이 {reel.total:.1f}초 ({len(reel.scenes)}장면, 대사 {sum(len(b) for b in reel.beat_starts)}개)")
    if reel.total > 75:
        print("⚠️ 75초가 넘음: 대사를 줄이거나 프리셋 속도를 올리는 걸 검토")
    if a.preview is not None:
        out = os.path.join(a.out, f"{name}_preview.png")
        reel.preview(out, a.preview or None)
        print("preview", out)
        return
    mp4, cover = os.path.join(a.out, f"{name}.mp4"), os.path.join(a.out, f"{name}_cover.png")
    reel.render(mp4, cover)
    print("video", mp4)
    print("cover", cover)


if __name__ == "__main__":
    main()
