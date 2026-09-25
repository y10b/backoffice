/**
 * 실제로 올라간 티스토리 글 — 사이트맵과 글 페이지를 읽어 tistory_posts 에 쌓는다.
 *
 *  | 누가                 | 언제          | 하는 일                                   |
 *  |----------------------|---------------|-------------------------------------------|
 *  | syncInsights         | 매일 09:30    | syncTistoryPosts — 사이트맵 → 글마다 파싱 |
 *  | /api/tistory/sync    | 화면 버튼     | 같은 함수를 지금 돌린다                   |
 *  | /api/tistory         | 화면          | listTistoryPosts — 글 + 최근 90일 유입    |
 *  | dailyPost            | 초안 만들 때  | findOverlap · classifyCategory            |
 *
 * 왜 페이지를 읽나: 티스토리 오픈 API 는 닫혔고, 백오피스는 자기가 만든 초안(posts)만 안다.
 * 사람이 직접 올리거나 고친 글·카테고리를 알 방법은 공개 페이지뿐이다. 사이트맵이 글 목록을,
 * 글 페이지가 제목·카테고리·발행 시각을 준다. 비공개 글은 사이트맵에 없으니 여기도 없다.
 *
 * 카테고리는 스킨과 무관한 `window.T.entryInfo.categoryLabel` 을 먼저 보고, 없으면 본문 위
 * `class="category"` 요소(스킨에 따라 a 또는 span)의 글자를 쓴다. `article:section` 은
 * 티스토리 홈 주제('생활정보')라 카테고리가 아니다 — home_topic 으로 따로 둔다.
 */
import { getSettings, kstDate, supabase } from "./db";
import { pageTotals, pathKey, type PageTotal } from "./insights";

const DEFAULT_BLOG = "https://testao.tistory.com";
/** 블로그에 부담을 주지 않을 만큼만 — 동시 3개, 요청 사이 200ms */
const CONCURRENCY = 3;
const GAP_MS = 200;
const FETCH_TIMEOUT_MS = 15_000;
const STATS_DAYS = 90;
const UA = "Mozilla/5.0 (compatible; backoffice-sync/1.0)";

/** 블로그 카테고리 재편 기준. 화면 세그먼트·배지 색이 이 넷만 구분한다 */
export const CATEGORIES = ["세금·신고", "보험·연금", "지원금·수당", "기타"] as const;
export type Category = (typeof CATEGORIES)[number];

/* ------------------------------------------------------------------ *
 * 파싱 (순수 함수)
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** 티스토리는 카테고리 이름의 가운뎃점을 &middot; 로 내보낸다. 흔한 것만 푼다 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function safeDecodeURI(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type SitemapEntry = { url: string; slug: string; lastmod: string | null };

/**
 * 사이트맵에서 글(/entry/…)만. 카테고리·태그·홈은 건너뛴다.
 * 사이트맵 색인(<sitemapindex>)이면 하위 사이트맵 주소를 따로 돌려준다.
 */
export function parseSitemap(xml: string, origin: string): { entries: SitemapEntry[]; children: string[] } {
  const host = new URL(origin).host;
  const children: string[] = [];
  if (/<sitemapindex[\s>]/i.test(xml)) {
    for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<]+?)\s*<\/loc>[\s\S]*?<\/sitemap>/gi)) {
      children.push(decodeEntities(m[1]));
    }
    return { entries: [], children };
  }
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(m[1])?.[1];
    if (!loc) continue;
    const url = decodeEntities(loc);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.host !== host || !u.pathname.startsWith("/entry/")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[1])?.[1] ?? null;
    entries.push({ url, slug: safeDecodeURI(u.pathname.slice("/entry/".length)), lastmod });
  }
  return { entries, children };
}

export type PageMeta = {
  title: string;
  category: string;
  homeTopic: string;
  publishedAt: string | null;
};

/** <meta property|name="key" content="…"> — 속성 순서가 바뀌어도 읽는다 */
function metaMap(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (key && content !== undefined && !out.has(key)) out.set(key, decodeEntities(content).trim());
  }
  return out;
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

export function parsePostPage(html: string): PageMeta {
  const meta = metaMap(html);

  let title = meta.get("og:title") ?? "";
  if (!title) title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");

  let category = "";
  const label = /"categoryLabel"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
  if (label) {
    try {
      category = String(JSON.parse(label)).trim();
    } catch {
      /* 아래 대안으로 */
    }
  }
  if (!category) {
    // 사이드바 <nav class="category"> 는 목록 전체라 건너뛴다 — a·span 만 본다
    const el = /<(a|span)\b[^>]*\bclass="category"[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
    if (el) category = stripTags(el[2]);
  }

  // article:section 은 "'생활정보'" 처럼 따옴표째 온다
  const homeTopic = (meta.get("article:section") ?? "").replace(/^['"]+|['"]+$/g, "").trim();
  const published = meta.get("article:published_time") ?? "";
  const publishedAt = published && !Number.isNaN(Date.parse(published)) ? published : null;

  return { title, category, homeTopic, publishedAt };
}

/* ------------------------------------------------------------------ *
 * 카테고리 추정 · 겹침 판정 (순수 함수)
 * ------------------------------------------------------------------ */

/**
 * 카테고리별 단서. 한 단어가 여러 곳에 걸리면(고용보험 실업급여) 맞은 단서 글자 수 합이 큰 쪽.
 * 긴 단서가 짧은 단서를 품는 경우(국민연금 ⊃ 연금)는 둘 다 세어 더 구체적인 쪽이 무겁다.
 *
 * "세" 한 글자는 전세·월세·세대에도 걸려서 부분 문자열로 쓰지 않는다. 대신 "…세" 로 끝나는
 * 낱말(종합소득세·양도세)을 따로 잡되 전세·월세는 뺀다.
 */
const CLUES: Record<Exclude<Category, "기타">, string[]> = {
  "세금·신고": [
    "세금", "세무", "세액", "소득세", "부가세", "부가가치세", "종소세", "양도세", "증여세", "상속세",
    "취득세", "재산세", "과세", "절세", "신고", "소득", "부가", "원천징수", "사업자", "홈택스",
    "장부", "경비", "연말정산", "공제", "환급", "간이과세", "세무사", "3.3",
  ],
  "보험·연금": [
    "보험", "연금", "퇴직", "퇴직금", "irp", "건보", "건강보험", "국민연금", "고용보험", "산재",
    "실손", "4대보험", "보험료", "연금저축", "노후",
  ],
  "지원금·수당": [
    "지원금", "장려금", "수당", "실업급여", "지원", "바우처", "청년", "보조금", "지원사업", "혜택",
    "급여신청", "근로장려금", "자녀장려금", "출산", "육아",
  ],
};
/** 점수가 같을 때 앞쪽 */
const TIE_ORDER: Category[] = ["세금·신고", "지원금·수당", "보험·연금"];

function clueScore(text: string, cat: Exclude<Category, "기타">): number {
  const t = text.toLowerCase().replace(/\s+/g, "");
  let score = 0;
  for (const c of CLUES[cat]) if (t.includes(c)) score += c.length;
  if (cat === "세금·신고") {
    // "…세" 로 끝나는 낱말 (종합소득세·양도세). 전세·월세·세대는 아니다
    for (const w of text.split(/[\s·,/()\-]+/)) {
      if (w.length >= 2 && w.endsWith("세") && !/(전|월)세$/.test(w)) score += 1;
    }
  }
  return score;
}

/** 초안이 들어갈 카테고리. 키워드가 제목보다 두 배 무겁다 */
export function classifyCategory(keyword: string, title = ""): Category {
  let best: Category = "기타";
  let bestScore = 0;
  for (const cat of TIE_ORDER) {
    const c = cat as Exclude<Category, "기타">;
    const s = clueScore(keyword, c) * 2 + clueScore(title, c);
    if (s > bestScore) {
      best = cat;
      bestScore = s;
    }
  }
  return best;
}

/**
 * 겹침 판정에서 빼는 낱말. 제목마다 붙는 말이라 이게 남으면 "신고 방법" 같은 키워드가
 * 아무 글과도 겹치지 않거나(너무 엄격) 모든 글과 겹친다.
 */
const FILLER = new Set([
  "방법", "신청", "신청방법", "총정리", "정리", "조건", "대상", "기간", "기준", "최신", "최신판",
  "가이드", "알아보기", "하는법", "하는", "법", "꿀팁", "팁", "정보", "총", "완벽", "한눈에",
  "쉽게", "모든", "것", "및", "후기", "안내", "요약", "비교", "차이", "뜻", "란",
]);

const bareText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** 키워드의 핵심 토큰 — 기호로 끊고, 연도·채움말·한 글자는 뺀다 */
export function coreTokens(keyword: string): string[] {
  return keyword
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !FILLER.has(t) && !/^(19|20)\d\d(년)?$/.test(t));
}

/**
 * 키워드가 기존 글 제목과 겹치나. 핵심 토큰이 (공백·기호를 뺀) 제목에 전부 들어 있으면 겹친다.
 * "프리랜서 종합소득세" ↔ "프리랜서 종합소득세 신고 방법 총정리 (2026 최신판)" → 겹침.
 * 키워드도구처럼 띄어쓰기 없는 키워드("프리랜서종합소득세")도 통째 토큰 하나로 같은 결과가 난다.
 */
export function titleOverlaps(keyword: string, title: string): boolean {
  const tokens = coreTokens(keyword);
  if (!tokens.length) return false;
  const t = bareText(title);
  return tokens.every((tok) => t.includes(tok));
}

/* ------------------------------------------------------------------ *
 * 동기화
 * ------------------------------------------------------------------ */

/** 설정 tistory_url → gsc_site_url(URL 접두어 속성일 때) → 기본값. 끝 슬래시 없는 origin */
export async function tistoryBlogUrl(): Promise<string> {
  const s = await getSettings(["tistory_url", "gsc_site_url"]);
  for (const raw of [s.tistory_url, s.gsc_site_url]) {
    const v = (raw ?? "").trim();
    if (!/^https?:\/\//i.test(v)) continue; // sc-domain: 속성은 주소가 아니다
    try {
      return new URL(v).origin;
    } catch {
      /* 다음 후보 */
    }
  }
  return DEFAULT_BLOG;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xml;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/** 사이트맵(색인이면 하위까지)에서 글 목록 */
export async function fetchSitemapEntries(origin?: string): Promise<SitemapEntry[]> {
  const base = origin ?? (await tistoryBlogUrl());
  const first = parseSitemap(await fetchText(`${base}/sitemap.xml`), base);
  const entries = [...first.entries];
  for (const child of first.children) {
    entries.push(...parseSitemap(await fetchText(child), base).entries);
  }
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchedPost = SitemapEntry & { meta: PageMeta | null; error?: string };

/** 글 페이지를 동시 CONCURRENCY 개로 읽는다. 각 일꾼은 요청 사이 GAP_MS 쉰다. 실패는 meta=null */
export async function fetchPostPages(entries: SitemapEntry[]): Promise<FetchedPost[]> {
  const out: FetchedPost[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      const e = entries[i];
      try {
        out[i] = { ...e, meta: parsePostPage(await fetchText(e.url)) };
      } catch (err) {
        out[i] = { ...e, meta: null, error: (err as Error).message };
      }
      await sleep(GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  return out;
}

export type TistorySyncResult = {
  /** 사이트맵에 있는 글 수 */
  total: number;
  /** 제목·카테고리까지 새로 쓴 글 수 */
  updated: number;
  /** 페이지를 읽지 못한 글 수 — last_seen 만 갱신했다 */
  failed: number;
};

/**
 * 사이트맵 → 글 페이지 → tistory_posts upsert(url 기준).
 * 사이트맵에서 사라진 글은 지우지 않는다 — last_seen 이 멈춘다.
 * 페이지를 못 읽은 글은 제목·카테고리를 빈 값으로 덮지 않도록 url·lastmod·last_seen 만 쓴다.
 */
export async function syncTistoryPosts(): Promise<TistorySyncResult> {
  const entries = await fetchSitemapEntries();
  const pages = await fetchPostPages(entries);
  const today = kstDate(0);

  const full = pages
    .filter((p) => p.meta)
    .map((p) => ({
      url: p.url,
      slug: p.slug,
      title: p.meta!.title,
      category: p.meta!.category,
      home_topic: p.meta!.homeTopic,
      published_at: p.meta!.publishedAt,
      lastmod: p.lastmod,
      last_seen: today,
    }));
  const partial = pages
    .filter((p) => !p.meta)
    .map((p) => ({ url: p.url, slug: p.slug, lastmod: p.lastmod, last_seen: today }));

  for (const rows of [full, partial]) {
    if (!rows.length) continue;
    const { error } = await supabase().from("tistory_posts").upsert(rows, { onConflict: "url" });
    if (error) throw new Error(`tistory_posts 저장 실패: ${error.message}`);
  }
  return { total: entries.length, updated: full.length, failed: partial.length };
}

/* ------------------------------------------------------------------ *
 * 읽기
 * ------------------------------------------------------------------ */

export type TistoryPostRow = {
  url: string;
  slug: string;
  title: string;
  category: string;
  home_topic: string;
  published_at: string | null;
  lastmod: string | null;
  last_seen: string;
};

async function selectTistoryPosts(): Promise<TistoryPostRow[]> {
  const { data, error } = await supabase()
    .from("tistory_posts")
    .select("url, slug, title, category, home_topic, published_at, lastmod, last_seen")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(2000);
  if (error) throw new Error(`tistory_posts 조회 실패: ${error.message}`);
  return (data ?? []) as TistoryPostRow[];
}

export type TistoryPostStat = {
  url: string;
  title: string;
  category: string;
  published_at: string | null;
  last_seen: string;
  views: number;
  sessions: number;
  impressions: number;
  clicks: number;
  /** 노출 가중 평균 순위. 노출이 없으면 null */
  position: number | null;
};

/** 모바일 페이지(/m/entry/…)로 들어온 조회도 같은 글이다 */
function statsFor(totals: Map<string, PageTotal>, url: string): PageTotal {
  const key = pathKey(url);
  const parts = [totals.get(key), totals.get(`/m${key}`)].filter((x): x is PageTotal => Boolean(x));
  let views = 0, sessions = 0, clicks = 0, impressions = 0, posWeighted = 0;
  for (const p of parts) {
    views += p.views;
    sessions += p.sessions;
    clicks += p.clicks;
    impressions += p.impressions;
    posWeighted += (p.position ?? 0) * p.impressions;
  }
  return {
    views,
    sessions,
    clicks,
    impressions,
    position: impressions ? Math.round((posWeighted / impressions) * 10) / 10 : null,
  };
}

/** 올라간 글 + 최근 90일 유입. 유입 표 조회가 실패해도 글 목록은 준다(수치 0) */
export async function listTistoryPosts(): Promise<TistoryPostStat[]> {
  const [rows, totals] = await Promise.all([
    selectTistoryPosts(),
    pageTotals(STATS_DAYS).catch(() => new Map<string, PageTotal>()),
  ]);
  return rows.map((r) => ({
    url: r.url,
    title: r.title || r.slug,
    category: r.category,
    published_at: r.published_at,
    last_seen: r.last_seen,
    ...statsFor(totals, r.url),
  }));
}

/** 카테고리별 글 수. 재편 기준 넷을 앞에, 나머지(옛 카테고리)는 많은 순 */
export function countCategories(posts: { category: string }[]): { name: string; count: number }[] {
  const by = new Map<string, number>();
  for (const p of posts) by.set(p.category, (by.get(p.category) ?? 0) + 1);
  const rank = (n: string) => {
    const i = (CATEGORIES as readonly string[]).indexOf(n);
    return i < 0 ? CATEGORIES.length : i;
  };
  return [...by.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => rank(a.name) - rank(b.name) || b.count - a.count || a.name.localeCompare(b.name));
}

export type Overlap = { url: string; title: string; category: string };

/** 제목 목록에서 겹치는 글. 제목이 짧은(= 주제가 좁은, 더 딱 맞는) 순 */
export function overlapsIn(keyword: string, posts: Overlap[]): Overlap[] {
  return posts
    .filter((p) => p.title && titleOverlaps(keyword, p.title))
    .sort((a, b) => a.title.length - b.title.length);
}

/** 올라간 글 제목 목록 (겹침 판정용) */
export async function loadTistoryTitles(): Promise<Overlap[]> {
  return (await selectTistoryPosts()).map((r) => ({ url: r.url, title: r.title, category: r.category }));
}

/** 키워드와 겹치는 기존 글 */
export async function findOverlap(keyword: string): Promise<Overlap[]> {
  return overlapsIn(keyword, await loadTistoryTitles());
}
