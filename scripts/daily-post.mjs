/**
 * 채널 하나에 블로그 초안 한 편. /api/cron/daily-post 와 같은 함수를 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/daily-post.mjs <naver|tistory> [시드]
 *   ... --verbose   결과 JSON 전체
 *
 * .env.local 을 읽지 않으므로 SUPABASE_* · NAVER_SEARCHAD_* · GEMINI_* 를 환경에 넣고 돌린다.
 *
 * 기본 출력은 한 줄 — 채널과 고른 키워드, 숫자. 제목·본문은 백오피스 화면에서 본다.
 */
import { writeDailyPost } from "../src/lib/dailyPost.ts";
import { isChannel } from "../src/lib/seeds.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const [channel, seed] = args.filter((a) => !a.startsWith("--"));

if (!isChannel(channel)) {
  console.error("사용법: daily-post.mjs <naver|tistory> [시드] [--verbose]");
  process.exit(1);
}

const num = (n) => (n === null || n === undefined ? "?" : Number(n).toLocaleString("ko-KR"));

try {
  const r = await writeDailyPost(channel, { seed: seed || undefined });
  console.log(
    verbose
      ? JSON.stringify(r, null, 2)
      : `- ${channel} · 1편 · 키워드 "${r.mainKeyword}" (검색 ${num(r.searches)} · 흡수 ${r.absorption ?? "?"}%)`,
  );
} catch (e) {
  console.error(`- ${channel} · 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
