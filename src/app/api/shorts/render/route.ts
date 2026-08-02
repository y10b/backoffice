import { NextResponse } from "next/server";
import { checkFfmpeg, listShorts, parseRenderOptions, renderShort } from "@/lib/shorts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 인코딩은 원본 길이와 화질에 따라 몇 분이 걸린다.
 *
 * 로컬에서는 이 값이 의미 없고(개발 서버는 상한이 없다), 배포본에서는 Vercel Hobby 상한이
 * 300초라 그보다 크면 **배포 자체가 거부된다**. 실제로 600으로 뒀다가 배포가 계속 실패했다.
 *
 * 어차피 배포본에는 ffmpeg 가 없어 이 라우트는 곧바로 안내 문구를 돌려준다.
 * 실제 렌더는 로컬에서만 돈다.
 */
export const maxDuration = 300;

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

  try {
    const result = await renderShort({ ...parseRenderOptions(body), input });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
