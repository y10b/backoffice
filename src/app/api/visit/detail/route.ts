import { NextResponse } from "next/server";
import { getVisitPost, updateVisitPost } from "@/lib/db";
import { analyzeDetailShots, type InputPhoto, type PhotoAnalysis } from "@/lib/visit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 제품 후기 — 상세페이지 캡처를 읽어 판매처가 밝힌 사실을 분석 결과에 붙인다.
 *
 * 사진 분석(analyze)과 따로 부른다. 캡처는 글자가 읽혀야 해서 사진보다 크게 보내는데,
 * 사진 15장과 한 요청에 넣으면 Vercel 요청 크기 한도(약 4.5MB)에 걸린다.
 */
const MAX_SHOTS = 4;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const images: InputPhoto[] = Array.isArray(body.images) ? body.images.slice(0, MAX_SHOTS) : [];
  if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  if (!images.length) return NextResponse.json({ ok: false, error: "캡처가 없습니다." }, { status: 400 });

  try {
    const post = await getVisitPost(id);
    if (!post) return NextResponse.json({ ok: false, error: "없는 초안입니다." }, { status: 404 });
    const detail = await analyzeDetailShots(images);
    const analysis = { ...(post.analysis as unknown as PhotoAnalysis), detail };
    await updateVisitPost(id, { analysis });
    return NextResponse.json({ ok: true, analysis });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
