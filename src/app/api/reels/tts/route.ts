import { NextResponse } from "next/server";
import { speak, ttsEngine } from "@/lib/reels";
import { fishSpeak, isFishVoiceId } from "@/lib/fishAudio";
import { VOICES } from "@/lib/reelScript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 어떤 음성 엔진을 쓸 수 있는지. 화면이 목소리 고르는 칸을 엔진에 맞게 보여준다 */
export async function GET() {
  return NextResponse.json({ ok: true, engine: await ttsEngine() });
}

/** 대사 한 줄 → mp3. 줄마다 따로 불러 자막을 클립 길이에 맞춘다 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim().slice(0, 300);
  if (!text) return NextResponse.json({ ok: false, error: "읽을 글이 없습니다." }, { status: 400 });
  try {
    const engine = await ttsEngine();
    if (!engine) throw new Error("음성 키가 없습니다. 설정에서 Fish Audio 키를 넣으세요. 없으면 자막만으로 만들 수 있습니다.");
    let audio: ArrayBuffer;
    if (engine === "fish") {
      if (!isFishVoiceId(body.voice)) throw new Error("Fish Audio 목소리를 먼저 고르세요.");
      audio = await fishSpeak({ text, voice: body.voice, think: body.think === true });
    } else {
      const voice = VOICES.some((v) => v.id === body.voice) ? String(body.voice) : VOICES[0].id;
      audio = await speak({ text, voice, think: body.think === true });
    }
    return new NextResponse(new Uint8Array(audio), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
