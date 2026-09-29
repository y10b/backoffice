import { NextResponse } from "next/server";
import { azureCreds, speak } from "@/lib/reels";
import { VOICES } from "@/lib/reelScript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 음성을 쓸 수 있는지. 화면이 목소리 선택을 보여줄지 정한다 */
export async function GET() {
  return NextResponse.json({ ok: true, configured: Boolean(await azureCreds()) });
}

/** 대사 한 줄 → mp3. 줄마다 따로 불러 자막을 클립 길이에 맞춘다 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim().slice(0, 300);
  const voice = VOICES.some((v) => v.id === body.voice) ? String(body.voice) : VOICES[0].id;
  if (!text) return NextResponse.json({ ok: false, error: "읽을 글이 없습니다." }, { status: 400 });
  try {
    const audio = await speak({ text, voice, think: body.think === true });
    return new NextResponse(new Uint8Array(audio), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
