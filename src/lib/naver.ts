import { getSetting } from "./db";
import type { Keyword, KeywordFetchResult } from "./types";

export const CREATOR_ADVISOR_ORIGIN = "https://creator-advisor.naver.com";

/**
 * 크리에이터 어드바이저는 공개 API 가 아니라서 경로/파라미터가 예고 없이 바뀐다.
 * 그래서 프리셋은 코드에 고정하지 않고 DB(setting: `endpoint_presets`)에 저장하고
 * 설정 화면에서 수정한다. 아래는 최초 1회 시드되는 기본값일 뿐이다.
 */
export type EndpointPreset = {
  id: string;
  label: string;
  path: string;
  /** {{date}}, {{dateStart}}, {{dateEnd}}, {{categoryId}}, {{limit}} 치환 지원 */
  query: Record<string, string>;
};

export const DEFAULT_PRESETS: EndpointPreset[] = [
  {
    id: "category-keyword",
    label: "주제별 인기 유입검색어",
    path: "/api/v6/trend/category-keyword",
    query: {
      serviceType: "NAVER_BLOG",
      categoryId: "{{categoryId}}",
      contentType: "text",
      dateType: "DAY",
      date: "{{date}}",
      limit: "{{limit}}",
    },
  },
  {
    id: "category-popular",
    label: "주제별 인기글 키워드",
    path: "/api/v6/trend/category-popular-contents",
    query: {
      serviceType: "NAVER_BLOG",
      categoryId: "{{categoryId}}",
      contentType: "text",
      dateType: "DAY",
      date: "{{date}}",
      limit: "{{limit}}",
    },
  },
  {
    id: "my-inflow-search",
    label: "내 블로그 유입 검색어",
    path: "/api/v6/inflow-search",
    query: {
      serviceType: "NAVER_BLOG",
      dateType: "DAY",
      startDate: "{{dateStart}}",
      endDate: "{{dateEnd}}",
      limit: "{{limit}}",
    },
  },
];

export { BLOG_CATEGORIES } from "./categories";

export function loadPresets(): EndpointPreset[] {
  const stored = getSetting("endpoint_presets");
  if (!stored) return DEFAULT_PRESETS;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_PRESETS;
  } catch {
    return DEFAULT_PRESETS;
  }
}

/**
 * 브라우저에서 복사한 쿠키 문자열을 정규화한다.
 * 통째로 붙여넣든(`NID_AUT=..; NID_SES=..`) 값만 넣든 받아준다.
 */
export function normalizeCookie(input: string): string {
  return input
    .replace(/^\s*Cookie:\s*/i, "")
    .split(/;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join("; ");
}

export function cookieHasAuth(cookie: string): boolean {
  return /NID_AUT=/.test(cookie) && /NID_SES=/.test(cookie);
}

function interpolate(
  value: string,
  vars: Record<string, string | number | undefined>,
): string {
  return value.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = vars[key];
    return v === undefined ? m : String(v);
  });
}

export function buildUrl(
  preset: EndpointPreset,
  vars: Record<string, string | number | undefined>,
): string {
  const url = new URL(interpolate(preset.path, vars), CREATOR_ADVISOR_ORIGIN);
  for (const [k, v] of Object.entries(preset.query)) {
    const resolved = interpolate(v, vars);
    // 치환되지 않고 남은 플레이스홀더는 값이 없다는 뜻이므로 파라미터 자체를 뺀다
    if (/\{\{\w+\}\}/.test(resolved)) continue;
    if (resolved === "") continue;
    url.searchParams.set(k, resolved);
  }
  return url.toString();
}

/**
 * 응답 스키마가 바뀌어도 살아남도록, JSON 을 훑어서
 * "키워드처럼 생긴 문자열 필드를 가진 객체 배열" 중 가장 큰 것을 찾는다.
 */
const KEYWORD_FIELDS = [
  "keyword",
  "searchKeyword",
  "queryKeyword",
  "query",
  "title",
  "name",
  "word",
];
const METRIC_FIELDS = [
  "count",
  "cv",
  "value",
  "score",
  "searchCount",
  "inflowCount",
  "viewCount",
  "ratio",
  "share",
];
const DELTA_FIELDS = ["rankChange", "diff", "delta", "rankDiff", "change"];

function pickString(obj: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, fields: string[]): number | null {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function findKeywordArray(node: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 8) return null;

  if (Array.isArray(node)) {
    const objects = node.filter(isRecord);
    const usable = objects.filter((o) => pickString(o, KEYWORD_FIELDS) !== null);
    // 절반 이상이 키워드 필드를 가지면 이 배열이 목표 배열이다
    if (usable.length > 0 && usable.length >= objects.length / 2) return usable;

    // 아니면 원소 안쪽을 더 파고든다
    let best: Record<string, unknown>[] | null = null;
    for (const item of node) {
      const found = findKeywordArray(item, depth + 1);
      if (found && (!best || found.length > best.length)) best = found;
    }
    return best;
  }

  if (isRecord(node)) {
    let best: Record<string, unknown>[] | null = null;
    for (const value of Object.values(node)) {
      const found = findKeywordArray(value, depth + 1);
      if (found && (!best || found.length > best.length)) best = found;
    }
    return best;
  }

  return null;
}

export function parseKeywords(payload: unknown): Keyword[] {
  const rows = findKeywordArray(payload);
  if (!rows) return [];
  return rows.map((row, i) => ({
    keyword: pickString(row, KEYWORD_FIELDS) ?? "",
    rank: pickNumber(row, ["rank", "ranking", "order"]) ?? i + 1,
    metric: pickNumber(row, METRIC_FIELDS),
    rankDelta: pickNumber(row, DELTA_FIELDS),
    raw: row,
  }));
}

/** 크리에이터 어드바이저에 GET 요청. 쿠키는 DB 에 저장된 값을 쓴다. */
export async function fetchCreatorAdvisor(url: string): Promise<KeywordFetchResult> {
  const cookie = normalizeCookie(getSetting("naver_cookie") ?? "");
  if (!cookie) {
    return {
      ok: false,
      status: 0,
      requestUrl: url,
      keywords: [],
      raw: null,
      error: "네이버 쿠키가 설정되지 않았습니다. 설정 화면에서 먼저 등록하세요.",
    };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        cookie,
        referer: `${CREATOR_ADVISOR_ORIGIN}/`,
        origin: CREATOR_ADVISOR_ORIGIN,
        accept: "application/json, text/plain, */*",
        "accept-language": "ko-KR,ko;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "x-requested-with": "XMLHttpRequest",
      },
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      requestUrl: url,
      keywords: [],
      raw: null,
      error: `네트워크 오류: ${(e as Error).message}`,
    };
  }

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* JSON 이 아니면 원문 그대로 둔다 — 보통 로그인 리다이렉트 HTML 이다 */
  }

  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " 쿠키가 만료되었을 가능성이 높습니다. 설정에서 다시 붙여넣으세요."
        : res.status === 404
          ? " 엔드포인트 경로가 바뀌었을 수 있습니다. 설정 → 엔드포인트에서 수정하거나 cURL 을 붙여넣으세요."
          : "";
    return {
      ok: false,
      status: res.status,
      requestUrl: url,
      keywords: [],
      raw: parsed,
      error: `요청 실패 (HTTP ${res.status}).${hint}`,
    };
  }

  if (typeof parsed === "string") {
    return {
      ok: false,
      status: res.status,
      requestUrl: url,
      keywords: [],
      raw: parsed.slice(0, 2000),
      error:
        "JSON 이 아닌 응답을 받았습니다 (로그인 페이지일 가능성이 높습니다). 쿠키를 갱신하세요.",
    };
  }

  const keywords = parseKeywords(parsed);
  return {
    ok: true,
    status: res.status,
    requestUrl: url,
    keywords,
    raw: parsed,
    error: keywords.length
      ? undefined
      : "응답은 받았지만 키워드 배열을 찾지 못했습니다. 아래 원본 JSON 을 확인하세요.",
  };
}
