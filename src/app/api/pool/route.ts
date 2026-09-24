import { NextResponse } from "next/server";
import { countKeywordPool } from "@/lib/db";
import { listKeywordPool, type PoolSort } from "@/lib/keywordPool";
import { isChannel } from "@/lib/seeds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORTS: PoolSort[] = ["searches", "absorption", "bid", "seen", "long"];

/**
 * 키워드 풀 조회. `?channel=tistory&days=14&sort=searches&limit=300`
 * total 은 limit 과 무관한 최근 days 일의 전체 개수다.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const channel = u.searchParams.get("channel") ?? "tistory";
  if (!isChannel(channel)) {
    return NextResponse.json(
      { ok: false, error: "channel 은 naver 또는 tistory 입니다." },
      { status: 400 },
    );
  }
  const days = Math.max(1, Number(u.searchParams.get("days")) || 14);
  const limit = Math.max(1, Number(u.searchParams.get("limit")) || 300);
  const rawSort = u.searchParams.get("sort") ?? "searches";
  const sort = (SORTS as string[]).includes(rawSort) ? (rawSort as PoolSort) : "searches";

  try {
    const [keywords, total] = await Promise.all([
      listKeywordPool(channel, { days, limit, sort }),
      countKeywordPool(channel, days),
    ]);
    return NextResponse.json({ ok: true, channel, days, total, keywords });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
