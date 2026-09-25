import { NextResponse } from "next/server";
import { countKeywordPool } from "@/lib/db";
import { listKeywordPool, type PoolSort } from "@/lib/keywordPool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORTS: PoolSort[] = ["searches", "absorption", "bid", "seen", "long", "value"];

/**
 * 키워드 풀 조회. `?days=14&sort=searches&limit=300` (티스토리 시드로 모은 것뿐이다)
 * total 은 limit 과 무관한 최근 days 일의 전체 개수다.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const days = Math.max(1, Number(u.searchParams.get("days")) || 14);
  const limit = Math.max(1, Number(u.searchParams.get("limit")) || 300);
  const rawSort = u.searchParams.get("sort") ?? "searches";
  const sort = (SORTS as string[]).includes(rawSort) ? (rawSort as PoolSort) : "searches";

  try {
    const [keywords, total] = await Promise.all([
      listKeywordPool({ days, limit, sort }),
      countKeywordPool(days),
    ]);
    return NextResponse.json({ ok: true, days, total, keywords });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
