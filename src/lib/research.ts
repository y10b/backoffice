import {
  fetchBids,
  fetchRelatedKeywords,
  normalizeHints,
  searchAdCreds,
} from "./searchad";
import {
  TREND_MAX_KEYWORDS,
  blogDocCounts,
  openApiCreds,
  searchTrend,
  trendDelta,
} from "./openapi";
import type { Keyword, KeywordFetchResult, SourceStatus } from "./types";

/**
 * 입찰가를 받아올 후보 풀 크기.
 * `단가 높은 순`이 요청 개수보다 넓은 후보에서 고르게 하되, 배치 호출이 너무 늘지 않게
 * 한다 (50개씩 끊어 부르므로 100이면 2회).
 */
const BID_POOL = 100;

export type SortKey =
  | "searches"
  | "competition"
  | "docs"
  | "mobile"
  | "absorption"
  | "bid"
  | "revenue";

export type ResearchOptions = {
  seeds: string[];
  /** 결과 최대 개수 */
  limit: number;
  /** 이 월간 검색수 미만은 버린다 */
  minSearches: number;
  /** 블로그 문서수를 조회해 경쟁률을 계산할지 */
  includeDocs: boolean;
  /** 데이터랩 추세를 상위 5개에 대해 조회할지 */
  includeTrend: boolean;
  sort: SortKey;
};

/** 최근 N주 구간. 데이터랩은 2016-01-01 이후만 조회할 수 있다. */
function trendRange(weeks = 26): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

/** 정렬 기준별로 (값 뽑는 함수, 오름차순 여부). 값이 없는 행은 항상 뒤로 보낸다. */
const SORT_FIELDS: Record<
  Exclude<SortKey, "searches">,
  { pick: (k: Keyword) => number | null; asc: boolean }
> = {
  competition: { pick: (k) => k.competitionRatio, asc: true },
  docs: { pick: (k) => k.blogDocs, asc: true },
  mobile: { pick: (k) => k.mobileShare, asc: false },
  absorption: { pick: (k) => k.adAbsorption, asc: true },
  bid: { pick: (k) => k.bid, asc: false },
  revenue: { pick: (k) => k.revenueScore, asc: false },
};

function sortKeywords(list: Keyword[], sort: SortKey): Keyword[] {
  const bySearches = (a: Keyword, b: Keyword) =>
    (b.totalSearches ?? -1) - (a.totalSearches ?? -1);

  return [...list].sort((a, b) => {
    // 시드로 넣은 키워드는 항상 위에 붙여 비교 기준으로 삼는다
    if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
    if (sort === "searches") return bySearches(a, b);

    const { pick, asc } = SORT_FIELDS[sort];
    const av = pick(a);
    const bv = pick(b);
    if (av === null && bv === null) return bySearches(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    return asc ? av - bv : bv - av;
  });
}

/**
 * 공식 API 세 곳을 조합해 키워드 표를 만든다.
 *
 * 1. 검색광고 키워드도구 → 연관 키워드 + 월간 검색수 (필수)
 * 2. 검색 API → 키워드별 블로그 문서수 → 경쟁률 (선택)
 * 3. 데이터랩 → 상위 5개 검색어 추세 (선택)
 *
 * 2·3 은 실패해도 1 의 결과는 그대로 반환한다.
 */
export async function researchKeywords(
  o: ResearchOptions,
): Promise<KeywordFetchResult> {
  const seeds = normalizeHints(o.seeds);
  const sources: SourceStatus[] = [];

  // 자격증명 확인은 DB 왕복이라 루프 밖에서 한 번만 한다
  const searchAdConfigured = (await searchAdCreds()) !== null;

  /* 1. 연관 키워드 + 검색량 */
  const rel = await fetchRelatedKeywords(o.seeds);
  sources.push({
    id: "searchad",
    label: "검색광고 키워드도구",
    configured: searchAdConfigured,
    ok: rel.ok,
    skipped: false,
    message: rel.error ?? `연관 키워드 ${rel.keywords.length}건`,
  });

  if (!rel.ok) {
    return { ok: false, seeds, keywords: [], sources, error: rel.error };
  }

  const pct = (part: number | null, whole: number | null): number | null =>
    part === null || !whole ? null : Math.round((part / whole) * 1000) / 10;

  const seedSet = new Set(seeds);
  let keywords: Keyword[] = rel.keywords
    .filter((k) => (k.totalSearches ?? 0) >= o.minSearches || seedSet.has(k.keyword))
    .map((k) => ({
      keyword: k.keyword,
      rank: 0,
      isSeed: seedSet.has(k.keyword),
      pcSearches: k.pcSearches,
      mobileSearches: k.mobileSearches,
      totalSearches: k.totalSearches,
      adCompetition: k.adCompetition,
      adDepth: k.adDepth,
      adCtr: k.adCtr,
      mobileShare: pct(k.mobileSearches, k.totalSearches),
      adAbsorption: pct(k.adClicks, k.totalSearches),
      bid: null,
      revenueScore: null,
      blogDocs: null,
      competitionRatio: null,
      serp: null,
      trend: null,
      trendDelta: null,
      raw: k.raw,
    }));

  /*
   * limit 을 자르기 전에 최종 정렬 기준으로 먼저 줄을 세운다.
   * 그래야 "광고 흡수율 낮은 순"이 전체 연관 키워드에서 고른 결과가 된다.
   * 다만 입찰가·문서수는 아래에서 따로 조회하는 값이라 지금은 알 수 없다.
   * 그 기준일 때는 검색수로 넉넉한 후보 풀만 남기고, 조회한 뒤 다시 정렬한다.
   */
  const preSortable: SortKey[] = ["searches", "mobile", "absorption"];
  const preSort = preSortable.includes(o.sort) ? o.sort : "searches";
  keywords = sortKeywords(keywords, preSort).slice(0, Math.max(o.limit, BID_POOL));

  /* 1-b. 예상 입찰가 — 애드센스 단가의 대리 지표 */
  const { bids, error: bidError } = await fetchBids(keywords.map((k) => k.keyword));
  for (const k of keywords) {
    k.bid = bids.get(k.keyword) ?? null;
    k.revenueScore =
      k.bid !== null && k.totalSearches !== null
        ? Math.round((k.totalSearches * k.bid) / 1000)
        : null;
  }
  sources.push({
    id: "bid",
    label: "예상 입찰가",
    configured: true,
    ok: bids.size > 0,
    skipped: false,
    message: bidError
      ? `${bids.size}건 조회 · 일부 실패: ${bidError}`
      : `${bids.size}건 조회`,
  });

  // 입찰가까지 채운 뒤 최종 정렬하고 요청한 개수로 자른다
  keywords = sortKeywords(keywords, o.sort).slice(0, o.limit);

  const creds = await openApiCreds();
  const openApiConfigured = creds !== null;

  /* 2. 블로그 문서수 → 경쟁률 */
  if (!o.includeDocs || !creds) {
    sources.push({
      id: "search",
      label: "검색 API (블로그 문서수)",
      configured: openApiConfigured,
      ok: false,
      skipped: true,
      message: !openApiConfigured
        ? "Client ID/Secret 미등록 — 경쟁률을 계산하지 않았습니다."
        : "이번 조회에서 건너뛰었습니다.",
    });
  } else {
    const { counts, error } = await blogDocCounts(
      keywords.map((k) => k.keyword),
      creds,
    );
    for (const k of keywords) {
      const docs = counts.get(k.keyword);
      if (docs === undefined) continue;
      k.blogDocs = docs;
      k.competitionRatio =
        k.totalSearches && k.totalSearches > 0
          ? Math.round((docs / k.totalSearches) * 100) / 100
          : null;
    }
    sources.push({
      id: "search",
      label: "검색 API (블로그 문서수)",
      configured: true,
      ok: counts.size > 0,
      skipped: false,
      message: error
        ? `${counts.size}/${keywords.length}건 조회 · 일부 실패: ${error}`
        : `${counts.size}건 조회`,
    });
  }

  /* 3. 데이터랩 추세 (상위 5개만 — API 그룹 제한) */
  const sorted = sortKeywords(keywords, o.sort).map((k, i) => ({ ...k, rank: i + 1 }));

  if (!o.includeTrend || !creds) {
    sources.push({
      id: "datalab",
      label: "데이터랩 검색어트렌드",
      configured: openApiConfigured,
      ok: false,
      skipped: true,
      message: !openApiConfigured
        ? "Client ID/Secret 미등록 — 추세를 조회하지 않았습니다."
        : "이번 조회에서 건너뛰었습니다.",
    });
  } else {
    const targets = sorted.slice(0, TREND_MAX_KEYWORDS).map((k) => k.keyword);
    try {
      const series = await searchTrend({ ...trendRange(), keywords: targets }, creds);
      const byKeyword = new Map(series.map((s) => [s.keyword, s.data]));
      for (const k of sorted) {
        const data = byKeyword.get(k.keyword);
        if (!data) continue;
        k.trend = data;
        k.trendDelta = trendDelta(data);
      }
      sources.push({
        id: "datalab",
        label: "데이터랩 검색어트렌드",
        configured: true,
        ok: series.length > 0,
        skipped: false,
        message: `상위 ${series.length}개 최근 26주 추세`,
      });
    } catch (e) {
      sources.push({
        id: "datalab",
        label: "데이터랩 검색어트렌드",
        configured: true,
        ok: false,
        skipped: false,
        message: (e as Error).message,
      });
    }
  }

  return {
    ok: true,
    seeds,
    keywords: sorted,
    sources,
    error: sorted.length
      ? undefined
      : "조건에 맞는 키워드가 없습니다. 최소 검색수를 낮춰보세요.",
  };
}

/**
 * 부제로 쓸 키워드를 검색량으로 고른다.
 *
 * 지금까지는 Gemini 에게 서브 키워드를 물어봤다. 그 답은 "그럴듯한" 조합이지
 * 사람들이 실제로 그렇게 검색한다는 근거가 없고, 실패하면 아예 빈 값이 됐다
 * (실측: 두 편 중 한 편이 서브 없이 나갔다).
 *
 * 후보는 이미 손에 있다 — 검색광고 키워드도구가 시드로 뽑아준 연관 키워드에
 * 월간 검색수가 붙어 온다. 같은 시드에서 나왔으니 주제는 이미 비슷하고, 남은
 * 일은 그중 가장 많이 검색되는 것을 고르는 것뿐이다.
 *
 * 걸러내는 것 두 가지:
 *  - 한쪽이 다른 쪽을 통째로 품는 조합("실비보험"과 "실비")은 제목에 나란히 두면
 *    같은 말을 두 번 하는 꼴이라 뺀다.
 *  - 너무 긴 것은 제목이 감당하지 못한다. 부제는 짧아야 읽힌다.
 */
export function pickSubKeyword(
  mainKeyword: string,
  candidates: Pick<Keyword, "keyword" | "totalSearches">[],
  o: {
    /** 부제로 허용할 최대 글자 수 */
    maxChars?: number;
    /**
     * 이미 다른 편이 가져간 부제.
     *
     * 검색량 최댓값을 그대로 고르면 같은 시드에서 나온 글이 전부 같은 부제를 단다
     * (실측: 두 편 다 '아파트'였다). 한 회차 안에서는 겹치지 않게 넘겨준다.
     */
    exclude?: Iterable<string>;
  } = {},
): { keyword: string; searches: number } | null {
  const maxChars = o.maxChars ?? 14;
  const main = mainKeyword.replace(/\s+/g, "");
  const taken = new Set([...(o.exclude ?? [])].map((k) => k.replace(/\s+/g, "")));

  const usable = candidates
    .map((k) => ({ keyword: k.keyword.trim(), searches: k.totalSearches ?? 0 }))
    .filter((k) => {
      if (!k.keyword || k.searches <= 0) return false;
      const bare = k.keyword.replace(/\s+/g, "");
      if (bare === main) return false;
      // 서로 품는 관계면 제목에서 겹쳐 읽힌다
      if (bare.includes(main) || main.includes(bare)) return false;
      if (taken.has(bare)) return false;
      return k.keyword.length <= maxChars;
    })
    .sort((a, b) => b.searches - a.searches);

  return usable[0] ?? null;
}
