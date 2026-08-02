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
 * 렌더 로직은 src/lib/shorts.ts 를 그대로 가져다 쓴다. 여기에 복제해 두면 필터나
 * 레이아웃을 고칠 때 한쪽만 바뀌어 조용히 어긋난다 (Node 22+ 는 .ts 를 직접 읽는다).
 *
 * 실행: npm run worker
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OUT_DIR, checkFfmpeg, renderShort } from "../src/lib/shorts.ts";

const POLL_MS = 5000;
const BUCKET = "shorts";

/** .env.local 을 직접 읽는다. 이 워커는 Next 밖에서 돌아 자동 주입이 없다 */
async function loadEnv() {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await loadEnv();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다 (.env.local).");
    process.exit(1);
  }

  const ff = await checkFfmpeg();
  if (!ff.ok) {
    console.error(ff.error);
    process.exit(1);
  }
  console.log("ffmpeg:", ff.version);

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
      const r = await renderShort({
        input: job.options.input,
        startSec: job.options.startSec ?? 0,
        durationSec: job.options.durationSec ?? 30,
        title: job.options.title || undefined,
        caption: job.options.caption || undefined,
        comment: job.options.comment || undefined,
        videoRatio: job.options.videoRatio || undefined,
      });

      // Storage 에 올려야 배포본에서도 볼 수 있다. 로컬 파일 경로는 웹에서 못 연다
      const bytes = await fs.readFile(path.join(OUT_DIR, r.name));
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
          size_bytes: r.sizeBytes,
          error: "",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      console.log(
        `#${job.id} 완료 · ${Math.round(r.sizeBytes / 1024)}KB · ${Math.round((Date.now() - started) / 1000)}초`,
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
