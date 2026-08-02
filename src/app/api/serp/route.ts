import { NextResponse } from "next/server";
import { analyzeSerps } from "@/lib/serp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 한 번에 너무 많이 긁지 않도록 상한을 둔다. */
const MAX_KEYWORDS = 20;

/** 선택한 키워드들의 블로그 검색 결과를 분석한다. 사용자가 버튼을 눌렀을 때만 돈다. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const keywords = (Array.isArray(body.keywords) ? body.keywords : [])
    .map((k: unknown) => String(k).trim())
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS);

  if (!keywords.length) {
    return NextResponse.json(
      { ok: false, error: "분석할 키워드를 선택하세요." },
      { status: 400 },
    );
  }

  try {
    const results = await analyzeSerps(keywords);
    const failed = results.filter((r) => r.error);
    return NextResponse.json({
      ok: true,
      results,
      error: failed.length
        ? `${failed.length}/${results.length}건 실패: ${failed[0].error}`
        : undefined,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
