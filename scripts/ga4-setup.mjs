/**
 * GA4 속성 설정을 맞춘다 — 향상된 측정 전부 켜기, 주요 이벤트(calculator_use · scroll),
 * 맞춤 측정기준(calc_type). 멱등이라 몇 번 돌려도 된다. 자세한 이유는 src/lib/ga4Admin.ts.
 *
 *   set -a && . ./.env.local && set +a && node --import ./scripts/ts-register.mjs scripts/ga4-setup.mjs
 *
 * 자격증명은 설정 표(ga4_service_account · ga4_property_id · ga4_measurement_id)에서 읽는다.
 * 출력은 개수뿐이다.
 */
import { setupGa4 } from "../src/lib/ga4Admin.ts";

try {
  const r = await setupGa4();
  console.log(`- 스트림 ${r.stream || "?"}`);
  console.log(`- 향상된 측정: 확인 ${r.enhanced.checked} · 새로 켬 ${r.enhanced.enabled}${r.enhanced.flags.length ? ` (${r.enhanced.flags.join(", ")})` : ""}`);
  console.log(`- 주요 이벤트: 있음 ${r.keyEvents.existing} · 새로 만듦 ${r.keyEvents.created}`);
  console.log(`- 맞춤 측정기준: 있음 ${r.customDimensions.existing} · 새로 만듦 ${r.customDimensions.created}`);
  for (const e of r.errors) console.error(`- 실패: ${e.slice(0, 400)}`);
  if (r.errors.length) process.exit(1);
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 400)}`);
  process.exit(1);
}
