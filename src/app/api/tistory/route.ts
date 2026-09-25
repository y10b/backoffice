import { NextResponse } from "next/server";
import { countCategories, listTistoryPosts } from "@/lib/tistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 실제로 올라간 티스토리 글 + 최근 90일 유입(조회·세션·노출·클릭·평균 순위)과 카테고리별 글 수.
 * 글 목록은 매일 아침 insights 수집 때 사이트맵에서 새로 읽는다 (src/lib/tistory.ts).
 */
export async function GET() {
  try {
    const posts = await listTistoryPosts();
    return NextResponse.json({ ok: true, posts, categories: countCategories(posts) });
  } catch (e) {
    return NextResponse.json({ ok: false, posts: [], categories: [], error: (e as Error).message });
  }
}
