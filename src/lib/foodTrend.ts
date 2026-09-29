import { getSettings, setSetting } from "./db";
import { openApiCreds, searchTrend, trendDelta, TREND_MAX_KEYWORDS, type TrendPoint } from "./openapi";
import { fetchRelatedKeywords } from "./searchad";
import { searchPlaces, type Near, type Place } from "./kakao";
import type { PhotoAnalysis } from "./visit";

/**
 * 음식 트렌드 — 무엇을 먹으러 갈지, 쓸 글에 어떤 키워드를 달지.
 *
 * 방문 후기는 직접 간 곳만 쓴다. 그래서 트렌드는 "이 음식으로 글을 지어내자" 가 아니라
 * **"이 음식을 먹으러 가자"** 로 쓴다. 가을에 새우·대하 검색이 오르면 주변 새우집을
 * 찾아 다녀오고, 다녀온 사진으로 `/visit` 에서 글을 쓴다.
 *
 *  | 출처                  | 알려주는 것                           |
 *  |-----------------------|--------------------------------------|
 *  | 데이터랩 검색어 트렌드 | 최근 석 달 사이 오르는지 내리는지 (제철) |
 *  | 검색광고 키워드도구    | 월간 검색수 (얼마나 큰 판인지)          |
 *  | 카카오 로컬            | 그 음식을 파는 주변 가게                |
 *
 * 음식 목록과 동네는 설정값이다. 맛집 말고 다른 주제로 넓힐 때 목록만 바꾸면 된다.
 */

/** 검색광고는 공백을 뗀 형태로 집계한다. 비교도 그렇게 한다 */
export const bare = (s: string) => s.replace(/\s+/g, "");

/**
 * 기본 음식 후보. 계절마다 오르는 것과 늘 찾는 것을 섞었다.
 * 데이터랩은 상대값이라 "오르는 중인가" 만 보면 제철이 저절로 걸러진다.
 */
export const DEFAULT_FOOD_SEEDS = [
  // 가을
  "대하", "새우", "전어", "꽃게", "송이버섯",
  // 겨울
  "굴", "방어", "과메기", "붕어빵", "어묵탕",
  // 봄
  "주꾸미", "도다리쑥국", "딸기뷔페",
  // 여름
  "냉면", "콩국수", "빙수", "장어", "삼계탕",
  // 늘
  "마라탕", "국밥", "삼겹살", "곱창", "초밥", "칼국수", "짬뽕", "돈까스", "떡볶이", "파스타",
];

export type FoodSettings = {
  /** 가게를 찾을 동네. "신림", "관악구" 처럼 */
  area: string;
  seeds: string[];
  /** 검색광고 연관 키워드에서 자동으로 찾은, 목록 밖 음식. 검색수 많은 순 */
  discovered: DiscoveredFood[];
  /** 사용자가 뺀 음식. 발견돼도 다시 넣지 않는다 */
  excluded: string[];
};

/** 설정 `food_discovered` 의 한 칸 */
export type DiscoveredFood = {
  name: string;
  /** 월간 검색수(PC+모바일). 이 음식으로 잡힌 키워드 중 가장 큰 값 */
  searches: number;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
};

/** 발견 음식 중 트렌드 비교에 끼워 넣는 개수. 데이터랩 호출이 5개당 1번 늘어난다 */
export const DISCOVERED_IN_TRENDS = 15;

export function parseFoodSeeds(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s) && seen.add(s));
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseDiscovered(raw: string | undefined): DiscoveredFood[] {
  const list = parseJson<unknown>(raw, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((d): d is DiscoveredFood => typeof d?.name === "string" && d.name.trim().length > 0)
    .map((d) => ({
      name: d.name.trim(),
      searches: Number(d.searches) || 0,
      firstSeen: String(d.firstSeen ?? ""),
      lastSeen: String(d.lastSeen ?? ""),
      seenCount: Number(d.seenCount) || 1,
    }))
    .sort((a, b) => b.searches - a.searches);
}

export function parseExcluded(raw: string | undefined): string[] {
  const list = parseJson<unknown>(raw, []);
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

export async function foodSettings(): Promise<FoodSettings> {
  const s = await getSettings(["food_area", "food_seeds", "food_discovered", "food_excluded"]);
  const parsed = parseFoodSeeds(s.food_seeds ?? "");
  const seeds = parsed.length ? parsed : DEFAULT_FOOD_SEEDS;
  const excluded = parseExcluded(s.food_excluded);
  // 목록에 들어갔거나 뺀 것은 발견 목록에서 보이지 않는다 (저장본에 남아 있어도)
  const skip = new Set([...seeds, ...excluded].map(bare));
  const discovered = parseDiscovered(s.food_discovered).filter((d) => !skip.has(bare(d.name)));
  return { area: s.food_area ?? "", seeds, discovered, excluded };
}

export async function saveFoodSettings(o: { area?: string; seeds?: string[] }): Promise<void> {
  if (typeof o.area === "string") await setSetting("food_area", o.area.trim());
  if (Array.isArray(o.seeds)) await setSetting("food_seeds", o.seeds.join(", "));
}

export async function saveDiscovered(list: DiscoveredFood[]): Promise<void> {
  await setSetting("food_discovered", JSON.stringify(list));
}

/** 발견된 음식을 사용자 목록으로 옮긴다. 발견 목록에서는 빠진다 */
export async function adoptDiscovered(name: string): Promise<void> {
  const s = await foodSettings();
  const n = name.trim();
  if (!n) return;
  if (!s.seeds.some((x) => bare(x) === bare(n))) await saveFoodSettings({ seeds: [...s.seeds, n] });
  const raw = await getSettings(["food_discovered"]);
  await saveDiscovered(parseDiscovered(raw.food_discovered).filter((d) => bare(d.name) !== bare(n)));
}

/** 발견된 음식을 뺀다. 제외 목록에 올려 다시 들어오지 않게 한다 */
export async function excludeDiscovered(name: string): Promise<void> {
  const n = name.trim();
  if (!n) return;
  const raw = await getSettings(["food_discovered", "food_excluded"]);
  const excluded = parseExcluded(raw.food_excluded);
  if (!excluded.some((x) => bare(x) === bare(n))) {
    await setSetting("food_excluded", JSON.stringify([...excluded, n]));
  }
  await saveDiscovered(parseDiscovered(raw.food_discovered).filter((d) => bare(d.name) !== bare(n)));
}

/** 트렌드 비교 대상에 끼울 발견 음식. 검색수 상위, 제외·목록 중복은 foodSettings 가 이미 뺐다 */
export function discoveredForTrends(s: FoodSettings): string[] {
  return s.discovered.slice(0, DISCOVERED_IN_TRENDS).map((d) => d.name);
}

/* ------------------------------------------------------------------ *
 * 트렌드 — 지금 오르는 음식
 * ------------------------------------------------------------------ */

export type FoodTrend = {
  food: string;
  /** 최근 석 달 뒤쪽 1/3 이 앞쪽 1/3 대비 몇 % 인지. 데이터랩이 없으면 null */
  delta: number | null;
  /** 주 단위 상대 지수. 묶음마다 따로 정규화돼 음식끼리 높이를 비교하면 안 된다 */
  series: TrendPoint[];
  /** 월간 검색수(PC+모바일). 검색광고 자격증명이 없으면 null */
  searches: number | null;
  /** 사용자 목록이 아니라 자동 발견 목록에서 온 음식 */
  discovered: boolean;
};

export type FoodTrendResult = {
  trends: FoodTrend[];
  /** 한쪽 소스가 죽어도 나머지로 보여준다. 무엇이 빠졌는지 알린다 */
  errors: string[];
};

/** 최근 13주. 석 달이면 계절이 바뀌는 게 보이고, 셋으로 나누면 한 달씩이다 */
function recentWeeks(weeks = 13): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}


/** 힌트 키워드들의 월간 검색수. 연관 키워드도 같이 돌려준다 */
async function monthlySearches(
  keywords: string[],
): Promise<{ exact: Map<string, number>; related: { keyword: string; searches: number }[]; error?: string }> {
  const exact = new Map<string, number>();
  const related: { keyword: string; searches: number }[] = [];
  let error: string | undefined;
  for (const group of chunk(keywords, 5)) {
    const r = await fetchRelatedKeywords(group);
    if (!r.ok) {
      error = r.error;
      // 자격증명이 없으면 나머지 묶음도 같은 답이다
      if (r.status === 0 || r.status === 401 || r.status === 403) break;
      continue;
    }
    const wanted = new Set(group.map(bare));
    for (const k of r.keywords) {
      if (k.totalSearches === null) continue;
      if (wanted.has(bare(k.keyword))) exact.set(bare(k.keyword), k.totalSearches);
      else related.push({ keyword: k.keyword, searches: k.totalSearches });
    }
  }
  return { exact, related, error };
}

/**
 * `seeds` 는 사용자 목록, `extra` 는 발견 목록. 둘 다 같은 방식으로 비교한다.
 *
 * 데이터랩은 한 요청(5개) 안에서 가장 높은 점을 100 으로 두는 상대값이라 묶음이 다르면
 * 높이를 비교할 수 없다. 그래서 순위는 높이가 아니라 각 음식 **자기 곡선 안의 변화율**
 * (trendDelta) 로만 매긴다 — 묶음을 몇 개로 나누든, 발견 음식이 어느 묶음에 끼든 같은 값이다.
 */
export async function foodTrends(seeds: string[], extra: string[] = []): Promise<FoodTrendResult> {
  const errors: string[] = [];
  const bySeed = new Map<string, FoodTrend>(
    seeds.map((food) => [food, { food, delta: null, series: [], searches: null, discovered: false }]),
  );
  const have = new Set(seeds.map(bare));
  for (const food of extra) {
    if (have.has(bare(food))) continue;
    have.add(bare(food));
    bySeed.set(food, { food, delta: null, series: [], searches: null, discovered: true });
  }
  const all = [...bySeed.keys()];

  const creds = await openApiCreds();
  const trendJob = (async () => {
    if (!creds) {
      errors.push("데이터랩 자격증명(네이버 Client ID/Secret)이 없어 추세를 못 봤습니다.");
      return;
    }
    const range = recentWeeks();
    for (const group of chunk(all, TREND_MAX_KEYWORDS)) {
      try {
        const series = await searchTrend({ ...range, keywords: group, timeUnit: "week" }, creds);
        for (const s of series) {
          const t = bySeed.get(s.keyword);
          if (t) {
            t.series = s.data;
            t.delta = trendDelta(s.data);
          }
        }
      } catch (e) {
        errors.push(`데이터랩: ${(e as Error).message}`);
        break;
      }
    }
  })();

  const volumeJob = (async () => {
    const { exact, error } = await monthlySearches(all);
    if (error) errors.push(`검색광고: ${error}`);
    for (const t of bySeed.values()) t.searches = exact.get(bare(t.food)) ?? null;
  })();

  await Promise.all([trendJob, volumeJob]);

  // 오르는 순. 추세를 모르면 검색수로
  const trends = [...bySeed.values()].sort((a, b) => {
    if (a.delta !== null && b.delta !== null) return b.delta - a.delta;
    if (a.delta !== null) return -1;
    if (b.delta !== null) return 1;
    return (b.searches ?? -1) - (a.searches ?? -1);
  });
  return { trends, errors };
}

/** 그 음식을 파는 주변 가게. 위치를 주면 가까운 순, 없으면 동네 이름으로 찾는다 */
export async function nearbyFood(food: string, area: string, near?: Near): Promise<Place[]> {
  const query = near ? food : `${area} ${food}`.trim();
  return searchPlaces(query, 10, near);
}

/* ------------------------------------------------------------------ *
 * 글 키워드 — 제목에 넣을 "지역 + 메뉴" 를 검색수로 고른다
 * ------------------------------------------------------------------ */

export type KeywordPick = { keyword: string; searches: number };

/**
 * 주소에서 동네 이름을 뽑는다. "서울 관악구 신림동 1422-5" → ["신림", "관악"].
 * 사람들은 "신림동 국밥" 보다 "신림 국밥" 으로 검색한다. 끝의 동·구를 뗀다.
 */
export function areaNames(place: Place | null, placeQuery: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  };
  const tokens = `${place?.lotAddress ?? ""} ${place?.address ?? ""}`.split(/\s+/);
  for (const tok of tokens) {
    const dong = tok.match(/^(.+?)\d*동$/);
    if (dong) push(dong[1]);
  }
  for (const tok of tokens) {
    const gu = tok.match(/^(.+)[구군시]$/);
    if (gu && gu[1] !== "서울") push(gu[1]);
  }
  // 장소를 못 찾았으면 사용자가 쓴 첫 단어가 대개 동네다 ("신림동 OO국밥")
  if (!out.length) {
    const first = placeQuery.trim().split(/\s+/)[0] ?? "";
    push(first.replace(/동$/, ""));
  }
  return out.slice(0, 2);
}

/** 메뉴 이름. 업종 마지막 칸("음식점 > 한식 > 국밥" → 국밥)과 메뉴판 앞쪽 메뉴 */
export function menuNames(place: Place | null, analysis: PhotoAnalysis): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\(.*?\)|\[.*?\]/g, "").replace(/\s*(대|중|소|특|보통|곱빼기)$/, "").trim();
    if (t.length >= 2 && t.length <= 8 && !out.includes(t)) out.push(t);
  };
  const cat = place?.category.split(">").pop() ?? "";
  push(cat);
  for (const m of analysis.menu.slice(0, 3)) push(m.name);
  return out.slice(0, 3);
}

/**
 * 후보 조합의 월간 검색수를 보고 많이 찾는 순으로 돌려준다.
 * 자격증명이 없거나 전부 검색수가 없으면 빈 배열 — 그때는 GPT 가 알아서 고른다.
 */
export async function visitKeywords(o: {
  place: Place | null;
  placeQuery: string;
  analysis: PhotoAnalysis;
}): Promise<KeywordPick[]> {
  const areas = areaNames(o.place, o.placeQuery);
  const menus = menuNames(o.place, o.analysis);
  if (!areas.length) return [];

  const candidates: string[] = [];
  for (const a of areas) {
    for (const m of menus) candidates.push(`${a} ${m}`);
    candidates.push(`${a} 맛집`);
  }

  try {
    const { exact, related } = await monthlySearches(candidates);
    const picks: KeywordPick[] = candidates
      .filter((c) => exact.has(bare(c)))
      .map((c) => ({ keyword: c, searches: exact.get(bare(c))! }));
    // 연관 키워드 중 동네와 메뉴를 둘 다 품은 것 — "신림역 국밥" 처럼 후보에 없던 좋은 조합
    for (const r of related) {
      if (!areas.some((a) => r.keyword.includes(a))) continue;
      if (!menus.some((m) => r.keyword.includes(m))) continue;
      if (picks.some((p) => bare(p.keyword) === bare(r.keyword))) continue;
      picks.push({ keyword: r.keyword, searches: r.searches });
    }
    return picks.sort((a, b) => b.searches - a.searches).slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * 제품 후기 키워드. "제품명 후기·단점·내돈내산" 처럼 사람들이 사기 전에 치는 꼴을 비교한다.
 * 검색광고는 띄어쓰기를 뗀 꼴로 집계하므로 후보도 그렇게 맞춘다.
 */
export async function productKeywords(product: string): Promise<KeywordPick[]> {
  const name = product.trim();
  if (!name) return [];
  const candidates = [name, `${name} 후기`, `${name} 단점`, `${name} 내돈내산`, `${name} 추천`];
  try {
    const { exact, related } = await monthlySearches(candidates);
    const picks: KeywordPick[] = candidates
      .filter((c) => exact.has(bare(c)))
      .map((c) => ({ keyword: c, searches: exact.get(bare(c))! }));
    // 연관 키워드 중 제품명을 품은 것 — "OO 청소기 V8 거치대" 처럼 후보에 없던 좋은 조합
    for (const r of related) {
      if (!bare(r.keyword).includes(bare(name))) continue;
      if (picks.some((p) => bare(p.keyword) === bare(r.keyword))) continue;
      picks.push({ keyword: r.keyword, searches: r.searches });
    }
    return picks.sort((a, b) => b.searches - a.searches).slice(0, 5);
  } catch {
    return [];
  }
}
