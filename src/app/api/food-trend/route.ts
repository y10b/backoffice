import { NextResponse } from "next/server";
import {
  DEFAULT_FOOD_SEEDS,
  adoptDiscovered,
  discoveredForTrends,
  excludeDiscovered,
  foodSettings,
  foodTrends,
  parseFoodSeeds,
  saveFoodSettings,
} from "@/lib/foodTrend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 음식 30개 + 발견 15개면 데이터랩 9번 + 검색광고 9번이다. 기본 10초로는 빠듯하다
export const maxDuration = 60;

/** 음식 목록과 동네 설정. 발견 목록(discovered)·제외 목록(excluded)도 같이 준다 */
export async function GET() {
  try {
    const s = await foodSettings();
    return NextResponse.json({ ok: true, ...s, defaults: DEFAULT_FOOD_SEEDS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/**
 * 설정 저장. `{ area, seeds }` 외에
 *   `{ adopt: "탕후루" }`   발견된 음식을 목록에 넣는다 (발견 목록에서 빠진다)
 *   `{ exclude: "탕후루" }` 발견된 음식을 뺀다 (다시 발견돼도 넣지 않는다)
 */
export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    if (typeof body.adopt === "string" && body.adopt.trim()) await adoptDiscovered(body.adopt);
    if (typeof body.exclude === "string" && body.exclude.trim()) await excludeDiscovered(body.exclude);
    await saveFoodSettings({
      area: typeof body.area === "string" ? body.area : undefined,
      seeds: typeof body.seeds === "string" ? parseFoodSeeds(body.seeds) : undefined,
    });
    return NextResponse.json({ ok: true, ...(await foodSettings()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** 지금 오르는 음식 (목록 + 발견 상위 15개). 부를 때마다 새로 조회한다 — 하루 한두 번 보는 화면이라 쌓아 둘 이유가 없다 */
export async function POST() {
  try {
    const s = await foodSettings();
    const r = await foodTrends(s.seeds, discoveredForTrends(s));
    return NextResponse.json({ ok: true, ...r, discovered: s.discovered, excluded: s.excluded });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
