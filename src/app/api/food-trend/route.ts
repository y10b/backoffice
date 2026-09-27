import { NextResponse } from "next/server";
import { DEFAULT_FOOD_SEEDS, foodSettings, foodTrends, parseFoodSeeds, saveFoodSettings } from "@/lib/foodTrend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 음식 30개면 데이터랩 6번 + 검색광고 6번이다. 기본 10초로는 빠듯하다
export const maxDuration = 60;

/** 음식 목록과 동네 설정 */
export async function GET() {
  try {
    const s = await foodSettings();
    return NextResponse.json({ ok: true, ...s, defaults: DEFAULT_FOOD_SEEDS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    await saveFoodSettings({
      area: typeof body.area === "string" ? body.area : undefined,
      seeds: typeof body.seeds === "string" ? parseFoodSeeds(body.seeds) : undefined,
    });
    return NextResponse.json({ ok: true, ...(await foodSettings()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** 지금 오르는 음식. 부를 때마다 새로 조회한다 — 하루 한두 번 보는 화면이라 쌓아 둘 이유가 없다 */
export async function POST() {
  try {
    const { seeds } = await foodSettings();
    const r = await foodTrends(seeds);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
