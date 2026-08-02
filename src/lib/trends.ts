/**
 * 구글 트렌드 실시간 급상승 검색어 (한국).
 *
 * 네이버 실시간 검색어는 폐지됐고 데이터랩 급상승은 API 신규 발급이 막혀서,
 * 인증 없이 쓸 수 있는 공식 소스는 이 RSS 뿐이다.
 *
 * 다만 급상승어는 대부분 스포츠·연예라 애드센스 단가가 바닥이다.
 * 그대로 보여주면 쓸모가 없어서, 호출부에서 검색광고 단가를 붙여 거른다.
 */
const TRENDS_RSS = "https://trends.google.com/trending/rss?geo=KR";

export type TrendingItem = {
  keyword: string;
  /** RSS 가 주는 대략적 검색량 표기(`2000+`)를 숫자로 */
  approxTraffic: number | null;
};

/** `<![CDATA[..]]>` 를 벗기고 XML 엔티티를 되돌린다. */
function decodeXml(s: string): string {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** `2000+` / `1,000+` → 2000 / 1000. 해석 못 하면 null. */
export function parseTraffic(s: string): number | null {
  const n = Number(s.replace(/[+,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * RSS 를 훑어 `<item>` 단위로 자른 뒤 제목과 트래픽을 뽑는다.
 * 채널 제목("Daily Search Trends")이 섞이지 않게 item 안쪽만 본다.
 */
export function parseTrendsRss(xml: string): TrendingItem[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const out: TrendingItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(item);
    if (!title) continue;
    const keyword = decodeXml(title[1]);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);

    const traffic = /<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(item);
    out.push({
      keyword,
      approxTraffic: traffic ? parseTraffic(decodeXml(traffic[1])) : null,
    });
  }
  return out;
}

export async function fetchTrending(): Promise<TrendingItem[]> {
  const res = await fetch(TRENDS_RSS, {
    headers: { accept: "application/rss+xml, application/xml, text/xml" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`구글 트렌드 RSS 오류 (HTTP ${res.status})`);
  return parseTrendsRss(await res.text());
}
