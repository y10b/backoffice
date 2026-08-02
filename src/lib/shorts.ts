import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

/**
 * 쇼츠 렌더링. ffmpeg 로 9:16 세로 영상을 만든다.
 *
 * Vercel 서버리스에서는 못 돈다. 바이너리 크기와 실행 시간 제한 때문이라, 이 기능은
 * 로컬 전용이다. ffmpeg 가 없으면 그 사실을 문구로 분명히 알린다.
 *
 * 화면 구성은 위아래 여백을 둔 형태다.
 *   ┌──────────────┐
 *   │  위 여백      │ ← 제목 / 후킹 문구
 *   │  영상 (16:9)  │
 *   │  아래 여백    │ ← 댓글 카드 / 자막
 *   └──────────────┘
 */

export const OUT_DIR = path.join(process.cwd(), "data", "shorts");
export const FONT_DIR = path.join(process.cwd(), "data", "fonts");
export const WIDTH = 1080;
export const HEIGHT = 1920;

/**
 * 자막용 폰트 후보. 앞에서부터 존재하는 것을 쓴다.
 *
 * Windows 의 ffmpeg 는 fontconfig 가 없어 `drawtext` 에 파일 경로를 직접 줘야 한다.
 * 안 주면 "Fontconfig error: Cannot load default config file" 로 렌더가 통째로 실패한다.
 *
 * Pretendard 를 먼저 두는 이유: 영상 자막은 작은 화면에서 순간적으로 읽혀야 해서 획이
 * 굵고 자간이 고른 고딕이 유리하다. Pretendard 는 화면 가독성을 목표로 만들어졌고
 * OFL 이라 상업적 사용에 제약이 없다. 없으면 윈도우 기본 한글 폰트로 떨어진다.
 */
const FONT_CANDIDATES = [
  path.join(FONT_DIR, "Pretendard-ExtraBold.ttf"),
  path.join(FONT_DIR, "Pretendard-Bold.ttf"),
  "C:/Windows/Fonts/malgunbd.ttf",
  "C:/Windows/Fonts/malgun.ttf",
  "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
  "/System/Library/Fonts/AppleSDGothicNeo.ttc",
];

let _fontPath: string | null | undefined;

/**
 * Windows ffmpeg 는 `fontfile=` 값에 한글 같은 비ASCII 경로가 들어가면 파일을 열지 못한다.
 * (`text=` 의 한글은 멀쩡히 나오는데 경로만 안 된다 — 파일 열기 쪽 인코딩 문제다.)
 *
 * 이 프로젝트는 `개인\백오피스` 아래에 있어 그대로 쓰면 항상 실패한다.
 * 그래서 경로에 비ASCII 가 섞여 있으면 임시 폴더로 한 번 복사해 그 사본을 쓴다.
 */
async function asciiSafeFont(src: string): Promise<string> {
  if (/^[\x20-\x7E]*$/.test(src)) return src;

  const dir = path.join(os.tmpdir(), "backoffice-fonts");
  const dst = path.join(dir, path.basename(src));
  try {
    await fs.mkdir(dir, { recursive: true });
    // 이미 같은 크기로 복사돼 있으면 다시 쓰지 않는다
    const [a, b] = await Promise.all([
      fs.stat(src),
      fs.stat(dst).catch(() => null),
    ]);
    if (!b || b.size !== a.size) await fs.copyFile(src, dst);
    return dst;
  } catch {
    // 복사에 실패하면 원본을 그대로 넘긴다. 최소한 시도는 해본다
    return src;
  }
}

async function fontPath(): Promise<string | null> {
  if (_fontPath !== undefined) return _fontPath;
  for (const p of FONT_CANDIDATES) {
    try {
      await fs.access(p);
      _fontPath = await asciiSafeFont(p);
      return _fontPath;
    } catch {
      /* 다음 후보 */
    }
  }
  _fontPath = null;
  return null;
}

/**
 * 필터 값으로 들어갈 파일 경로를 감싼다.
 *
 * `C:\Windows\Fonts\malgun.ttf` 를 그대로 넣으면 `:` 를 옵션 구분자로,
 * `\` 를 이스케이프로 읽어 필터가 깨진다. 슬래시로 바꾸고 드라이브 콜론만 이스케이프한다.
 */
export function escapeFontPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** 시간축이 붙은 자막 한 줄. 출력 영상 기준 초 */
export type Caption = { start: number; end: number; text: string };

/** 원본에서 잘라낼 구간 하나 */
export type Segment = { start: number; duration: number };

export type RenderOptions = {
  /** 원본 파일 경로 또는 http(s) 주소. archive.org 직링크를 그대로 넣을 수 있다 */
  input: string;
  /** 잘라낼 시작 지점(초) */
  startSec: number;
  /** 길이(초). 쇼츠는 60초를 넘기지 않는 편이 낫다 */
  durationSec: number;
  /**
   * 여러 구간을 이어 붙인다.
   *
   * 한 구간을 통째로 자르면 25초 내내 같은 장면이라 쇼츠에서 끝까지 안 본다.
   * 원본의 다른 지점들을 골라 이으면 컷이 바뀌어 시선을 붙든다.
   * 비어 있으면 startSec/durationSec 한 구간만 쓴다.
   */
  segments?: Segment[];
  /**
   * 컷 하나의 길이(초). 주면 원본 전체에 이 길이의 컷을 고르게 흩어 segments 를 자동 생성한다.
   * segments 를 직접 준 경우에는 무시된다.
   */
  cutSec?: number;
  /**
   * 시간별 자막. 있으면 caption 대신 이걸 쓴다.
   * 하나짜리 caption 은 처음부터 끝까지 같은 문구라 읽고 나면 볼 게 없다.
   */
  captions?: Caption[];
  /** 줄바꿈으로 나눈 자막 대본. 주면 전체 길이에 고르게 나눠 captions 를 자동 생성한다 */
  script?: string;
  /** 위 여백에 얹을 문구 */
  title?: string;
  /** 아래 여백에 얹을 댓글 (작성자 포함) */
  comment?: { author: string; text: string };
  /** 화면 하단 자막. 시간축 없이 통째로 얹는 단순 형태 */
  caption?: string;
  /** 영상이 차지할 세로 비율 (0.4~0.9). 나머지가 위아래 여백이 된다 */
  videoRatio?: number;
};

export type RenderResult = {
  name: string;
  url: string;
  sizeBytes: number;
  command: string;
};

/**
 * 원본 해상도를 잰다.
 * 레이아웃을 정확히 잡으려면 스케일 후 높이를 알아야 하는데, 그건 원본 비율이 정한다.
 * 실패해도 렌더는 진행한다 — 배치가 조금 어긋날 뿐 결과물은 나온다.
 */
export type MediaInfo = {
  width: number;
  height: number;
  /** 원본 전체 길이(초). 컷을 어디서 뜰지 정하는 데 쓴다 */
  durationSec: number | null;
  /**
   * 오디오 트랙이 있는가.
   *
   * 컷을 이어 붙일 때 concat 필터는 모든 입력의 스트림 구성이 같아야 한다.
   * 무성 영상에 오디오를 요구하면 통째로 실패하므로 미리 확인한다.
   */
  hasAudio: boolean;
};

export async function probeMedia(input: string): Promise<MediaInfo | null> {
  try {
    const out = await run(
      "ffprobe",
      ["-v", "error", "-show_entries",
       "stream=width,height,codec_type:format=duration",
       "-of", "json", input],
      60000,
    );
    const data = JSON.parse(out);
    const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
    const video = streams.find((s) => s?.codec_type === "video" && s?.width);
    if (!video) return null;
    const dur = Number(data?.format?.duration);
    return {
      width: Number(video.width),
      height: Number(video.height),
      durationSec: Number.isFinite(dur) && dur > 0 ? dur : null,
      hasAudio: streams.some((s) => s?.codec_type === "audio"),
    };
  } catch {
    return null;
  }
}

export async function probeSize(
  input: string,
): Promise<{ width: number; height: number } | null> {
  const info = await probeMedia(input);
  return info ? { width: info.width, height: info.height } : null;
}

/** ffmpeg 가 설치돼 있는지. 없으면 무엇을 해야 하는지까지 알려준다 */
export async function checkFfmpeg(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const out = await run("ffmpeg", ["-version"], 15000);
    return { ok: true, version: out.split("\n")[0]?.slice(0, 80) };
  } catch {
    return {
      ok: false,
      error:
        "ffmpeg 를 찾지 못했습니다. Windows 는 `winget install Gyan.FFmpeg` 로 설치한 뒤 새 터미널에서 다시 시도하세요. 배포본(Vercel)에서는 사용할 수 없습니다.",
    };
  }
}

function run(cmd: string, args: string[], timeoutMs = 10 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`시간 초과 (${Math.round(timeoutMs / 1000)}초)`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d.toString()));
    // ffmpeg 는 진행 상황을 stderr 로 낸다. 오류만 있는 게 아니라 정상 로그도 섞인다
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out || err);
      // 마지막 몇 줄에 실제 원인이 담긴다. 전부 넘기면 읽을 수가 없다
      else reject(new Error(err.trim().split("\n").slice(-4).join(" ").slice(0, 400)));
    });
  });
}

/**
 * drawtext 에 넣을 문자열을 감싼다.
 *
 * ffmpeg 필터 문법에서 `:` 는 옵션 구분자, `'` 는 값 경계, `\` 는 이스케이프,
 * `%` 는 시간 포맷 지시자다. 그대로 두면 필터가 통째로 깨지거나 엉뚱하게 해석된다.
 */
export function escapeDrawText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’") // 작은따옴표는 이스케이프가 까다로워 유사 문자로 바꾼다
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** 글자가 화면 밖으로 나가지 않게 대략적인 폭 기준으로 줄바꿈한다 */
export function wrapText(s: string, perLine: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    // 한글은 글자당 폭이 라틴 문자의 약 2배라 가중치를 준다
    const weight = (t: string) => [...t].reduce((n, ch) => n + (/[ -~]/.test(ch) ? 1 : 2), 0);
    if (cur && weight(cur) + weight(w) + 1 > perLine) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * 필터 그래프를 만든다. 순수 함수라 실제 실행 없이 검증할 수 있다.
 *
 * 영상은 가로를 캔버스에 맞추고 비율을 유지한 채 세로 가운데에 놓는다.
 * 위아래 남는 자리가 여백이고, 거기에 글자를 얹는다.
 */
export function buildFilter(
  o: RenderOptions,
  font?: string | null,
  source?: { width: number; height: number } | null,
): string {
  const maxRatio = Math.min(Math.max(o.videoRatio ?? 0.72, 0.4), 0.9);
  const maxH = Math.round(HEIGHT * maxRatio);

  /*
   * 영상이 실제로 차지할 높이.
   *
   * 가로를 1080 에 맞추면 세로는 원본 비율이 정한다. 16:9 원본이면 608px 이라
   * `videoRatio` 가 기대하는 1382px 를 채울 수 없고, 그 차이가 의도치 않은 검은 띠로
   * 남는다. 그래서 원본 크기를 재서 실제 높이로 배치한다.
   *
   * 세로가 더 긴 원본은 상한(maxH)까지만 쓰고 넘치는 부분을 잘라낸다.
   * 원본 크기를 모르면(프로브 실패) 상한을 그대로 가정한다.
   */
  const naturalH = source?.width
    ? Math.round((WIDTH * source.height) / source.width)
    : maxH;
  const videoH = Math.min(naturalH, maxH);

  /*
   * 영상을 세로 정가운데가 아니라 위쪽으로 올린다.
   * 위에는 제목 두세 줄, 아래에는 작성자 + 댓글 네 줄이 들어가 아래가 늘 모자라다.
   */
  const freeH = HEIGHT - videoH;
  const topH = Math.round(freeH * 0.4);

  const parts: string[] = [
    `scale=${WIDTH}:-2`,
    // 세로가 상한을 넘으면 가운데를 남기고 잘라낸다
    ...(naturalH > videoH ? [`crop=${WIDTH}:${videoH}`] : []),
    `pad=${WIDTH}:${HEIGHT}:0:${topH}:color=black`,
  ];

  // 폰트를 못 찾으면 fontfile 을 빼고 시도한다. 리눅스에는 fontconfig 가 있어 그대로 동작한다
  const fontOpt = font ? `:fontfile='${escapeFontPath(font)}'` : "";
  /**
   * span 을 주면 그 구간에만 글자가 뜬다. 시간별 자막이 이걸로 갈린다.
   * enable 값 안의 콤마는 필터 구분자와 충돌하므로 이스케이프해야 한다.
   */
  const draw = (
    text: string,
    y: number,
    size: number,
    color: string,
    span?: { start: number; end: number },
  ) =>
    `drawtext=text='${escapeDrawText(text)}'${fontOpt}:fontcolor=${color}:fontsize=${size}` +
    // 글자가 영상 위에 얹혀도 읽히도록 검은 테두리를 두른다. 자막의 기본기다
    `:borderw=6:bordercolor=black@0.85:x=(w-text_w)/2:y=${y}` +
    (span ? `:enable='between(t\,${span.start}\,${span.end})'` : "");

  if (o.title?.trim()) {
    // 제목 블록을 위 여백 안에서 세로 가운데로. 줄 수가 달라도 균형이 유지된다
    const lines = wrapText(o.title.trim(), 22).slice(0, 3);
    const lineH = 78;
    const startY = Math.max(40, Math.round(topH / 2 - (lines.length * lineH) / 2));
    lines.forEach((line, i) => parts.push(draw(line, startY + i * lineH, 62, "white")));
  }

  /*
   * 자막. 시간별(captions)이 있으면 그걸 쓰고, 없으면 통짜 caption 을 전체 구간에 얹는다.
   * 영상 영역 '안쪽' 하단에 둔다 — 밖의 검은 자리에 놓으면 자막이 아니라 설명글로 보인다.
   */
  const captionLineH = 58;
  const captionBottom = topH + videoH - 40;
  const drawCaption = (text: string, span?: { start: number; end: number }) => {
    const lines = wrapText(text.trim(), 24).slice(0, 2);
    const startY = captionBottom - lines.length * captionLineH;
    lines.forEach((line, i) =>
      parts.push(draw(line, startY + i * captionLineH, 50, "0xFFF07A", span)),
    );
  };

  const captions = effectiveCaptions(o);
  if (captions.length) {
    for (const c of captions) {
      drawCaption(c.text, { start: c.start, end: c.end });
    }
  } else if (o.caption?.trim()) {
    drawCaption(o.caption);
  }

  if (o.comment?.text?.trim()) {
    // 댓글은 아래 여백. 영상 끝에서 조금 띄워야 자막과 붙어 보이지 않는다
    const base = topH + videoH + 70;
    parts.push(draw(`@${o.comment.author}`, base, 40, "0xAAAAAA"));
    wrapText(o.comment.text.trim(), 26)
      .slice(0, 4)
      .forEach((line, i) => parts.push(draw(line, base + 62 + i * 56, 46, "white")));
  }

  return parts.join(",");
}

/**
 * 원본 전체에 컷을 고르게 흩어 놓는다.
 *
 * 한 지점에서 30초를 통째로 뜨면 같은 장면이 계속 나온다. 기록영상은 특히
 * 카메라가 오래 고정돼 있어 더 심하다. 원본의 여러 지점에서 조금씩 떠서 이으면
 * 같은 소재로도 장면이 계속 바뀐다.
 *
 * 맨 앞과 맨 끝은 피한다. 기록영상의 시작은 대개 타이틀 카드나 검은 화면이고,
 * 끝은 엔딩 슬레이트라 화면으로 쓸 게 없다.
 */
export function autoSegments(
  totalSec: number,
  cutSec: number,
  sourceDuration: number | null,
  startSec = 0,
): Segment[] {
  const cut = Math.min(Math.max(cutSec, 1), totalSec);
  const count = Math.max(1, Math.round(totalSec / cut));
  const each = totalSec / count;

  // 원본 길이를 모르면 컷을 흩을 범위를 알 수 없다. 요청받은 지점에서 이어서 뜬다
  if (!sourceDuration || sourceDuration < startSec + totalSec) {
    return Array.from({ length: count }, (_, i) => ({
      start: startSec + i * each,
      duration: each,
    }));
  }

  const from = Math.max(startSec, sourceDuration * 0.05);
  const to = Math.max(from + each, sourceDuration * 0.95 - each);
  const step = count > 1 ? (to - from) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => ({
    start: Math.round((from + i * step) * 100) / 100,
    duration: Math.round(each * 100) / 100,
  }));
}

/** 대본을 줄 단위로 나눠 전체 길이에 고르게 배분한다 */
export function autoCaptions(script: string, totalSec: number): Caption[] {
  const lines = script
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const each = totalSec / lines.length;
  return lines.map((text, i) => ({
    start: Math.round(i * each * 100) / 100,
    // 끝을 다음 줄 시작에 딱 맞추면 전환 순간에 한 프레임씩 자막이 사라진다
    end: Math.round((i + 1) * each * 100) / 100 + 0.05,
    text,
  }));
}

/** 실제로 쓸 구간 목록. segments 도 cutSec 도 없으면 단일 구간으로 되돌린다 */
export function effectiveSegments(o: RenderOptions, source?: MediaInfo | null): Segment[] {
  const list = (o.segments ?? [])
    .map((s) => ({ start: Math.max(0, s.start), duration: s.duration }))
    // 1초 미만 컷은 화면이 스치기만 하고 프레임 하나 못 보여준다
    .filter((s) => Number.isFinite(s.start) && s.duration >= 1);
  if (list.length) return list;

  const total = clampDuration(o.durationSec);
  if (o.cutSec && o.cutSec >= 1) {
    return autoSegments(total, o.cutSec, source?.durationSec ?? null, Math.max(0, o.startSec));
  }
  return [{ start: Math.max(0, o.startSec), duration: total }];
}

/** 실제로 얹을 자막. captions 가 없으면 script 를 시간에 나눠 쓴다 */
export function effectiveCaptions(o: RenderOptions): Caption[] {
  if (o.captions?.length) return o.captions.filter((c) => c.text?.trim());
  if (o.script?.trim()) return autoCaptions(o.script, clampDuration(o.durationSec));
  return [];
}

function clampDuration(sec: number): number {
  return Math.min(Math.max(sec, 1), 180);
}

/**
 * ffmpeg 인자 전체를 만든다. 순수 함수라 실행 없이 검증할 수 있다.
 *
 * 컷이 하나면 `-vf` 한 줄로 끝난다. 여러 개면 같은 입력을 구간 수만큼 열고
 * concat 으로 이어 붙인 뒤 그 결과에 레이아웃·자막 체인을 건다.
 *
 * 입력을 하나만 열고 trim 으로 자르는 방법도 있지만, 그러면 마지막 구간까지
 * 처음부터 디코딩해야 한다. 원본이 20분짜리면 그 값이 크다. 입력마다 `-ss` 를
 * 앞에 두면 구간마다 바로 그 지점으로 탐색한다.
 */
export function buildArgs(
  o: RenderOptions,
  out: string,
  font: string | null,
  source: MediaInfo | null,
): string[] {
  const segments = effectiveSegments(o, source);
  const chain = buildFilter(o, font, source);
  const withAudio = source?.hasAudio !== false;

  const common = [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    // 쇼츠 업로드에서 문제를 덜 일으키는 조합
    "-movflags", "+faststart",
    "-r", "30",
    out,
  ];

  if (segments.length === 1) {
    return [
      "-y",
      // -ss 를 -i 앞에 두면 빠르게 탐색한다. 원격 URL 에서 특히 차이가 크다
      "-ss", String(segments[0].start),
      "-i", o.input,
      "-t", String(clampDuration(segments[0].duration)),
      "-vf", chain,
      ...common,
    ];
  }

  const inputs: string[] = [];
  for (const seg of segments) {
    inputs.push("-ss", String(seg.start), "-t", String(clampDuration(seg.duration)), "-i", o.input);
  }

  /*
   * concat 은 입력들의 해상도·픽셀형식이 같아야 붙는다. 같은 파일에서 잘랐으니
   * 보통 맞지만, setpts 로 타임스탬프를 0 부터 다시 세지 않으면 이어 붙인 뒤
   * 재생 시간이 원본 위치를 그대로 물고 와 앞부분이 비어 보인다.
   */
  const steps: string[] = [];
  const labels: string[] = [];
  segments.forEach((_, i) => {
    steps.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`);
    labels.push(`[v${i}]`);
    if (withAudio) {
      steps.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[a${i}]`);
    }
  });
  const n = segments.length;
  steps.push(
    withAudio
      ? `${labels.join("")}concat=n=${n}:v=1:a=1[cv][ca]`
      : `${labels.join("")}concat=n=${n}:v=1:a=0[cv]`,
  );
  // 자막의 enable=between(t,..) 은 concat 뒤 타임라인 기준이라 이어 붙인 다음에 건다
  steps.push(`[cv]${chain}[vout]`);

  return [
    "-y",
    ...inputs,
    "-filter_complex", steps.join(";"),
    "-map", "[vout]",
    ...(withAudio ? ["-map", "[ca]"] : []),
    ...common,
  ];
}

/**
 * 요청 본문(또는 큐에 저장된 options)을 렌더 옵션으로 정리한다.
 *
 * 라우트 두 곳과 워커가 각자 파싱하면 한쪽에만 필드를 더했을 때 조용히 어긋난다.
 * 실제로 컷·자막을 넣고도 워커가 안 넘겨서 그대로 렌더될 뻔했다.
 */
export function parseRenderOptions(body: any): RenderOptions {
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  return {
    input: String(body?.input ?? "").trim(),
    startSec: Math.max(0, num(body?.startSec, 0)),
    durationSec: Math.min(Math.max(num(body?.durationSec, 30), 1), 180),
    cutSec: body?.cutSec ? Math.min(Math.max(num(body.cutSec, 4), 1), 60) : undefined,
    segments: Array.isArray(body?.segments)
      ? body.segments
          .map((s: any) => ({ start: num(s?.start, 0), duration: num(s?.duration, 0) }))
          .filter((s: Segment) => s.duration >= 1)
      : undefined,
    script: str(body?.script) || undefined,
    captions: Array.isArray(body?.captions)
      ? body.captions
          .map((c: any) => ({ start: num(c?.start, 0), end: num(c?.end, 0), text: str(c?.text) }))
          .filter((c: Caption) => c.text.trim() && c.end > c.start)
      : undefined,
    title: str(body?.title) || undefined,
    caption: str(body?.caption) || undefined,
    comment:
      body?.comment && typeof body.comment.text === "string"
        ? { author: String(body.comment.author ?? ""), text: body.comment.text }
        : undefined,
    videoRatio: body?.videoRatio ? num(body.videoRatio, 0.72) : undefined,
  };
}

export async function renderShort(o: RenderOptions): Promise<RenderResult> {
  const check = await checkFfmpeg();
  if (!check.ok) throw new Error(check.error!);

  // 폰트와 원본 정보를 미리 확보한다. 둘 다 실패해도 렌더는 진행된다
  const [font, source] = await Promise.all([fontPath(), probeMedia(o.input)]);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.mp4`;
  const out = path.join(OUT_DIR, name);

  const args = buildArgs(o, out, font, source);
  await run("ffmpeg", args);

  const stat = await fs.stat(out);
  return {
    name,
    url: `/api/shorts/file/${encodeURIComponent(name)}`,
    sizeBytes: stat.size,
    command: `ffmpeg ${args.join(" ")}`,
  };
}

export async function listShorts(): Promise<
  { name: string; url: string; sizeBytes: number; createdAt: string }[]
> {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const names = await fs.readdir(OUT_DIR);
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".mp4")) continue;
      const stat = await fs.stat(path.join(OUT_DIR, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      out.push({
        name,
        url: `/api/shorts/file/${encodeURIComponent(name)}`,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** 요청받은 이름이 출력 폴더 안의 실제 파일인지 확인한다 (경로 탈출 방어) */
export function resolveShort(name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (!name.endsWith(".mp4")) return null;
  const full = path.resolve(OUT_DIR, name);
  if (!full.startsWith(path.resolve(OUT_DIR) + path.sep)) return null;
  return full;
}
