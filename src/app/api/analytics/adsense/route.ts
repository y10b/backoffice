import { NextResponse } from "next/server";
import { adsenseSummary } from "@/lib/adsense";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 최근 N일 애드센스 수익 요약.
 *
 * 자격증명·토큰이 없는 건 서버 잘못이 아니라 아직 연결을 안 한 상태다.
 * 500 을 내면 대시보드가 통째로 깨지므로, 200 + connected:false 로 알려주고
 * 설정 화면이 [애드센스 연결] 버튼을 띄우게 한다.
 */
export async function GET(req: Request) {
  const days = clamp(new URL(req.url).searchParams.get("days"), 1, 365, 28);
  const summary = await adsenseSummary(days);
  return NextResponse.json(summary);
}
