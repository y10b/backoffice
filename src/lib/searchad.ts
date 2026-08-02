import crypto from "node:crypto";
import { getSetting } from "./db";

/**
 * 네이버 검색광고 API (키워드도구).
 * 공개 API 라 경로·스키마가 안정적이고, 쿠키가 아니라 발급받은 키로 인증한다.
 * https://naver.github.io/searchad-apidoc/
 */
export const SEARCHAD_ORIGIN = "https://api.searchad.naver.com";
export const KEYWORDSTOOL_PATH = "/keywordstool";
export const BID_PATH = "/estimate/average-position-bid/keyword";

export type SearchAdCreds = {
  apiKey: string;
  secretKey: string;
  customerId: string;
};

export function searchAdCreds(): SearchAdCreds | null {
  const apiKey =
    getSetting("searchad_api_key") || process.env.NAVER_SEARCHAD_API_KEY || "";
  const secretKey =
    getSetting("searchad_secret_key") || process.env.NAVER_SEARCHAD_SECRET_KEY || "";
  const customerId =
    getSetting("searchad_customer_id") || process.env.NAVER_SEARCHAD_CUSTOMER_ID || "";
  if (!apiKey || !secretKey || !customerId) return null;
  return { apiKey, secretKey, customerId };
}

/**
 * 서명 대상은 `{timestamp}.{METHOD}.{path}` 이고 쿼리스트링은 포함하지 않는다.
 * 결과는 base64.
 */
export function sign(
  timestamp: string,
  method: string,
  path: string,
  secretKey: string,
): string {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${timestamp}.${method}.${path}`)
    .digest("base64");
}

export function authHeaders(
  creds: SearchAdCreds,
  method: string,
  path: string,
  timestamp = String(Date.now()),
): Record<string, string> {
  return {
    "X-Timestamp": timestamp,
    "X-API-KEY": creds.apiKey,
    "X-Customer": creds.customerId,
    "X-Signature": sign(timestamp, method, path, creds.secretKey),
    accept: "application/json",
  };
}

/**
 * 키워드별 1위 노출 예상 입찰가(원).
 *
 * 애드센스 단가를 네이버가 알려주지는 않지만, 같은 한국 시장에서 같은 광고주가 그 키워드에
 * 얼마를 쓰는지를 보여주므로 수익성의 대리 지표로 쓸 수 있다.
 * 블로그 유입은 대부분 모바일이라 MOBILE 기준으로 받는다.
 *
 * 개별 키워드가 아니라 배치로 받는다. 실패해도 검색량 표는 살아야 하므로 던지지 않고
 * 빈 Map 을 돌려준다.
 */
export async function fetchBids(
  keywords: string[],
  device: "PC" | "MOBILE" = "MOBILE",
): Promise<{ bids: Map<string, number>; error?: string }> {
  const bids = new Map<string, number>();
  const creds = searchAdCreds();
  if (!creds || !keywords.length) return { bids };

  const CHUNK = 50;
  let firstError: string | undefined;

  for (let i = 0; i < keywords.length; i += CHUNK) {
    const chunk = keywords.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${SEARCHAD_ORIGIN}${BID_PATH}`, {
        method: "POST",
        headers: {
          ...authHeaders(creds, "POST", BID_PATH),
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          device,
          keywordplus: false,
          key: "",
          items: chunk.map((k) => ({ key: k, position: 1 })),
        }),
      });
      if (!res.ok) {
        firstError ??= `HTTP ${res.status}`;
        continue;
      }
      const data = (await res.json()) as {
        estimate?: { keyword?: string; bid?: number }[];
      };
      for (const e of data.estimate ?? []) {
        if (typeof e.keyword === "string" && typeof e.bid === "number") {
          bids.set(e.keyword, e.bid);
        }
      }
    } catch (e) {
      firstError ??= (e as Error).message;
    }
  }

  return { bids, error: firstError };
}

/**
 * 월간 검색수는 10 미만이면 실수치 대신 `"< 10"` 으로 마스킹돼서 온다.
 * 숫자로 다루기 위해 9 로 환산하고, 콤마가 섞인 문자열도 받아준다.
 */
export function parseCount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    if (/^<\s*10$/.test(t)) return 9;
    const n = Number(t.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export type RelKeyword = {
  keyword: string;
  pcSearches: number | null;
  mobileSearches: number | null;
  totalSearches: number | null;
  /** 경쟁정도: 높음 / 중간 / 낮음 */
  adCompetition: string | null;
  /** 월평균 노출 광고수 (0~15). 높을수록 광고가 화면을 많이 덮는다 */
  adDepth: number | null;
  /** 월평균 광고 클릭수 (PC + 모바일) */
  adClicks: number | null;
  /** 월평균 광고 클릭률 %. PC/모바일 중 큰 쪽 */
  adCtr: number | null;
  raw: Record<string, unknown>;
};

export type SearchAdResult = {
  ok: boolean;
  status: number;
  keywords: RelKeyword[];
  requestUrl: string;
  error?: string;
};

/** 힌트 키워드는 최대 5개. 검색광고는 공백을 제거한 형태를 기준으로 집계한다. */
export function normalizeHints(seeds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of seeds) {
    const k = s.replace(/\s+/g, "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length === 5) break;
  }
  return out;
}

export function parseRelKeywords(payload: unknown): RelKeyword[] {
  const list = (payload as { keywordList?: unknown })?.keywordList;
  if (!Array.isArray(list)) return [];
  return list
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => {
      const pc = parseCount(r.monthlyPcQcCnt);
      const mobile = parseCount(r.monthlyMobileQcCnt);
      const total = pc === null && mobile === null ? null : (pc ?? 0) + (mobile ?? 0);

      const pcClicks = parseCount(r.monthlyAvePcClkCnt);
      const mobileClicks = parseCount(r.monthlyAveMobileClkCnt);
      const clicks =
        pcClicks === null && mobileClicks === null
          ? null
          : (pcClicks ?? 0) + (mobileClicks ?? 0);

      const pcCtr = parseCount(r.monthlyAvePcCtr);
      const mobileCtr = parseCount(r.monthlyAveMobileCtr);
      const ctr =
        pcCtr === null && mobileCtr === null
          ? null
          : Math.max(pcCtr ?? 0, mobileCtr ?? 0);

      return {
        keyword: String(r.relKeyword ?? "").trim(),
        pcSearches: pc,
        mobileSearches: mobile,
        totalSearches: total,
        adCompetition: typeof r.compIdx === "string" ? r.compIdx : null,
        adDepth: parseCount(r.plAvgDepth),
        adClicks: clicks,
        adCtr: ctr,
        raw: r,
      };
    })
    .filter((k) => k.keyword.length > 0);
}

/** 힌트 키워드로 연관 키워드 + 월간 검색수를 가져온다. */
export async function fetchRelatedKeywords(seeds: string[]): Promise<SearchAdResult> {
  const creds = searchAdCreds();
  const hints = normalizeHints(seeds);
  const url = new URL(KEYWORDSTOOL_PATH, SEARCHAD_ORIGIN);
  url.searchParams.set("hintKeywords", hints.join(","));
  url.searchParams.set("showDetail", "1");
  const requestUrl = url.toString();

  if (!creds) {
    return {
      ok: false,
      status: 0,
      keywords: [],
      requestUrl,
      error:
        "검색광고 API 자격증명이 없습니다. 설정 화면에서 API 키·비밀키·CUSTOMER_ID 를 등록하세요.",
    };
  }
  if (!hints.length) {
    return {
      ok: false,
      status: 0,
      keywords: [],
      requestUrl,
      error: "시드 키워드를 하나 이상 입력하세요.",
    };
  }

  let res: Response;
  try {
    res = await fetch(requestUrl, {
      headers: authHeaders(creds, "GET", KEYWORDSTOOL_PATH),
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      keywords: [],
      requestUrl,
      error: `네트워크 오류: ${(e as Error).message}`,
    };
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* JSON 이 아니면 아래에서 원문을 오류로 노출한다 */
  }

  if (!res.ok) {
    const detail =
      (parsed as { title?: string; detail?: string })?.title ??
      (parsed as { detail?: string })?.detail ??
      text.slice(0, 300);
    // 네이버는 키가 틀리면 403 Invalid API-KEY, 서명이 안 맞으면 401 로 나눠서 준다
    const hint =
      res.status === 401 || res.status === 403
        ? " API 키·비밀키·CUSTOMER_ID 를 다시 확인하세요. 세 값은 같은 계정의 것이어야 하고, PC 시각이 크게 어긋나도 서명이 깨집니다."
        : res.status === 429
          ? " 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요."
          : "";
    return {
      ok: false,
      status: res.status,
      keywords: [],
      requestUrl,
      error: `검색광고 API 오류 (HTTP ${res.status}): ${detail}${hint}`,
    };
  }

  const keywords = parseRelKeywords(parsed);
  return {
    ok: true,
    status: res.status,
    keywords,
    requestUrl,
    error: keywords.length ? undefined : "연관 키워드가 반환되지 않았습니다.",
  };
}
