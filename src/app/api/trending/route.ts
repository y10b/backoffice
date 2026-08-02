import { NextResponse } from "next/server";
import { fetchTrending } from "@/lib/trends";
import { fetchBids, fetchRelatedKeywords } from "@/lib/searchad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 화면 진입마다 도는 자동 조회라 캐시가 필수다.
 * 검색광고 API 는 연속 호출에 429 를 내는데, 탭을 몇 번만 오가도 바로 걸린다.
 */
const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; payload: unknown } | null = null;

/** 급상승어에 단가를 붙여 애드센스 관점에서 쓸모 있는 것만 남긴다. */
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ ...(cache.payload as object), cached: true });
  }

  let trending;
  try {
    trending = await fetchTrending();
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, items: [] });
  }
  if (!trending.length) {
    return NextResponse.json({
      ok: true,
      items: [],
      error: "구글 트렌드가 급상승어를 반환하지 않았습니다.",
    });
  }

  const keywords = trending.map((t) => t.keyword);
  const { bids, error: bidError } = await fetchBids(keywords);

  /*
   * 검색량은 키워드도구로 따로 받아야 하는데, 급상승어 하나하나를 시드로 넣으면
   * 호출이 폭증한다. 힌트는 5개까지라 상위 5개만 넣어 겸사겸사 받고,
   * 나머지는 단가만 채운다.
   */
  const volumes = new Map<string, number>();
  try {
    const rel = await fetchRelatedKeywords(keywords.slice(0, 5));
    if (rel.ok) {
      for (const k of rel.keywords) {
        if (k.totalSearches !== null) volumes.set(k.keyword, k.totalSearches);
      }
    }
  } catch {
    /* 검색량은 부가 정보라 실패해도 단가만으로 보여준다 */
  }

  const items = trending
    .map((t) => {
      const bid = bids.get(t.keyword) ?? null;
      const searches = volumes.get(t.keyword.replace(/\s+/g, "")) ?? null;
      return {
        keyword: t.keyword,
        approxTraffic: t.approxTraffic,
        bid,
        totalSearches: searches,
        // 단가와 급상승 트래픽을 묶은 비교 지수. 검색량은 대부분 비어서 트래픽으로 대신한다
        revenueScore:
          bid !== null && t.approxTraffic !== null
            ? Math.round((bid * t.approxTraffic) / 1000)
            : null,
      };
    })
    .sort((a, b) => (b.bid ?? -1) - (a.bid ?? -1));

  const payload = {
    ok: true,
    items,
    fetchedAt: new Date().toISOString(),
    error: bidError ? `단가 일부 실패: ${bidError}` : undefined,
  };
  cache = { at: Date.now(), payload };
  return NextResponse.json({ ...payload, cached: false });
}
