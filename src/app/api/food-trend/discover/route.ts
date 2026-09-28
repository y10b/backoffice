import { NextResponse } from "next/server";
import { discoverFoods } from "@/lib/foodDiscover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 시드 30여 개면 검색광고 7번(1초 간격) + 모델 한 번. 모델이 붐비면 재시도로 늘어난다
export const maxDuration = 300;

/** 목록 밖 음식 찾기를 지금 돌린다. 매일 06:00 키워드 수집 때도 같은 함수가 돈다 */
export async function POST() {
  try {
    const r = await discoverFoods();
    return NextResponse.json({ ok: true, found: r.found, added: r.added, total: r.total, errors: r.errors });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
