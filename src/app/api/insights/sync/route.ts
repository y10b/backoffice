import { NextResponse } from "next/server";
import { syncInsights } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 90일을 다시 채우면 서치콘솔 페이지네이션 + GA4 두 리포트 + 표 쓰기라 길어질 수 있다 */
export const maxDuration = 300;

/**
 * 유입 데이터를 지금 수집한다. 매일 도는 건 깃액션(insights.yml)이고, 이건 화면 버튼용이다.
 * body: { days?: number } (기본 7, 최대 90). 한쪽이 실패해도 ok 는 true 이고 result.errors 에 담긴다.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { days?: unknown };
  const n = Number(body.days);
  const days = body.days === undefined || body.days === null || !Number.isFinite(n) ? undefined : n;
  try {
    return NextResponse.json({ ok: true, result: await syncInsights({ days }) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
