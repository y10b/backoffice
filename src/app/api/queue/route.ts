import { NextResponse } from "next/server";
import { getQueue, setQueue } from "@/lib/postQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 글감 큐. 설정이 비어 있으면 첫 조회 때 초기 큐가 저장된다 (src/lib/postQueue.ts) */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, queue: await getQueue() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}

/**
 * body: { queue: [{ keyword, note?, done?, postId? }] } — 통째로 바꾼다.
 * 형식이 틀리면 400. 빈 키워드 줄·중복 키워드는 정리해서 저장하고, 저장된 큐를 돌려준다.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { queue?: unknown } | null;
  if (!body || !("queue" in body)) {
    return NextResponse.json({ ok: false, error: "body 에 queue 배열이 필요합니다." }, { status: 400 });
  }
  let queue;
  try {
    queue = await setQueue(body.queue);
  } catch (e) {
    const msg = (e as Error).message;
    // 형식 오류(우리 문구)와 저장 실패(DB)를 가른다
    const status = msg.startsWith("설정 저장 실패") ? 500 : 400;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
  return NextResponse.json({ ok: true, queue });
}
