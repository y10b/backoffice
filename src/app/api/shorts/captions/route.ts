import { NextResponse } from "next/server";
import { explainClaudeError, writeShortCaptions } from "@/lib/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 짧은 요청이지만 모델이 붐빌 때가 있어 여유를 둔다 */
export const maxDuration = 120;

/**
 * 쇼츠 자막 쓰기.
 *
 * 손으로 넣던 자막 대본을 Claude 가 대신 쓴다. 재료는 이 화면이 이미 쥐고 있다 —
 * 영상 제목과 그 구간에 달린 시청자 반응.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  try {
    const lines = await writeShortCaptions({
      videoTitle: String(body.videoTitle ?? "").trim(),
      durationSec: Math.min(Math.max(num(body.durationSec, 30), 1), 180),
      lineCount: Math.min(Math.max(num(body.lineCount, 4), 1), 12),
      startSec: Math.max(0, num(body.startSec, 0)),
      comments: Array.isArray(body.comments)
        ? body.comments.map((c: unknown) => String(c ?? "").trim()).filter(Boolean)
        : [],
    });
    return NextResponse.json({ ok: true, lines });
  } catch (e) {
    return NextResponse.json({ ok: false, error: explainClaudeError(e) }, { status: 500 });
  }
}
