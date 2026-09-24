/**
 * 키워드 풀 수집을 터미널·깃액션에서 돌린다. 화면의 /api/pool/run 과 같은 함수를 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/keywords.mjs <naver|tistory|all>
 *   ... --verbose   결과 JSON 전체
 *
 * .env.local 을 읽지 않으므로 SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 와
 * NAVER_SEARCHAD_* 를 환경에 넣고 돌린다 (설정 표에 키가 있으면 그게 먼저다).
 *
 * 기본 출력은 개수뿐이다. 깃액션 로그는 공개 레포에서 누구나 읽는다 — 키워드는 화면에서 본다.
 */
import { collectKeywords } from "../src/lib/keywordPool.ts";
import { CHANNELS, isChannel } from "../src/lib/seeds.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const [target] = args.filter((a) => !a.startsWith("--"));

if (target !== "all" && !isChannel(target)) {
  console.error("사용법: keywords.mjs <naver|tistory|all> [--verbose]");
  process.exit(1);
}

const channels = target === "all" ? CHANNELS : [target];
let failed = false;

// 한 채널이 실패해도 나머지는 돈다. 실패가 하나라도 있으면 액션을 빨갛게 만든다
for (const channel of channels) {
  try {
    const r = await collectKeywords(channel);
    if (verbose) console.log(JSON.stringify(r, null, 2));
    else {
      const partial = r.errors.length ? ` · 실패 묶음 ${r.errors.length}` : "";
      console.log(
        `- ${channel} · 시드 ${r.seeds.length} · 키워드 ${r.fetched} · 새로 ${r.inserted} · 갱신 ${r.updated}${partial}`,
      );
    }
    if (r.errors.length) failed = true;
  } catch (e) {
    console.error(`- ${channel} · 실패: ${String(e.message ?? e).slice(0, 300)}`);
    failed = true;
  }
}

if (failed) process.exit(1);
