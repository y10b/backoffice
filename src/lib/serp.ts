/**
 * 네이버 블로그 검색 결과(SERP) 분석.
 *
 * 원래는 검색 API 로 "총 문서수"를 받아 경쟁률을 냈지만, 두 가지가 동시에 막혔다.
 *  - 검색 API 는 신규 앱에 스코프를 주지 않는다 (401 Scope Status Invalid)
 *  - 검색 결과 페이지도 총 건수 표기를 없앴다 (PC/모바일/구탭 모두 확인)
 *
 * 그래서 "얼마나 많이 있나"(공급량) 대신 "지금 상위를 누가 얼마나 단단히 잡고 있나"를 본다.
 * 상위권 글이 전부 최근이면 계속 갈아치워지는 레드오션이고, 인플루언서가 덮고 있으면
 * 일반 블로그는 밀린다.
 *
 * 공식 API 가 아니라 공개 검색 페이지를 사용자가 버튼을 눌렀을 때만 읽는다.
 * 마크업이 바뀌면 깨지므로, 해시된 클래스명 대신 값이 든 디자인시스템 클래스에만 기댄다.
 */

const SEARCH_URL = "https://search.naver.com/search.naver";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 결과 아이템의 발행일이 들어가는 유일하게 안정적인 앵커 */
const DATE_ANCHOR = /sds-comps-profile-info-subtext[^>]*>([^<]{1,20})</g;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `2026.02.21.` 같은 절대 표기와 `4주 전` / `6일 전` / `어제` 같은 상대 표기를 모두
 * "며칠 전인지"로 환산한다. 해석 못 하면 null.
 */
export function parseAgeDays(text: string, now = Date.now()): number | null {
  const t = text.trim();

  const abs = t.match(/^(20\d{2})\.(\d{1,2})\.(\d{1,2})\.?$/);
  if (abs) {
    const [, y, mo, d] = abs;
    const published = Date.UTC(Number(y), Number(mo) - 1, Number(d));
    return Math.max(0, Math.round((now - published) / DAY_MS));
  }

  if (/^오늘$/.test(t)) return 0;
  if (/^어제$/.test(t)) return 1;

  const rel = t.match(/^(\d+)\s*(분|시간|일|주|개월|달|년)\s*전$/);
  if (rel) {
    const n = Number(rel[1]);
    switch (rel[2]) {
      case "분":
      case "시간":
        return 0;
      case "일":
        return n;
      case "주":
        return n * 7;
      case "개월":
      case "달":
        return n * 30;
      case "년":
        return n * 365;
    }
  }
  return null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export type SerpStats = {
  /** 분석한 상위 결과 수 */
  results: number;
  /** 발행일 경과일 중앙값. 작을수록 상위권이 최근 글로 채워져 있다 */
  medianAgeDays: number | null;
  /** 최근 30일 내 글 비율 % */
  freshShare: number | null;
  /** 상위 노출 블로그 중 인플루언서 비율 % */
  influencerShare: number | null;
  /**
   * 진입 난이도 0~100 (경험칙).
   * 최근 글 비율과 인플루언서 비율을 절반씩 섞는다. 높을수록 비집고 들어가기 어렵다.
   */
  difficulty: number | null;
};

export function parseSerp(html: string, now = Date.now()): SerpStats {
  const subtexts = [...html.matchAll(DATE_ANCHOR)].map((m) => m[1]);
  const ages = subtexts
    .map((s) => parseAgeDays(s, now))
    .filter((v): v is number => v !== null);

  // 결과에 실제로 뜬 블로그 핸들
  const blogHandles = new Set(
    [...html.matchAll(/blog\.naver\.com\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  );
  /*
   * in.naver.com 아래에는 home, delivery 같은 네이버 내부 경로도 섞인다.
   * 결과 블로그 핸들과 겹치는 것만 인플루언서로 센다 — 그러면 내부 경로가 자연히 걸러진다.
   */
  const influencerHandles = new Set(
    [...html.matchAll(/in\.naver\.com\/([A-Za-z0-9_-]+)/g)]
      .map((m) => m[1])
      .filter((h) => blogHandles.has(h)),
  );

  const results = subtexts.length;
  const pct = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

  const freshShare = ages.length
    ? pct(ages.filter((a) => a <= 30).length, ages.length)
    : null;
  const influencerShare = blogHandles.size
    ? pct(influencerHandles.size, blogHandles.size)
    : null;

  const difficulty =
    freshShare === null && influencerShare === null
      ? null
      : Math.round((freshShare ?? 0) * 0.5 + (influencerShare ?? 0) * 0.5);

  return {
    results,
    medianAgeDays: median(ages),
    freshShare,
    influencerShare,
    difficulty,
  };
}

export type SerpResult = { keyword: string; stats: SerpStats | null; error?: string };

async function fetchSerp(keyword: string): Promise<SerpStats> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("ssc", "tab.blog.all");
  url.searchParams.set("query", keyword);

  const res = await fetch(url.toString(), {
    headers: {
      "user-agent": UA,
      "accept-language": "ko-KR,ko;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const stats = parseSerp(html);
  if (stats.results === 0) {
    throw new Error(
      "결과를 하나도 읽지 못했습니다. 네이버가 마크업을 바꿨거나 일시적으로 막았을 수 있습니다.",
    );
  }
  return stats;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 여러 키워드를 순차에 가깝게 조회한다.
 * 사용자가 버튼을 눌렀을 때만 도는 소량 요청이라, 동시 실행을 2로 낮추고 사이에 텀을 둔다.
 */
export async function analyzeSerps(
  keywords: string[],
  { concurrency = 2, delayMs = 400 } = {},
): Promise<SerpResult[]> {
  const out: SerpResult[] = keywords.map((keyword) => ({ keyword, stats: null }));
  let cursor = 0;

  async function worker(slot: number) {
    await sleep(slot * delayMs);
    while (cursor < keywords.length) {
      const i = cursor++;
      try {
        out[i].stats = await fetchSerp(keywords[i]);
      } catch (e) {
        out[i].error = (e as Error).message;
      }
      await sleep(delayMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, keywords.length) }, (_, i) => worker(i)),
  );
  return out;
}
