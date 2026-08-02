import { NextResponse } from "next/server";
import { checkFfmpeg, listShorts, renderShort } from "@/lib/shorts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 인코딩은 원본 길이와 화질에 따라 몇 분이 걸린다. 로컬 전용이라 넉넉히 둔다 */
export const maxDuration = 600;

/** 렌더된 쇼츠 목록 + ffmpeg 설치 여부 */
export async function GET() {
  const ff = await checkFfmpeg();
  return NextResponse.json({
    ok: true,
    ffmpeg: ff,
    shorts: await listShorts(),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const input = String(body.input ?? "").trim();
  if (!input) {
    return NextResponse.json(
      { ok: false, error: "원본 영상 주소(input)가 필요합니다." },
      { status: 400 },
    );
  }

  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  try {
    const result = await renderShort({
      input,
      startSec: Math.max(0, num(body.startSec, 0)),
      durationSec: Math.min(Math.max(num(body.durationSec, 30), 1), 180),
      title: typeof body.title === "string" ? body.title : undefined,
      caption: typeof body.caption === "string" ? body.caption : undefined,
      comment:
        body.comment && typeof body.comment.text === "string"
          ? {
              author: String(body.comment.author ?? ""),
              text: String(body.comment.text ?? ""),
            }
          : undefined,
      videoRatio: body.videoRatio ? num(body.videoRatio, 0.62) : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
