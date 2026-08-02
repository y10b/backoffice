/**
 * 쇼츠 렌더 로컬 워커.
 *
 * ffmpeg 는 Vercel 서버리스에서 못 돈다. 그렇다고 영상 기능을 로컬에만 묶어두면
 * 배포본에서는 아무것도 못 한다.
 *
 * 브라우저는 https 페이지에서 http://localhost 를 부를 수 없지만(혼합 콘텐츠 차단),
 * 로컬에서 밖으로 나가는 건 막히지 않는다. 그래서 방향을 뒤집는다.
 *
 *   웹(어디서나)  →  Supabase 큐에 작업 등록
 *   이 워커        →  큐를 폴링해 가져가 렌더 → Storage 업로드 → 상태 갱신
 *
 * 포트 개방도 공인 IP도 필요 없다. 워커가 꺼져 있으면 작업은 큐에 남아 있다가
 * 다시 켜면 처리된다.
 *
 * 실행: npm run worker
 */
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/* ---------------- 설정 ---------------- */

const POLL_MS = 5000;
const BUCKET = "shorts";
const WIDTH = 1080;
const HEIGHT = 1920;

async function loadEnv() {
  // .env.local 을 직접 읽는다. 이 워커는 Next 밖에서 도니 자동 주입이 없다
  try {
    const text = await fs.readFile(".env.local", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i <= 0 || line.trim().startsWith("#")) continue;
      const k = line.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
    }
  } catch {
    /* 환경변수로 직접 넣었을 수도 있다 */
  }
}

/* ---------------- ffmpeg ---------------- */

function run(cmd, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`시간 초과 (${Math.round(timeoutMs / 1000)}초)`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out || err);
      else reject(new Error(err.trim().split("\n").slice(-4).join(" ").slice(0, 400)));
    });
  });
}

const FONT_CANDIDATES = [
  path.join(process.cwd(), "data", "fonts", "Pretendard-ExtraBold.ttf"),
  path.join(process.cwd(), "data", "fonts", "Pretendard-Bold.ttf"),
  "C:/Windows/Fonts/malgunbd.ttf",
  "C:/Windows/Fonts/malgun.ttf",
];

let fontCache;

/**
 * Windows ffmpeg 는 fontfile= 값에 비ASCII 경로가 들어가면 파일을 열지 못한다.
 * (text= 의 한글은 멀쩡한데 경로만 안 된다.) 임시 폴더로 복사해 우회한다.
 */
async function resolveFont() {
  if (fontCache !== undefined) return fontCache;
  for (const p of FONT_CANDIDATES) {
    try {
      await fs.access(p);
      if (/^[\x20-\x7E]*$/.test(p)) return (fontCache = p);
      const dir = path.join(os.tmpdir(), "backoffice-fonts");
      const dst = path.join(dir, path.basename(p));
      await fs.mkdir(dir, { recursive: true });
      const [a, b] = await Promise.all([fs.stat(p), fs.stat(dst).catch(() => null)]);
      if (!b || b.size !== a.size) await fs.copyFile(p, dst);
      return (fontCache = dst);
    } catch {
      /* 다음 후보 */
    }
  }
  return (fontCache = null);
}

const escText = (s) =>
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ")
    .trim();

const escPath = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");

function wrap(s, perLine) {
  const weight = (t) => [...t].reduce((n, ch) => n + (/[ -~]/.test(ch) ? 1 : 2), 0);
  const out = [];
  let cur = "";
  for (const w of String(s).split(/\s+/).filter(Boolean)) {
    if (cur && weight(cur) + weight(w) + 1 > perLine) (out.push(cur), (cur = w));
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

async function probeSize(input) {
  try {
    const out = await run(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
       "-of", "csv=p=0:s=x", input],
      120000,
    );
    const m = /(\d+)x(\d+)/.exec(out.trim());
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

function buildFilter(o, font, source) {
  const maxH = Math.round(HEIGHT * Math.min(Math.max(o.videoRatio ?? 0.72, 0.4), 0.9));
  // 가로를 1080 에 맞추면 세로는 원본 비율이 정한다. 그 값으로 배치해야 검은 띠가 안 생긴다
  const naturalH = source?.width ? Math.round((WIDTH * source.height) / source.width) : maxH;
  const videoH = Math.min(naturalH, maxH);
  const topH = Math.round((HEIGHT - videoH) * 0.4);

  const parts = [
    `scale=${WIDTH}:-2`,
    ...(naturalH > videoH ? [`crop=${WIDTH}:${videoH}`] : []),
    `pad=${WIDTH}:${HEIGHT}:0:${topH}:color=black`,
  ];

  const fontOpt = font ? `:fontfile='${escPath(font)}'` : "";
  const draw = (text, y, size, color) =>
    `drawtext=text='${escText(text)}'${fontOpt}:fontcolor=${color}:fontsize=${size}` +
    `:borderw=6:bordercolor=black@0.85:x=(w-text_w)/2:y=${y}`;

  if (o.title?.trim()) {
    const lines = wrap(o.title.trim(), 22).slice(0, 3);
    const startY = Math.max(40, Math.round(topH / 2 - (lines.length * 78) / 2));
    lines.forEach((l, i) => parts.push(draw(l, startY + i * 78, 62, "white")));
  }
  if (o.caption?.trim()) {
    const lines = wrap(o.caption.trim(), 24).slice(0, 2);
    const startY = topH + videoH - 40 - lines.length * 58;
    lines.forEach((l, i) => parts.push(draw(l, startY + i * 58, 50, "0xFFF07A")));
  }
  if (o.comment?.text?.trim()) {
    const base = topH + videoH + 70;
    parts.push(draw(`@${o.comment.author}`, base, 40, "0xAAAAAA"));
    wrap(o.comment.text.trim(), 26)
      .slice(0, 4)
      .forEach((l, i) => parts.push(draw(l, base + 62 + i * 56, 46, "white")));
  }
  return parts.join(",");
}

async function render(o) {
  const [font, source] = await Promise.all([resolveFont(), probeSize(o.input)]);
  const dir = path.join(process.cwd(), "data", "shorts");
  await fs.mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.mp4`;
  const out = path.join(dir, name);

  await run("ffmpeg", [
    "-y",
    "-ss", String(Math.max(0, o.startSec ?? 0)),
    "-i", o.input,
    "-t", String(Math.min(Math.max(o.durationSec ?? 30, 1), 180)),
    "-vf", buildFilter(o, font, source),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-r", "30",
    out,
  ]);

  return { name, path: out, size: (await fs.stat(out)).size };
}

/* ---------------- 메인 루프 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await loadEnv();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다 (.env.local).");
    process.exit(1);
  }

  try {
    const v = await run("ffmpeg", ["-version"], 15000);
    console.log("ffmpeg:", v.split("\n")[0].slice(0, 60));
  } catch {
    console.error("ffmpeg 를 찾지 못했습니다. PATH 에 있는지 확인하세요.");
    process.exit(1);
  }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const workerId = `${os.hostname()}-${process.pid}`;
  console.log(`워커 시작: ${workerId} · ${POLL_MS / 1000}초마다 큐 확인`);

  let idleLogged = false;
  for (;;) {
    let job = null;
    try {
      const { data, error } = await db.rpc("claim_render_job", { worker: workerId });
      if (error) throw new Error(error.message);
      job = (data ?? [])[0] ?? null;
    } catch (e) {
      console.error("큐 조회 실패:", e.message);
      await sleep(POLL_MS * 3);
      continue;
    }

    if (!job) {
      if (!idleLogged) {
        console.log("대기 중…");
        idleLogged = true;
      }
      await sleep(POLL_MS);
      continue;
    }
    idleLogged = false;

    console.log(`#${job.id} 렌더 시작 · ${String(job.options.input).slice(0, 60)}`);
    const started = Date.now();
    try {
      const r = await render(job.options);

      // Storage 에 올려 배포본에서도 볼 수 있게 한다. 로컬 파일 경로는 웹에서 못 연다
      const bytes = await fs.readFile(r.path);
      const { error: upErr } = await db.storage
        .from(BUCKET)
        .upload(r.name, bytes, { contentType: "video/mp4", upsert: true });
      if (upErr) throw new Error(`업로드 실패: ${upErr.message}`);

      const { data: pub } = db.storage.from(BUCKET).getPublicUrl(r.name);

      await db
        .from("render_jobs")
        .update({
          status: "done",
          result_url: pub.publicUrl,
          result_name: r.name,
          size_bytes: r.size,
          error: "",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      console.log(
        `#${job.id} 완료 · ${Math.round(r.size / 1024)}KB · ${Math.round((Date.now() - started) / 1000)}초`,
      );
    } catch (e) {
      console.error(`#${job.id} 실패:`, e.message);
      await db
        .from("render_jobs")
        .update({
          status: "failed",
          error: String(e.message).slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }
  }
}

main().catch((e) => {
  console.error("워커 종료:", e);
  process.exit(1);
});
