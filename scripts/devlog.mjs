/**
 * 개발 로그 갈래를 터미널·깃액션에서 돌린다. 화면·크론 라우트와 같은 함수를 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/devlog.mjs collect [YYYY-MM-DD]
 *   node --import ./scripts/ts-register.mjs scripts/devlog.mjs draft | publish | sync
 *   ... --verbose   결과 JSON 전체 (레포 이름·제목 포함 — 공개 로그에서는 쓰지 않는다)
 *
 * .env.local 을 읽지 않으므로 SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 를 환경에 넣고
 * 돌린다 (GitHub 토큰·velog 쿠키는 설정 표에서 읽는다).
 *
 * 기본 출력은 개수뿐이다. 깃액션 로그는 공개 레포에서 누구나 읽으므로 비공개 레포 이름과
 * 초안 제목을 여기 남기지 않는다. 내용은 백오피스 화면에서 본다.
 */
import { isTask, runTask } from "../src/lib/devlog.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const [task, date] = args.filter((a) => !a.startsWith("--"));

if (!isTask(task)) {
  console.error("사용법: devlog.mjs <collect|draft|publish|sync> [date] [--verbose]");
  process.exit(1);
}

function summary(r) {
  switch (task) {
    case "collect":
      return `- ${r.date} · 레포 ${r.found.length}개 · 새로 ${r.inserted} · 갱신 ${r.updated} · 그대로 ${r.skipped}`;
    case "draft":
      return r.made
        ? `- 초안 1편 (${r.ai ? "모델 작성" : "뼈대만"} · 커밋 ${r.commits}개)`
        : `- 초안 없음 — ${r.reason}`;
    case "publish":
      return `- 발행 ${r.published.length} · 실패 ${r.failed.length}`;
    case "sync":
      return `- velog 공개글 ${r.total} · 새로 ${r.created} · 연결 ${r.linked} · 반응 갱신 ${r.refreshed}`;
  }
}

try {
  const result = await runTask(task, { date });
  console.log(verbose ? JSON.stringify(result, null, 2) : summary(result));
  // 발행 실패는 시끄럽게 — 액션이 빨갛게 뜬다. 사유는 글에 남아 있다
  if (task === "publish" && result.failed?.length) process.exit(1);
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
