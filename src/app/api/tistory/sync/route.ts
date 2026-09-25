import { NextResponse } from "next/server";
import { syncTistoryPosts } from "@/lib/tistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 글 40개 안팎을 동시 3개·200ms 간격으로 읽으면 10초 남짓. 글이 늘어도 넉넉하게 */
export const maxDuration = 120;

/** 티스토리 사이트맵을 지금 다시 읽는다. 매일 도는 건 insights 수집(09:30)이고, 이건 화면 버튼용이다 */
export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await syncTistoryPosts()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
