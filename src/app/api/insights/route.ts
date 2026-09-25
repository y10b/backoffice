import { NextResponse } from "next/server";
import { clampInsightDays, getInsights } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 유입 집계. `?days=28` (KST 어제까지 N일). 표는 insights.yml 이 매일 채운다.
 * 표가 비어 있으면 숫자가 0 이고 lastDate 가 null 이다 — 화면은 "수집 전"으로 그리면 된다.
 */
export async function GET(req: Request) {
  const days = clampInsightDays(new URL(req.url).searchParams.get("days") ?? 28);
  try {
    return NextResponse.json({ ok: true, days, ...(await getInsights({ days })) });
  } catch (e) {
    return NextResponse.json({ ok: false, days, error: (e as Error).message });
  }
}
