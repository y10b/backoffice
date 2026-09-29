import { NextResponse } from "next/server";
import { generateReelScript } from "@/lib/reels";
import { LENGTHS, type LengthKey } from "@/lib/reelScript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 인터뷰 답 → 장면 대본. 저장하지 않는다 — 화면이 들고 있다가 고치고 렌더한다 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const answers: Record<string, string> = body.answers && typeof body.answers === "object" ? body.answers : {};
  if (!Object.values(answers).some((a) => String(a).trim())) {
    return NextResponse.json({ ok: false, error: "인터뷰 답이 없습니다." }, { status: 400 });
  }
  const length = (LENGTHS.some((l) => l.key === body.length) ? body.length : "normal") as LengthKey;
  try {
    const script = await generateReelScript({ answers, mood: String(body.mood ?? "웃김"), length });
    return NextResponse.json({ ok: true, script });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
