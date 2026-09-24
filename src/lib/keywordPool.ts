/**
 * 키워드 풀 — 티스토리 시드로 연관 키워드를 매일 모아 쌓는다.
 *
 * 네이버는 방문 후기 레인이 담당하므로 키워드 수집은 티스토리뿐이다. keyword_pool.channel 은
 * 늘 'tistory' 로 넣는다.
 *
 * 티스토리 유입이 0 이었다. 시드가 서로 다른 주제였고, 월 검색 1,000 이상 · 수익 잠재력
 * 순으로 한 번에 골라 쓰다 보니 레드오션 키워드만 나왔다. 그래서 2주 동안은 글을 쓰지 않고
 * 키워드만 모아, 며칠째 꾸준히 나오는 것 · 광고 흡수율이 낮은 것 · 긴 것을 보고 주제를 정한다.
 *
 *  | 누가           | 언제        | 하는 일                                   |
 *  |----------------|-------------|-------------------------------------------|
 *  | keywords.yml   | 매일 06:00  | 시드 풀 전체 → keyword_pool upsert        |
 *  | /api/pool/run  | 화면 버튼   | 같은 함수를 지금 돌린다                   |
 *  | /api/pool      | 화면        | 최근 N일 풀을 정렬해 보여준다             |
 *
 * 지키는 선:
 * - 문서수·추세는 조회하지 않는다. 수백 개 키워드에 대해 매일 부르면 검색 API 한도를 먹고,
 *   고를 때 필요한 건 검색량·단가·흡수율뿐이다.
 * - 검색광고 호출 사이 1초 쉰다. 연달아 부르면 429 가 난다.
 */
import { researchKeywords } from "./research";
import {
  listKeywordPool as dbListKeywordPool,
  upsertKeywordPool,
  type PoolInput,
  type PoolRow,
  type PoolSort,
} from "./db";
import { seedPool } from "./seeds";

export type { PoolRow, PoolSort };

/** 검색광고 키워드도구가 한 번에 받는 힌트 키워드 수 (searchad.ts normalizeHints) */
const HINTS_PER_CALL = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 단어 수. 긴 키워드(롱테일) 우선에 쓴다.
 *
 * 키워드도구는 띄어쓰기를 빼고 준다("프리랜서종합소득세"). 공백으로만 세면 거의 전부 1 이
 * 되어 순서를 가를 수 없다. 한국어 단어가 대개 2~4자라 붙어 있으면 4자당 한 단어로 어림한다
 * (8자 이상이면 2, 12자 이상이면 3). 띄어 쓴 키워드는 공백 기준 값과 어림값 중 큰 쪽이다.
 */
export function wordCount(keyword: string): number {
  const k = keyword.trim();
  if (!k) return 1;
  const bySpace = k.split(/\s+/).length;
  const byLength = Math.floor(k.replace(/\s+/g, "").length / 4);
  return Math.max(1, bySpace, byLength);
}

/**
 * 한 번에 시드 여러 개로 조회하면 결과에 "어느 시드에서 나왔는지"가 없다.
 * 키워드가 품고 있는 시드(공백 빼고 비교)를 고르고, 없으면 글자가 가장 많이 겹치는 시드,
 * 그것도 없으면 묶음의 첫 시드로 둔다.
 */
function attributeSeed(keyword: string, seeds: string[]): string {
  const bare = keyword.replace(/\s+/g, "");
  const contained = seeds.find((s) => bare.includes(s.replace(/\s+/g, "")));
  if (contained) return contained;
  let best = seeds[0];
  let bestScore = 0;
  for (const s of seeds) {
    const chars = new Set(s.replace(/\s+/g, ""));
    let score = 0;
    for (const c of new Set(bare)) if (chars.has(c)) score += 1;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

export type CollectResult = {
  seeds: string[];
  /** 조회로 받은 키워드 수 (묶음 사이 중복 제거 후) */
  fetched: number;
  inserted: number;
  updated: number;
  /** 실패한 묶음의 오류. 전부 실패하면 던진다 */
  errors: string[];
};

export async function collectKeywords(
  opts: { seeds?: string[] } = {},
): Promise<CollectResult> {
  const seeds = opts.seeds?.length ? opts.seeds : await seedPool();
  if (!seeds.length) throw new Error("시드가 비어 있습니다.");

  const rows: PoolInput[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < seeds.length; i += HINTS_PER_CALL) chunks.push(seeds.slice(i, i + HINTS_PER_CALL));

  for (const [i, chunk] of chunks.entries()) {
    if (i > 0) await sleep(1000);
    const r = await researchKeywords({
      seeds: chunk,
      limit: 200,
      minSearches: 100,
      includeDocs: false,
      includeTrend: false,
      sort: "searches",
    });
    if (!r.ok) {
      errors.push(r.error ?? "키워드 조회 실패");
      continue;
    }
    for (const k of r.keywords) {
      // 시드 자체는 검색수 하한을 무시하고 붙어 온다. 풀에는 하한을 넘는 것만 둔다
      if ((k.totalSearches ?? 0) < 100) continue;
      // 여러 시드 묶음에 같은 키워드가 나오면 처음 것
      if (seen.has(k.keyword)) continue;
      seen.add(k.keyword);
      rows.push({
        channel: "tistory",
        seed: attributeSeed(k.keyword, chunk),
        keyword: k.keyword,
        searches: k.totalSearches,
        mobile_ratio: k.mobileShare,
        bid: k.bid,
        ad_absorption: k.adAbsorption,
        revenue_score: k.revenueScore,
        competition: k.adCompetition ?? "",
        word_count: wordCount(k.keyword),
      });
    }
  }

  if (errors.length === chunks.length) throw new Error(errors[0]);

  const { inserted, updated } = await upsertKeywordPool(rows);
  return { seeds, fetched: rows.length, inserted, updated, errors };
}

export async function listKeywordPool(
  o: { days?: number; limit?: number; sort?: PoolSort } = {},
): Promise<PoolRow[]> {
  return dbListKeywordPool(o);
}
