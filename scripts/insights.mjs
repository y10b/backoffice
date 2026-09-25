/**
 * 유입 데이터 수집 — 서치콘솔·GA4·GA4 이벤트를 최근 N일(KST 어제까지) 다시 쓴다.
 * 화면의 /api/insights/sync 와 같은 함수(src/lib/insights.ts syncInsights)를 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/insights.mjs [--days 7] [--verbose]
 *
 * 필요한 환경: SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY. 구글 자격증명(서비스 계정·속성 ID·
 * 서치콘솔 주소)은 설정 표에서 읽는다.
 *
 * 기본 출력은 개수뿐이다. 깃액션 로그는 공개 레포에서 누구나 읽는다 — 검색어는 화면에서 본다.
 */
import { syncInsights } from "../src/lib/insights.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const i = args.indexOf("--days");
const days = i >= 0 ? Number(args[i + 1]) : undefined;
if (days !== undefined && !(Number.isInteger(days) && days > 0)) {
  console.error("- 실패: --days 는 1 이상의 정수여야 합니다.");
  process.exit(1);
}

try {
  const r = await syncInsights({ days });
  if (verbose) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`- 기간 ${r.range[0]} ~ ${r.range[1]} (${r.days}일)`);
    console.log(`- 검색 ${r.search} · 유입 ${r.traffic} · 이벤트 ${r.events}`);
    // 오류 문구에는 검색어가 실리지 않는다 (권한·API 설정 안내뿐)
    for (const e of r.errors) console.error(`- 실패: ${e.slice(0, 300)}`);
  }
  // 한쪽만 실패해도 액션을 빨갛게 만든다. 저장된 것은 그대로 둔다
  if (r.errors.length) process.exit(1);
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
