import { NextResponse } from "next/server";
import { suggestSubKeywords } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mainKeyword = String(body.mainKeyword ?? "").trim();
  if (!mainKeyword) {
    return NextResponse.json({ ok: false, error: "메인 키워드가 필요합니다." }, { status: 400 });
  }
  const context = Array.isArray(body.context) ? body.context.map(String) : [];

  try {
    const suggestions = await suggestSubKeywords(mainKeyword, context);
    return NextResponse.json({ ok: true, suggestions });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
