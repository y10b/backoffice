import { NextResponse } from "next/server";
import { PRODUCT_CATEGORIES, productTrends } from "@/lib/productTrend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 검색광고 2~3번 + 데이터랩 5번. 기본 10초로는 빠듯하다
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({
    ok: true,
    categories: PRODUCT_CATEGORIES.map(({ key, label, shops, seeds }) => ({ key, label, shops, seeds })),
  });
}

/** 한 카테고리의 오르는 상품. 부를 때마다 새로 본다 — 하루 한두 번 보는 화면이라 쌓아 둘 이유가 없다 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const extra = typeof body.extra === "string" ? body.extra.split(/[,\n]/).map((s: string) => s.trim()).filter(Boolean).slice(0, 5) : [];
  try {
    return NextResponse.json({ ok: true, ...(await productTrends(String(body.category ?? ""), extra)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
