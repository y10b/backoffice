import { NextResponse } from "next/server";
import { fishVoices } from "@/lib/fishAudio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fish Audio 한국어 공개 목소리. `?q=` 로 이름 검색. 실존 인물로 보이는 것은 빠져 있다 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    return NextResponse.json({ ok: true, voices: await fishVoices(q) });
  } catch (e) {
    return NextResponse.json({ ok: false, voices: [], error: (e as Error).message }, { status: 500 });
  }
}
