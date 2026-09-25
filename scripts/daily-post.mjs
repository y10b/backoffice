/**
 * 티스토리 블로그 초안 한 편. /api/cron/daily-post 와 같은 함수를 부른다.
 * 키워드는 글감 큐 → 유입 신호 → 키워드 풀 → 날짜 시드 순으로 고른다 (src/lib/dailyPost.ts).
 *
 *   node --import ./scripts/ts-register.mjs scripts/daily-post.mjs
 *   ... --verbose   결과 JSON 전체
 *
 * .env.local 을 읽지 않으므로 SUPABASE_* · NAVER_SEARCHAD_* · GEMINI_* 를 환경에 넣고 돌린다.
 *
 * 기본 출력은 한 줄 — 고른 키워드와 숫자. 제목·본문은 백오피스 화면에서 본다.
 */
import { writeDailyPost } from "../src/lib/dailyPost.ts";

const verbose = process.argv.slice(2).includes("--verbose");

const num = (n) => (n === null || n === undefined ? "?" : Number(n).toLocaleString("ko-KR"));

try {
  const r = await writeDailyPost();
  console.log(
    verbose
      ? JSON.stringify(r, null, 2)
      : `- 1편 · ${r.source} · 키워드 "${r.mainKeyword}" (검색 ${num(r.searches)} · 흡수 ${r.absorption ?? "?"}%)` +
          ` · ${r.category}${r.rewriteOf ? " (기존 글 보강)" : ""}`,
  );
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
