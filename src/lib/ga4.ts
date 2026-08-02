import { getSettings } from "./db";
import {
  GA4_READONLY_SCOPE,
  getAccessToken,
  parseServiceAccount,
  type ServiceAccount,
} from "./google-auth";

/**
 * GA4 Data API (runReport).
 *
 * 티스토리는 자체 통계가 거칠어서 어떤 글이 실제로 돈이 되는지 보이지 않는다.
 * GA4 를 붙여 글별 조회수·체류시간과 일별 추이를 백오피스 안에서 본다.
 * https://developers.google.com/analytics/devguides/reporting/data/v1/rest
 */
export const GA4_ORIGIN = "https://analyticsdata.googleapis.com";

export const DEFAULT_DAYS = 28;
export const MAX_DAYS = 365;
/** 글 목록은 상위 몇 개만 보면 되고, 티스토리 블로그 한 개의 URL 수를 넉넉히 덮는다. */
const PAGE_LIMIT = 250;

export type Ga4Page = {
  path: string;
  title: string;
  views: number;
  users: number;
  /** 평균 세션 시간(초). 소수점은 화면에서 쓸 일이 없어 반올림해 둔다. */
  avgSeconds: number;
};

export type Ga4Daily = {
  /** `YYYY-MM-DD` */
  date: string;
  views: number;
  users: number;
};

export type Ga4Report = {
  ok: boolean;
  days: number;
  totals: { views: number; users: number };
  pages: Ga4Page[];
  daily: Ga4Daily[];
  error?: string;
};

export type Ga4Creds = {
  serviceAccount: ServiceAccount;
  propertyId: string;
};

/**
 * 1~365 로 자른다. 범위를 벗어난 값은 조용히 기본값으로 되돌린다.
 *
 * `?days` 가 없으면 searchParams.get 이 null 을 주는데, Number(null) 은 0 이라
 * 그냥 clamp 하면 1일치만 나온다. 빈 문자열도 마찬가지라 숫자로 바꾸기 전에 걸러낸다.
 */
export function clampDays(v: unknown): number {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) {
    return DEFAULT_DAYS;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.trunc(n)));
}

/**
 * 설정에서 자격증명을 읽는다.
 *
 * 자격증명이 없는 것은 오류가 아니라 "아직 설정을 안 한 상태"다. 다른 라우트와 마찬가지로
 * 던지지 않고 안내 문구를 돌려줘서 대시보드가 500 대신 설명을 띄우게 한다.
 */
export async function ga4Creds(): Promise<{ creds: Ga4Creds } | { error: string }> {
  const s = await getSettings(["ga4_service_account", "ga4_property_id"]);
  const raw = (s.ga4_service_account || "").trim();
  const propertyId = (s.ga4_property_id || "").trim();

  if (!raw) {
    return {
      error:
        "GA4 서비스 계정이 설정되지 않았습니다. 설정 화면에 GCP 서비스 계정 JSON 키를 붙여넣으세요.",
    };
  }
  if (!propertyId) {
    return {
      error:
        "GA4 속성 ID 가 설정되지 않았습니다. GA4 관리 → 속성 설정에 있는 숫자 속성 ID(예: 123456789)를 입력하세요.",
    };
  }
  // 측정 ID(G-XXXXXXX)를 속성 ID 로 착각하는 사례가 가장 흔해서 호출 전에 걸러낸다.
  if (!/^\d+$/.test(propertyId)) {
    return {
      error: `GA4 속성 ID 는 숫자만 들어갑니다. "${propertyId}" 는 측정 ID(G-XXXXXXXXXX)나 스트림 ID 일 가능성이 큽니다. GA4 관리 → 속성 설정 화면 오른쪽 위의 숫자 ID 를 넣으세요.`,
    };
  }

  try {
    return { creds: { serviceAccount: parseServiceAccount(raw), propertyId } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

type RunReportResponse = {
  rows?: {
    dimensionValues?: { value?: string }[];
    metricValues?: { value?: string }[];
  }[];
  totals?: { metricValues?: { value?: string }[] }[];
};

/** GA4 는 수치를 전부 문자열로 준다. 파싱 실패는 0 으로 떨어뜨려 표가 깨지지 않게 한다. */
function num(v?: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** `20260801` → `2026-08-01` */
function isoDate(compact: string): string {
  return /^\d{8}$/.test(compact)
    ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
    : compact;
}

/**
 * 쿼리스트링을 떼어낸 경로.
 * 티스토리는 같은 글이 `?category=`, `?m=1` 같은 꼬리를 달고 여러 행으로 흩어져서,
 * 정리하지 않으면 인기글 순위가 실제보다 낮게 보인다.
 */
export function normalizePath(path: string): string {
  const cut = path.split(/[?#]/)[0] ?? path;
  return cut.length > 1 ? cut.replace(/\/+$/, "") : cut;
}

/**
 * pagePath + pageTitle 조합을 경로 기준으로 합친다.
 * 제목을 고친 글은 GA4 에서 옛 제목/새 제목 두 줄로 나뉘어 오므로, 조회수가 많은 쪽 제목을
 * 대표로 세우고 수치는 더한다. 평균 체류시간은 단순 평균이 아니라 조회수 가중 평균이라야
 * 조회수 1 짜리 이상치가 순위를 흔들지 않는다.
 */
export function mergePages(
  rows: NonNullable<RunReportResponse["rows"]>,
): Ga4Page[] {
  type Acc = Ga4Page & { titleViews: number; durationWeighted: number };
  const byPath = new Map<string, Acc>();

  for (const row of rows) {
    const path = normalizePath(row.dimensionValues?.[0]?.value ?? "");
    if (!path) continue;
    const title = (row.dimensionValues?.[1]?.value ?? "").trim();
    const views = num(row.metricValues?.[0]?.value);
    const users = num(row.metricValues?.[1]?.value);
    const avgSeconds = num(row.metricValues?.[2]?.value);

    const prev = byPath.get(path);
    if (!prev) {
      byPath.set(path, {
        path,
        title: title || path,
        views,
        users,
        avgSeconds: 0,
        titleViews: views,
        durationWeighted: avgSeconds * views,
      });
      continue;
    }
    prev.views += views;
    // activeUsers 는 원래 중복 제거된 값이라 더하면 살짝 부풀지만, 행 단위로는 이 방법뿐이다.
    prev.users += users;
    prev.durationWeighted += avgSeconds * views;
    if (title && views > prev.titleViews) {
      prev.title = title;
      prev.titleViews = views;
    }
  }

  return [...byPath.values()]
    .map(({ titleViews: _t, durationWeighted, ...p }) => ({
      ...p,
      avgSeconds: p.views > 0 ? Math.round(durationWeighted / p.views) : 0,
    }))
    .sort((a, b) => b.views - a.views);
}

export function parseDaily(rows: NonNullable<RunReportResponse["rows"]>): Ga4Daily[] {
  return rows
    .map((row) => ({
      date: isoDate(row.dimensionValues?.[0]?.value ?? ""),
      views: num(row.metricValues?.[0]?.value),
      users: num(row.metricValues?.[1]?.value),
    }))
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * runReport 실패 문구. 상태 코드만 던지면 사용자가 GCP 와 GA4 중 어디를 봐야 할지 모른다.
 * 실제로 손댈 화면 이름까지 적는다.
 */
export function explainGa4Error(
  status: number,
  raw: string,
  clientEmail: string,
  propertyId: string,
): string {
  let message = "";
  let reason = "";
  try {
    const e = (JSON.parse(raw) as {
      error?: { message?: string; status?: string; details?: { reason?: string }[] };
    }).error;
    message = e?.message ?? "";
    reason = `${e?.status ?? ""} ${(e?.details ?? []).map((d) => d?.reason ?? "").join(" ")}`;
  } catch {
    message = raw.slice(0, 300);
  }

  const blob = `${reason} ${message}`;

  // API 미활성화는 403 으로도 오고 다른 코드로도 와서 상태 코드보다 문구로 먼저 가른다.
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(blob)) {
    return `Google Analytics Data API 가 사용 설정되지 않았습니다. GCP 콘솔 → API 및 서비스 → 라이브러리에서 "Google Analytics Data API" 를 사용 설정한 뒤 몇 분 기다렸다 다시 시도하세요. (${message})`;
  }
  if (status === 403) {
    return `속성에 접근할 권한이 없습니다 (HTTP 403). GA4 관리 → 속성 액세스 관리에서 서비스 계정 이메일 ${clientEmail} 을 뷰어로 추가했는지 확인하세요. 계정이 아니라 "속성" 수준에 추가해야 합니다. (${message})`;
  }
  if (status === 404 || /property|PROPERTY/.test(blob)) {
    return `속성 ID ${propertyId} 를 찾지 못했습니다 (HTTP ${status}). 측정 ID(G-XXXXXXXXXX)가 아니라 GA4 관리 → 속성 설정에 표시되는 숫자 속성 ID 인지 확인하세요. (${message})`;
  }
  if (status === 400) {
    return `요청이 거부됐습니다 (HTTP 400): ${message}`;
  }
  if (status === 401) {
    return `인증이 만료되었거나 키가 잘못됐습니다 (HTTP 401). 서비스 계정 키를 다시 발급받고 PC 시각을 확인하세요. (${message})`;
  }
  if (status === 429) {
    return "GA4 API 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요.";
  }
  return `GA4 API 오류 (HTTP ${status}): ${message}`;
}

async function runReport(
  creds: Ga4Creds,
  token: string,
  body: Record<string, unknown>,
): Promise<RunReportResponse> {
  const url = `${GA4_ORIGIN}/v1beta/properties/${creds.propertyId}:runReport`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      explainGa4Error(res.status, text, creds.serviceAccount.clientEmail, creds.propertyId),
    );
  }
  try {
    return JSON.parse(text) as RunReportResponse;
  } catch {
    throw new Error("GA4 응답을 해석하지 못했습니다. 잠시 후 다시 시도하세요.");
  }
}

function emptyReport(days: number, error?: string): Ga4Report {
  // 실패해도 모양은 성공과 같게 준다. 화면 쪽에서 undefined 를 방어할 필요가 없다.
  return { ok: false, days, totals: { views: 0, users: 0 }, pages: [], daily: [], error };
}

/**
 * 글별 성과 + 일별 추이를 한 번에 가져온다.
 *
 * 기간은 오늘을 포함해 days 일. 오늘치는 아직 집계 중이라 마지막 점이 낮게 찍히지만,
 * "오늘 얼마나 들어왔나" 를 보려고 대시보드를 여는 쪽이 많아 잘라내지 않는다.
 */
export async function fetchGa4Report(daysInput: unknown): Promise<Ga4Report> {
  const days = clampDays(daysInput);

  const resolved = await ga4Creds();
  if ("error" in resolved) return emptyReport(days, resolved.error);
  const { creds } = resolved;

  let token: string;
  try {
    token = await getAccessToken(creds.serviceAccount, GA4_READONLY_SCOPE);
  } catch (e) {
    return emptyReport(days, (e as Error).message);
  }

  const dateRanges = [{ startDate: `${days - 1}daysAgo`, endDate: "today" }];

  try {
    const [pagesRes, dailyRes] = await Promise.all([
      runReport(creds, token, {
        dateRanges,
        dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
        metrics: [
          { name: "screenPageViews" },
          { name: "activeUsers" },
          { name: "averageSessionDuration" },
        ],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: PAGE_LIMIT,
      }),
      runReport(creds, token, {
        dateRanges,
        dimensions: [{ name: "date" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
        orderBys: [{ dimension: { dimensionName: "date" } }],
        limit: MAX_DAYS + 1,
        // 총 사용자수는 일별 합계가 아니다(같은 사람이 여러 날 오면 중복). GA4 가 계산한
        // 기간 전체 중복 제거 값을 받으려고 TOTAL 집계를 함께 요청한다.
        metricAggregations: ["TOTAL"],
      }),
    ]);

    const daily = parseDaily(dailyRes.rows ?? []);
    const totalRow = dailyRes.totals?.[0]?.metricValues;
    const totals = totalRow
      ? { views: num(totalRow[0]?.value), users: num(totalRow[1]?.value) }
      : {
          views: daily.reduce((s, d) => s + d.views, 0),
          users: daily.reduce((s, d) => s + d.users, 0),
        };

    return {
      ok: true,
      days,
      totals,
      pages: mergePages(pagesRes.rows ?? []),
      daily,
    };
  } catch (e) {
    return emptyReport(days, (e as Error).message);
  }
}
