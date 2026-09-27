import { NextResponse } from "next/server";
import { foodSettings, nearbyFood } from "@/lib/foodTrend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 그 음식을 파는 주변 가게.
 * `?food=새우&x=126.9&y=37.4` 처럼 위치를 주면 반경 안에서 가까운 순, 없으면 설정한 동네로 찾는다.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const food = (q.get("food") ?? "").trim();
  if (!food) return NextResponse.json({ ok: false, error: "음식을 골라주세요." }, { status: 400 });

  const x = Number(q.get("x"));
  const y = Number(q.get("y"));
  const near = Number.isFinite(x) && Number.isFinite(y) && x && y ? { x, y, radius: Number(q.get("radius")) || 2000 } : undefined;

  try {
    const { area } = await foodSettings();
    if (!near && !area) {
      return NextResponse.json(
        { ok: false, error: "동네를 먼저 정하거나 '내 위치' 로 찾으세요." },
        { status: 400 },
      );
    }
    const places = await nearbyFood(food, area, near);
    return NextResponse.json({ ok: true, places, area: near ? null : area });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
