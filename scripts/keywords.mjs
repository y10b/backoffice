/**
 * 키워드 풀 수집을 터미널·깃액션에서 돌린다. 화면의 /api/pool/run 과 같은 함수를 부른다.
 * 시드는 티스토리 것뿐이다 (네이버는 방문 후기 레인이 담당한다).
 *
 *   node --import ./scripts/ts-register.mjs scripts/keywords.mjs
 *   ... --verbose   결과 JSON 전체
 *
 * .env.local 을 읽지 않으므로 SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 와
 * NAVER_SEARCHAD_* 를 환경에 넣고 돌린다 (설정 표에 키가 있으면 그게 먼저다).
 *
 * 수집 뒤에 /eat 의 "목록 밖 음식 찾기"(discoverFoods)도 돈다. 그쪽이 실패해도 키워드
 * 수집 결과로만 성공·실패를 정한다 — 음식 찾기는 모델 키가 필요해 더 잘 깨진다.
 *
 * 기본 출력은 개수뿐이다. 깃액션 로그는 공개 레포에서 누구나 읽는다 — 키워드는 화면에서 본다.
 */
import { collectKeywords } from "../src/lib/keywordPool.ts";
import { discoverFoods } from "../src/lib/foodDiscover.ts";

const verbose = process.argv.slice(2).includes("--verbose");

/** 음식 찾기. 실패하면 한 줄만 남기고 넘어간다 */
async function discover() {
  try {
    const f = await discoverFoods();
    if (verbose) console.log(JSON.stringify(f, null, 2));
    return ` · 새 음식 ${f.added}`;
  } catch (e) {
    if (verbose) console.error(`음식 찾기 실패: ${String(e.message ?? e).slice(0, 300)}`);
    return " · 새 음식 실패";
  }
}

try {
  const r = await collectKeywords();
  if (verbose) console.log(JSON.stringify(r, null, 2));
  const food = await discover();
  if (!verbose) {
    const partial = r.errors.length ? ` · 실패 묶음 ${r.errors.length}` : "";
    console.log(
      `- 시드 ${r.seeds.length} (유입 신호 ${r.signalSeeds}) · 키워드 ${r.fetched} · 새로 ${r.inserted} · 갱신 ${r.updated}${partial}${food}`,
    );
  }
  // 일부 묶음만 실패해도 액션을 빨갛게 만든다. 저장된 것은 그대로 둔다
  if (r.errors.length) process.exit(1);
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
