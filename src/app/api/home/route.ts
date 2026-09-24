import { NextResponse } from "next/server";
import { hasSupabase, supabase } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * 홈의 "오늘 할 일" 숫자.
 *
 * 목록 함수(listPosts 등)는 limit 이 걸려 있어 개수가 잘리고 행을 통째로 가져온다.
 * 여기는 숫자만 필요하므로 head + count 로 행 없이 개수만 받는다.
 */
function head(table: string) {
  return supabase().from(table).select("id", { count: "exact", head: true });
}

async function count(
  table: string,
  q: PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number> {
  const { count: n, error } = await q;
  if (error) throw new Error(`${table} 개수 조회 실패: ${error.message}`);
  return n ?? 0;
}

export async function GET() {
  if (!hasSupabase()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      error: "DB(Supabase) 가 설정되지 않았습니다.",
    });
  }
  try {
    /*
     * 하나가 실패해도(예: 마이그레이션 전이라 표가 없음) 나머지 숫자는 보여준다.
     * 실패한 칸은 null 로 두고 화면이 "—" 로 그린다.
     */
    const settled = await Promise.allSettled([
      // 검토 대기 + 승인됐지만 아직 안 나간 velog 글
      count(
        "velog_posts",
        head("velog_posts").in("status", ["draft", "approved"]),
      ),
      // 손질할 쓰레드 후보
      count(
        "threads_posts",
        head("threads_posts").in("status", ["draft", "ready"]),
      ),
      // 진행 중인 방문 후기
      count(
        "visit_posts",
        head("visit_posts").in("status", ["analyzed", "drafted", "ready"]),
      ),
      // 네이버·티스토리 중 한 곳이라도 아직 안 올린 블로그 초안
      count(
        "posts",
        head("posts").or("posted_naver.eq.false,posted_tistory.eq.false"),
      ),
    ]);
    const [velog, threads, visit, posts] = settled.map((r) => (r.status === "fulfilled" ? r.value : null));
    const errors = settled.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).message)] : []));
    return NextResponse.json({
      ok: true,
      counts: { velog, threads, visit, posts },
      error: errors.length ? errors.join(" / ") : undefined,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
