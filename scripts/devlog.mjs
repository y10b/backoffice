/**
 * 개발 로그 갈래를 터미널에서 돌린다. 화면·크론과 같은 함수를 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/devlog.mjs collect [YYYY-MM-DD]
 *   node --import ./scripts/ts-register.mjs scripts/devlog.mjs draft | publish | sync
 *
 * .env.local 을 읽지 않으므로 SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 를 환경에 넣고
 * 돌린다 (자격증명은 설정 화면에 저장된 값을 DB 에서 읽는다).
 */
import { isTask, runTask } from "../src/lib/devlog.ts";

const [task, date] = process.argv.slice(2);
if (!isTask(task)) {
  console.error("사용법: devlog.mjs <collect|draft|publish|sync> [date]");
  process.exit(1);
}
try {
  const result = await runTask(task, { date });
  console.log(JSON.stringify(result, null, 2));
  if (task === "publish" && result.failed?.length) process.exit(1);
} catch (e) {
  console.error(e.message ?? e);
  process.exit(1);
}
