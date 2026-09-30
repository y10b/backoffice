import { NextResponse } from "next/server";
import { trendPipeline } from "@/lib/foodTrend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 추세 비교 + 음식 다섯 개 × (카카오 한 번 + 검색광고 두 번). 넉넉히
export const maxDuration = 120;

/** 지금 뜨는 음식 → 동네 인기 가게. 다녀올 곳을 고르는 화면이 부른다 */
export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await trendPipeline()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
