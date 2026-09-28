import { NextResponse } from "next/server";
import { generateStockPrompts, STOCK_STYLES, type StockStyle } from "@/lib/stock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 주제 하나로 ChatGPT 에 붙여 넣을 프롬프트와 판매용 제목·키워드를 만든다 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const topic = String(body.topic ?? "").trim();
  if (!topic) return NextResponse.json({ ok: false, error: "주제를 적어주세요." }, { status: 400 });

  const style = (body.style in STOCK_STYLES ? body.style : "flat") as StockStyle;
  // 한 번에 너무 많으면 비슷한 것끼리 겹친다(스팸 반려). 한 장 격자의 최대(4×4)까지만
  const count = Math.min(16, Math.max(1, Number(body.count) || 8));

  try {
    const items = await generateStockPrompts({ topic, hints: String(body.hints ?? "").trim(), style, count });
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
