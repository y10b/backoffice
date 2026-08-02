import { NextResponse } from "next/server";
import { TREND_MAX_KEYWORDS, openApiCreds, searchTrend, trendDelta } from "@/lib/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 선택한 키워드(최대 5개)의 검색어 트렌드를 조회한다. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const creds = openApiCreds();
  if (!creds) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "네이버 개발자센터 Client ID/Secret 이 없습니다. 설정 화면에서 등록하세요.",
      },
      { status: 400 },
    );
  }

  const keywords = (Array.isArray(body.keywords) ? body.keywords : [])
    .map((k: unknown) => String(k).trim())
    .filter(Boolean)
    .slice(0, TREND_MAX_KEYWORDS);
  if (!keywords.length) {
    return NextResponse.json(
      { ok: false, error: "키워드를 하나 이상 선택하세요." },
      { status: 400 },
    );
  }

  const weeks = Number(body.weeks) > 0 ? Math.min(260, Number(body.weeks)) : 26;
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);

  try {
    const series = await searchTrend(
      {
        keywords,
        startDate: body.startDate ? String(body.startDate) : iso(start),
        endDate: body.endDate ? String(body.endDate) : iso(end),
        timeUnit: body.timeUnit === "month" || body.timeUnit === "date" ? body.timeUnit : "week",
      },
      creds,
    );
    return NextResponse.json({
      ok: true,
      series: series.map((s) => ({ ...s, delta: trendDelta(s.data) })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `데이터랩 오류 — ${(e as Error).message}` },
      { status: 200 },
    );
  }
}
