import { NextResponse } from "next/server";
import { fetchGa4Report } from "@/lib/ga4";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GA4 글별 성과 + 일별 추이. `?days=28` (1~365, 기본 28)
 *
 * 자격증명이 없거나 구글이 거절해도 200 + `ok:false` 로 내려준다.
 * 설정을 아직 안 한 것도 500 으로 뜨면 대시보드가 고장난 것처럼 보이고,
 * 정작 무엇을 해야 하는지는 안내하지 못한다.
 */
export async function GET(req: Request) {
  const days = new URL(req.url).searchParams.get("days");
  return NextResponse.json(await fetchGa4Report(days));
}
