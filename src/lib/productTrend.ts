import { bare, foodTrends, monthlySearches, type FoodTrend } from "./foodTrend";

/**
 * 상품 트렌드 — 요즘 어떤 상품이 뜨는지.
 *
 * 나중에 제휴 링크(쿠팡 파트너스 API, 오늘의집·올리브영 큐레이터)를 붙일 자리의 앞단이다.
 * 지금은 "무엇이 오르는가" 까지만 본다. 링크는 붙이지 않는다 — 쿠팡은 최종 승인 전이고,
 * 오늘의집·올리브영은 API 가 없어 공유 버튼으로만 발급해야 한다(2026-09 조사).
 *
 *   카테고리 시드 → 검색광고 연관 키워드(월 1,000+) → 규칙 정리 → 검색어트렌드 변화율 → 오르는 순
 *
 * 추세 계산은 음식 트렌드(foodTrends)와 같은 엔진을 쓴다. 데이터랩은 묶음마다 따로 정규화된
 * 상대값이라, 순위는 높이가 아니라 각 키워드 자기 곡선 안의 변화율로만 매긴다.
 *
 * 쇼핑 인사이트(쇼핑 카테고리 클릭 추세)는 쓰지 않는다. NAVER API HUB 경로를 확인하지 못했고,
 * 검색어트렌드는 HUB 키로 실제 확인이 끝났다.
 */

export type ProductCategory = {
  key: string;
  label: string;
  /** 주로 어디서 파는지. 화면의 찾아보기 링크를 고른다 */
  shops: ShopKey[];
  seeds: string[];
};

export type ShopKey = "coupang" | "ohou" | "oliveyoung" | "naver";

/** 시드는 넓게 잡는다. 연관 키워드가 여기서 뻗어 나가므로 대표 상품군이면 충분하다 */
export const PRODUCT_CATEGORIES: ProductCategory[] = [
  {
    key: "living",
    label: "생활·자취템",
    shops: ["coupang", "ohou", "naver"],
    seeds: ["자취템", "무선청소기", "가습기", "전기요", "제습기", "수납용품", "로봇청소기", "공기청정기"],
  },
  {
    key: "interior",
    label: "인테리어·가구",
    shops: ["ohou", "coupang", "naver"],
    seeds: ["인테리어소품", "무드등", "러그", "암막커튼", "원룸 인테리어", "책상", "침대프레임"],
  },
  {
    key: "beauty",
    label: "뷰티",
    shops: ["oliveyoung", "naver", "coupang"],
    seeds: ["올리브영 추천템", "선크림", "쿠션팩트", "토너패드", "립틴트", "클렌징오일", "수분크림"],
  },
  {
    key: "digital",
    label: "디지털·가전",
    shops: ["coupang", "naver"],
    seeds: ["무선이어폰", "보조배터리", "태블릿", "모니터", "기계식키보드", "전기포트"],
  },
  {
    key: "food",
    label: "식품·간식",
    shops: ["coupang", "naver"],
    seeds: ["편의점 신상", "단백질음료", "제로음료", "닭가슴살", "간식 추천", "밀키트"],
  },
];

/** 찾아보기 링크. 제휴 링크가 아니라 그냥 검색 결과 페이지다 — 제휴 링크는 각 곳에서 직접 발급한다 */
export const SHOP_SEARCH: Record<ShopKey, { label: string; url: (q: string) => string }> = {
  coupang: { label: "쿠팡", url: (q) => `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}` },
  ohou: { label: "오늘의집", url: (q) => `https://ohou.se/search/index?query=${encodeURIComponent(q)}` },
  oliveyoung: {
    label: "올리브영",
    url: (q) => `https://www.oliveyoung.co.kr/store/search/getSearchMain.do?query=${encodeURIComponent(q)}`,
  },
  naver: { label: "네이버쇼핑", url: (q) => `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(q)}` },
};

/** 이보다 적게 찾는 키워드는 유행이라 보기 어렵다 */
const MIN_SEARCHES = 1000;
/** 추세를 볼 후보 수. 데이터랩은 5개씩이라 25개면 다섯 번 부른다 */
const MAX_CANDIDATES = 25;

/** 이 말이 들어가면 살 물건을 찾는 검색이 아니다 */
const DROP = /수리|렌탈|렌털|중고|as센터|a\/s|고장|폐기|버리는|나눔|채용|알바|자격증|사용법|청소법|세척법|뜻|원리|설치|매장|영업시간|고객센터|환불|교환|만드는법|레시피|칼로리|부작용|주가|주식|배터리교체|도안/i;
/** 끝에 붙는 말. 떼고 남은 게 상품 이름이다 ("무선청소기추천" → "무선청소기") */
const STRIP = /(추천순위|추천|순위|비교|후기|리뷰|가성비|best|베스트|최저가|할인|싼곳|파는곳)$/i;

/** 규칙 정리. 상품 검색이 아니면 null */
export function cleanProductKeyword(keyword: string): string | null {
  let k = bare(keyword);
  if (DROP.test(k)) return null;
  for (let i = 0; i < 3; i++) {
    const next = k.replace(STRIP, "");
    if (next === k) break;
    k = next;
  }
  if (k.length < 2 || k.length > 14) return null;
  return k;
}

export type ProductTrend = FoodTrend & {
  /** 이 키워드가 시드인지, 연관 키워드에서 발견된 것인지 */
  seed: boolean;
};

export type ProductTrendResult = {
  category: string;
  trends: ProductTrend[];
  errors: string[];
};

export async function productTrends(categoryKey: string, extraSeeds: string[] = []): Promise<ProductTrendResult> {
  const cat = PRODUCT_CATEGORIES.find((c) => c.key === categoryKey) ?? PRODUCT_CATEGORIES[0];
  const seeds = [...new Set([...cat.seeds, ...extraSeeds].map((s) => s.trim()).filter(Boolean))];
  const errors: string[] = [];

  // 1) 시드의 연관 키워드에서 상품 이름을 모은다. 같은 상품의 변형은 검색수가 큰 쪽으로 합친다
  const { exact, related, error } = await monthlySearches(seeds);
  if (error) errors.push(`검색광고: ${error}`);
  const best = new Map<string, number>();
  const add = (keyword: string, searches: number) => {
    const k = cleanProductKeyword(keyword);
    if (!k || searches < MIN_SEARCHES) return;
    if ((best.get(k) ?? -1) < searches) best.set(k, searches);
  };
  for (const r of related) add(r.keyword, r.searches);
  for (const s of seeds) add(s, exact.get(bare(s)) ?? 0);

  const seedSet = new Set(seeds.map((s) => cleanProductKeyword(s) ?? bare(s)));
  const candidates = [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([k]) => k);
  // 검색광고가 죽었으면 시드만으로라도 추세를 본다
  const pool = candidates.length ? candidates : seeds;

  // 2) 추세. 검색수는 1) 에서 이미 알았으니 채워 넣는다
  const r = await foodTrends(pool);
  errors.push(...r.errors.filter((e) => !e.startsWith("검색광고")));
  const trends: ProductTrend[] = r.trends.map((t) => ({
    ...t,
    searches: best.get(bare(t.food)) ?? t.searches,
    seed: seedSet.has(bare(t.food)),
  }));
  return { category: cat.key, trends, errors };
}
