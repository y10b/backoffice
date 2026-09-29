import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { EXPRESSION_KEYS } from "@/lib/reelScript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 주인공 표정 8장. 모든 영상에 같은 생김새로 나와야 하므로 한 번 만들어 고정해 둔다.
 *
 * 설정 표에 data URL 로 둔다. 화면에서 긴 변 480px 로 줄여 보내 장당 수십 KB 라, 저장소 버킷을
 * 따로 만들 만큼 크지 않다. 기기를 바꿔도 같은 주인공이 나온다.
 */
const KEY = "reel_character";

export async function GET() {
  try {
    const raw = await getSetting(KEY);
    return NextResponse.json({ ok: true, character: raw ? JSON.parse(raw) : null });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  const expressions: Record<string, string> = {};
  for (const k of EXPRESSION_KEYS) {
    const v = body.expressions?.[k];
    if (typeof v === "string" && v.startsWith("data:image/png;base64,") && v.length < 600_000) expressions[k] = v;
  }
  if (Object.keys(expressions).length < EXPRESSION_KEYS.length) {
    return NextResponse.json({ ok: false, error: "표정 8장이 모두 있어야 저장합니다." }, { status: 400 });
  }
  const character = { look: String(body.look ?? "").slice(0, 300), expressions, updatedAt: new Date().toISOString() };
  try {
    await setSetting(KEY, JSON.stringify(character));
    return NextResponse.json({ ok: true, character });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
