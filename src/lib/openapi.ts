import { getSetting } from "./db";

/**
 * 네이버 개발자센터 오픈 API (developers.naver.com).
 * 검색 API(블로그 문서수)와 데이터랩 검색어트렌드가 같은 Client ID/Secret 을 쓴다.
 */
export const OPENAPI_ORIGIN = "https://openapi.naver.com";

export type OpenApiCreds = { clientId: string; clientSecret: string };

export function openApiCreds(): OpenApiCreds | null {
  const clientId = getSetting("naver_client_id") || process.env.NAVER_CLIENT_ID || "";
  const clientSecret =
    getSetting("naver_client_secret") || process.env.NAVER_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function headers(creds: OpenApiCreds, json = false): Record<string, string> {
  return {
    "X-Naver-Client-Id": creds.clientId,
    "X-Naver-Client-Secret": creds.clientSecret,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function errorDetail(status: number, text: string): string {
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    msg = j?.errorMessage ?? j?.message ?? msg;
  } catch {
    /* 원문 유지 */
  }

  // 401 이 두 가지를 겸한다. 키가 틀리면 NID AUTH Result Invalid,
  // 키는 맞고 앱에 그 API 권한이 없으면 Scope Status Invalid 가 온다.
  const scopeDenied = /scope/i.test(msg);
  const hint =
    scopeDenied || status === 403
      ? " 키는 유효하지만 이 애플리케이션에 해당 API 사용 권한이 없습니다. 네이버가 검색·데이터랩 API 신규 신청을 받지 않고 있어, 기존에 승인된 앱이 아니면 열 수 없습니다."
      : status === 401
        ? " Client ID/Secret 이 잘못됐습니다."
        : status === 429
          ? " 일일 호출 한도를 초과했습니다."
          : "";
  return `HTTP ${status}: ${msg}${hint}`;
}

/* ------------------------------------------------------------------ *
 * 검색 API — 블로그 총 문서수
 * ------------------------------------------------------------------ */

/**
 * 키워드로 검색되는 블로그 문서 총 개수.
 * 결과 본문은 필요 없어서 display=1 로 최소한만 받는다.
 */
export async function blogDocCount(
  keyword: string,
  creds: OpenApiCreds,
): Promise<number | null> {
  const url = new URL("/v1/search/blog.json", OPENAPI_ORIGIN);
  url.searchParams.set("query", keyword);
  url.searchParams.set("display", "1");

  const res = await fetch(url.toString(), {
    headers: headers(creds),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(errorDetail(res.status, await res.text()));

  const data = (await res.json()) as { total?: unknown };
  return typeof data.total === "number" ? data.total : null;
}

/** 여러 키워드의 문서수를 동시 실행 수를 제한해가며 조회한다. 개별 실패는 null 로 남긴다. */
export async function blogDocCounts(
  keywords: string[],
  creds: OpenApiCreds,
  concurrency = 4,
): Promise<{ counts: Map<string, number>; error?: string }> {
  const counts = new Map<string, number>();
  let firstError: string | undefined;
  let cursor = 0;

  async function worker() {
    while (cursor < keywords.length) {
      const kw = keywords[cursor++];
      try {
        const n = await blogDocCount(kw, creds);
        if (n !== null) counts.set(kw, n);
      } catch (e) {
        firstError ??= (e as Error).message;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, keywords.length) }, worker),
  );
  return { counts, error: firstError };
}

/* ------------------------------------------------------------------ *
 * 데이터랩 — 검색어 트렌드
 * ------------------------------------------------------------------ */

export type TrendPoint = { period: string; ratio: number };
export type TrendSeries = { keyword: string; data: TrendPoint[] };

export type TrendOptions = {
  keywords: string[];
  startDate: string;
  endDate: string;
  timeUnit?: "date" | "week" | "month";
};

/** 데이터랩은 키워드 그룹을 최대 5개까지만 받는다. */
export const TREND_MAX_KEYWORDS = 5;

/**
 * 검색어별 상대 지수를 가져온다.
 * 조회 구간 전체에서 가장 큰 검색량이 100 이 되도록 정규화되므로 키워드 간 비교가 가능하다.
 */
export async function searchTrend(
  o: TrendOptions,
  creds: OpenApiCreds,
): Promise<TrendSeries[]> {
  const keywords = o.keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, TREND_MAX_KEYWORDS);
  if (!keywords.length) return [];

  const res = await fetch(`${OPENAPI_ORIGIN}/v1/datalab/search`, {
    method: "POST",
    headers: headers(creds, true),
    cache: "no-store",
    body: JSON.stringify({
      startDate: o.startDate,
      endDate: o.endDate,
      timeUnit: o.timeUnit ?? "week",
      keywordGroups: keywords.map((k) => ({ groupName: k, keywords: [k] })),
    }),
  });
  if (!res.ok) throw new Error(errorDetail(res.status, await res.text()));

  const data = (await res.json()) as {
    results?: { title?: string; data?: { period?: string; ratio?: number }[] }[];
  };
  return (data.results ?? []).map((r) => ({
    keyword: String(r.title ?? ""),
    data: (r.data ?? [])
      .filter((p) => typeof p.ratio === "number")
      .map((p) => ({ period: String(p.period ?? ""), ratio: p.ratio as number })),
  }));
}

/**
 * 추세를 한 숫자로 요약한다. 뒤쪽 1/3 평균이 앞쪽 1/3 평균 대비 몇 % 인지.
 * 점이 3개 미만이면 판단할 수 없어 null.
 */
export function trendDelta(data: TrendPoint[]): number | null {
  if (data.length < 3) return null;
  const span = Math.max(1, Math.floor(data.length / 3));
  const avg = (xs: TrendPoint[]) => xs.reduce((s, p) => s + p.ratio, 0) / xs.length;
  const head = avg(data.slice(0, span));
  const tail = avg(data.slice(-span));
  if (head <= 0) return null;
  return Math.round(((tail - head) / head) * 100);
}
