import crypto from "node:crypto";
import { getSetting, getSettings, setSetting } from "./db";
import { oauthRedirectUri } from "./origin";

/**
 * 구글 애드센스 Management API v2.
 *
 * GA4 와 달리 애드센스는 서비스 계정을 지원하지 않는다. 반드시 계정 주인이 브라우저에서
 * 동의해 받은 refresh_token 으로만 호출할 수 있어서, 이 파일이 토큰 살림살이(동의 URL 조립 →
 * 코드 교환 → access_token 갱신·캐시)까지 함께 맡는다.
 */
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const ADSENSE_ORIGIN = "https://adsense.googleapis.com";
export const SCOPE = "https://www.googleapis.com/auth/adsense.readonly";

/**
 * OAuth 클라이언트에 등록한 값과 한 글자라도 다르면 redirect_uri_mismatch 가 난다.
 * 요청 Host 에서 유추하면 127.0.0.1 · 다른 포트로 새는 순간 깨지므로 환경변수로 고정한다.
 * APP_ORIGIN 을 바꾸면 GCP 콘솔의 승인된 리디렉션 URI 도 같이 고쳐야 한다.
 */
export const REDIRECT_URI = oauthRedirectUri();

/** 설정 테이블 키. 오타로 조용히 어긋나는 걸 막으려고 한곳에 모은다. */
export const KEY_CLIENT_ID = "adsense_client_id";
export const KEY_CLIENT_SECRET = "adsense_client_secret";
export const KEY_REFRESH_TOKEN = "adsense_refresh_token";
export const KEY_ACCOUNT = "adsense_account";
export const KEY_STATE = "adsense_oauth_state";

/* ------------------------------------------------------------------ *
 * 자격증명
 * ------------------------------------------------------------------ */

export type AdsenseCreds = { clientId: string; clientSecret: string };

/** DB 값이 우선이고, 없으면 환경변수로 떨어진다(다른 API 들과 같은 규칙). */
export async function adsenseCreds(): Promise<AdsenseCreds | null> {
  const s = await getSettings([KEY_CLIENT_ID, KEY_CLIENT_SECRET]);
  const clientId = s[KEY_CLIENT_ID] || process.env.ADSENSE_CLIENT_ID || "";
  const clientSecret = s[KEY_CLIENT_SECRET] || process.env.ADSENSE_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * refresh_token 은 환경변수 폴백을 두지 않는다.
 * 폐기된 토큰을 지워 재연결로 유도하는 흐름이 있는데, 환경변수는 지울 수가 없어서
 * "지웠는데도 계속 같은 오류" 라는 막다른 길이 생긴다.
 */
export async function storedRefreshToken(): Promise<string> {
  return (await getSetting(KEY_REFRESH_TOKEN)) || "";
}

/* ------------------------------------------------------------------ *
 * 동의 화면 (순수 함수)
 * ------------------------------------------------------------------ */

export function newState(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** state 는 발급 시각을 붙여 저장한다. 오래된 콜백을 되돌려주는 공격을 막기 위해서다. */
export function stateRecord(state: string, now = Date.now()): string {
  return `${state}.${now}`;
}

/**
 * 저장해둔 state 기록과 콜백으로 돌아온 값을 대조한다.
 * 길이·내용을 timingSafeEqual 로 비교하고, 10분이 지난 기록은 무효로 본다.
 */
export function verifyState(
  record: string | null | undefined,
  received: string | null | undefined,
  now = Date.now(),
  ttlMs = 10 * 60 * 1000,
): boolean {
  if (!record || !received) return false;
  const sep = record.lastIndexOf(".");
  if (sep <= 0) return false;

  const saved = record.slice(0, sep);
  const issuedAt = Number(record.slice(sep + 1));
  if (!Number.isFinite(issuedAt)) return false;
  // 시계가 조금 어긋나도 되도록 미래 방향으로는 1분까지 봐준다
  if (now - issuedAt > ttlMs || issuedAt - now > 60 * 1000) return false;

  const a = Buffer.from(saved, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function buildConsentUrl(
  clientId: string,
  state: string,
  redirectUri = REDIRECT_URI,
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  // refresh_token 은 offline + 재동의(prompt=consent) 일 때만 내려온다.
  // 둘 중 하나라도 빠지면 두 번째 연결부터 토큰이 비어 조용히 실패한다.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * 오류 문구 (순수 함수) — 비밀키·토큰은 절대 담지 않는다
 * ------------------------------------------------------------------ */

/** 토큰 엔드포인트(accounts.google.com) 오류를 사용자가 손댈 수 있는 말로 바꾼다. */
export function tokenErrorMessage(
  status: number,
  code: string,
  description = "",
): string {
  const tail = description ? ` (${description})` : "";
  switch (code) {
    case "invalid_grant":
      return (
        "저장된 애드센스 인증이 더 이상 유효하지 않습니다. " +
        "구글 비밀번호 변경, 6개월 이상 미사용, 또는 OAuth 동의 화면이 '테스트' 상태라 7일 만에 만료된 경우입니다. " +
        "설정 화면에서 애드센스를 다시 연결해 주세요."
      );
    case "redirect_uri_mismatch":
      return (
        `OAuth 클라이언트에 리디렉션 URI 가 등록돼 있지 않습니다. ` +
        `GCP > API 및 서비스 > 사용자 인증 정보에서 해당 클라이언트의 '승인된 리디렉션 URI' 에 ` +
        `${REDIRECT_URI} 를 그대로 추가하세요.`
      );
    case "invalid_client":
      return "OAuth 클라이언트 ID 또는 시크릿이 잘못됐습니다. 설정 화면에서 다시 확인하세요.";
    case "access_denied":
      return "구글 동의 화면에서 권한을 거부했습니다. 다시 시도하고 '허용' 을 눌러 주세요.";
    case "invalid_request":
      return `요청 형식이 잘못됐습니다.${tail}`;
    default:
      return `구글 인증 오류 (HTTP ${status})${code ? `: ${code}` : ""}${tail}`;
  }
}

/** adsense.googleapis.com 오류를 사용자가 손댈 수 있는 말로 바꾼다. */
export function apiErrorMessage(status: number, body: string): string {
  let message = body.slice(0, 300);
  let reason = "";
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; status?: string; details?: { reason?: string }[]; errors?: { reason?: string }[] };
    };
    message = j.error?.message ?? message;
    reason =
      j.error?.errors?.[0]?.reason ??
      j.error?.details?.find((d) => d?.reason)?.reason ??
      j.error?.status ??
      "";
  } catch {
    /* JSON 이 아니면 원문 앞부분을 그대로 쓴다 */
  }

  if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(`${reason} ${message}`)) {
    return (
      "GCP 프로젝트에서 AdSense Management API 가 활성화돼 있지 않습니다(accessNotConfigured). " +
      "GCP > API 및 서비스 > 라이브러리에서 'AdSense Management API' 를 사용 설정한 뒤, 몇 분 기다렸다가 다시 시도하세요."
    );
  }
  if (status === 403) {
    return `애드센스 접근이 거부됐습니다: ${message} 동의한 구글 계정이 애드센스 계정의 소유자인지 확인하세요.`;
  }
  if (status === 401) {
    return "액세스 토큰이 거부됐습니다. 설정 화면에서 애드센스를 다시 연결해 주세요.";
  }
  if (status === 429) {
    return "애드센스 API 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요.";
  }
  return `애드센스 API 오류 (HTTP ${status}): ${message}`;
}

/* ------------------------------------------------------------------ *
 * access_token — 메모리 캐시
 * ------------------------------------------------------------------ */

type CachedToken = { key: string; token: string; expiresAt: number };

/**
 * 토큰은 프로세스 메모리에만 둔다. DB 에 쓰면 유효기간 1시간짜리를 디스크에 남기게 되고,
 * 어차피 갱신 비용이 요청 한 번이라 이득이 없다.
 */
let cachedToken: CachedToken | null = null;

/** 클라이언트나 refresh_token 이 바뀌면 캐시가 자동으로 무효화되도록 지문을 만든다(원문은 남기지 않는다). */
function tokenCacheKey(clientId: string, refreshToken: string): string {
  return crypto.createHash("sha256").update(`${clientId}\n${refreshToken}`).digest("hex");
}

/** 테스트·재연결 직후처럼 강제로 비워야 할 때 쓴다. */
export function clearTokenCache(): void {
  cachedToken = null;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type TokenPost =
  | { ok: true; data: TokenResponse }
  | { ok: false; error: string; invalidGrant: boolean };

/** 토큰 엔드포인트는 JSON 이 아니라 x-www-form-urlencoded 를 받는다. */
async function postToken(form: Record<string, string>): Promise<TokenPost> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `네트워크 오류: ${(e as Error).message}`, invalidGrant: false };
  }

  const text = await res.text();
  let parsed: TokenResponse & { error?: string; error_description?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 형식이 깨졌으면 아래에서 상태 코드만으로 안내한다 */
  }

  if (!res.ok) {
    const code = String(parsed.error ?? "");
    return {
      ok: false,
      // 요청 본문에는 client_secret 이 들어 있으므로 응답 쪽 문구만 쓴다
      error: tokenErrorMessage(res.status, code, String(parsed.error_description ?? "")),
      invalidGrant: code === "invalid_grant",
    };
  }
  return { ok: true, data: parsed };
}

export type CodeExchange =
  | { ok: true; refreshToken: string; accessToken: string }
  | { ok: false; error: string };

/** 콜백으로 받은 code 를 refresh_token 으로 바꾼다. */
export async function exchangeCode(
  code: string,
  creds: AdsenseCreds,
  redirectUri = REDIRECT_URI,
): Promise<CodeExchange> {
  const r = await postToken({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!r.ok) return { ok: false, error: r.error };

  const refreshToken = String(r.data.refresh_token ?? "");
  if (!refreshToken) {
    return {
      ok: false,
      error:
        "구글이 refresh_token 을 주지 않았습니다. 이미 동의한 계정을 재사용하면 생기는 일입니다. " +
        "구글 계정 > 보안 > 서드파티 앱에서 이 앱의 액세스를 삭제한 뒤 다시 연결하세요.",
    };
  }
  return { ok: true, refreshToken, accessToken: String(r.data.access_token ?? "") };
}

export type TokenResult = { ok: true; token: string } | { ok: false; error: string; connected: boolean };

/**
 * 저장된 refresh_token 으로 access_token 을 얻는다.
 * 만료 60초 전까지는 메모리 캐시를 그대로 쓴다(호출 도중 만료되는 경계를 피하려는 여유분).
 */
export async function getAccessToken(): Promise<TokenResult> {
  const creds = await adsenseCreds();
  if (!creds) {
    return {
      ok: false,
      connected: false,
      error:
        "애드센스 OAuth 클라이언트 ID/시크릿이 없습니다. 설정 화면에서 먼저 등록하세요.",
    };
  }

  const refreshToken = await storedRefreshToken();
  if (!refreshToken) {
    return {
      ok: false,
      connected: false,
      error: "애드센스 연결이 필요합니다. 설정 화면의 [애드센스 연결] 버튼으로 구글 동의를 마치세요.",
    };
  }

  const key = tokenCacheKey(creds.clientId, refreshToken);
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now()) {
    return { ok: true, token: cachedToken.token };
  }

  const r = await postToken({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!r.ok) {
    if (r.invalidGrant) {
      // 폐기된 토큰을 계속 쥐고 있으면 매번 같은 실패를 반복한다. 지워서 재연결로 유도한다.
      await setSetting(KEY_REFRESH_TOKEN, "");
      cachedToken = null;
    }
    return { ok: false, error: r.error, connected: !r.invalidGrant };
  }

  const token = String(r.data.access_token ?? "");
  if (!token) {
    return { ok: false, error: "구글이 액세스 토큰을 주지 않았습니다.", connected: true };
  }
  const expiresIn = Number(r.data.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  cachedToken = { key, token, expiresAt: Date.now() + Math.max(30, ttl - 60) * 1000 };
  return { ok: true, token };
}

/* ------------------------------------------------------------------ *
 * API 호출
 * ------------------------------------------------------------------ */

type ApiResult = { ok: true; data: unknown } | { ok: false; error: string };

async function apiGet(url: string, token: string): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `네트워크 오류: ${(e as Error).message}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, error: apiErrorMessage(res.status, text) };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: "애드센스 응답을 JSON 으로 읽지 못했습니다." };
  }
}

/**
 * `accounts/pub-XXXXXXXX` 형태의 계정 이름.
 * 리포트마다 다시 조회할 이유가 없으므로 한 번 알아내면 설정에 캐시한다.
 */
export async function resolveAccount(token: string): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  const cached = (await getSetting(KEY_ACCOUNT)) || "";
  if (cached) return { ok: true, account: cached };

  const r = await apiGet(`${ADSENSE_ORIGIN}/v2/accounts`, token);
  if (!r.ok) return r;

  const accounts = (r.data as { accounts?: { name?: string }[] })?.accounts ?? [];
  const name = String(accounts[0]?.name ?? "");
  if (!name) {
    return {
      ok: false,
      error:
        "이 구글 계정에 연결된 애드센스 계정이 없습니다. 애드센스에 로그인한 그 계정으로 동의했는지 확인하세요.",
    };
  }
  await setSetting(KEY_ACCOUNT, name);
  return { ok: true, account: name };
}

/* ------------------------------------------------------------------ *
 * 리포트 (조립·매핑은 순수 함수)
 * ------------------------------------------------------------------ */

export const METRIC = {
  earnings: "ESTIMATED_EARNINGS",
  pageViews: "PAGE_VIEWS",
  clicks: "CLICKS",
  impressions: "IMPRESSIONS",
  cpc: "COST_PER_CLICK",
} as const;

export const REPORT_METRICS: string[] = Object.values(METRIC);

export type Ymd = { year: number; month: number; day: number };

/** UTC 로 밀면 한국에선 하루가 어긋나므로 현지 시각 기준으로 자른다. */
export function ymd(d: Date): Ymd {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export function ymdToIso(v: Ymd): string {
  return `${String(v.year).padStart(4, "0")}-${String(v.month).padStart(2, "0")}-${String(v.day).padStart(2, "0")}`;
}

/** 오늘을 포함한 최근 N일 구간. days=1 이면 오늘 하루만 본다. */
export function dateRange(days: number, today = new Date()): { start: Ymd; end: Ymd } {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: ymd(start), end: ymd(end) };
}

/**
 * reports:generate 는 startDate/endDate 를 중첩 객체로 받지만 GET 이라
 * `startDate.year` 처럼 점 표기 쿼리 파라미터로 펼쳐 넘긴다.
 */
export function buildReportUrl(opts: {
  account: string;
  start: Ymd;
  end: Ymd;
  dimensions?: string[];
  metrics?: string[];
  orderBy?: string[];
  limit?: number;
}): string {
  const url = new URL(`${ADSENSE_ORIGIN}/v2/${opts.account}/reports:generate`);
  const q = url.searchParams;
  q.set("startDate.year", String(opts.start.year));
  q.set("startDate.month", String(opts.start.month));
  q.set("startDate.day", String(opts.start.day));
  q.set("endDate.year", String(opts.end.year));
  q.set("endDate.month", String(opts.end.month));
  q.set("endDate.day", String(opts.end.day));
  for (const m of opts.metrics ?? REPORT_METRICS) q.append("metrics", m);
  for (const d of opts.dimensions ?? []) q.append("dimensions", d);
  for (const o of opts.orderBy ?? []) q.append("orderBy", o);
  if (opts.limit) q.set("limit", String(opts.limit));
  return url.toString();
}

export type ReportHeader = { name?: string; type?: string; currencyCode?: string };
export type RawReport = {
  headers?: ReportHeader[];
  rows?: { cells?: { value?: string }[] }[];
  totals?: { cells?: { value?: string }[] };
};

export type ReportTable = {
  currency: string;
  /** 헤더 이름 → 셀 값. 인덱스가 아니라 이름으로 들고 다녀서 열 순서에 영향을 받지 않는다. */
  rows: Record<string, string>[];
  totals: Record<string, string>;
};

/**
 * `rows[].cells[]` 는 `headers[]` 순서와 대응할 뿐, 순서 자체는 API 가 정한다.
 * 인덱스를 상수로 박아두면 구글이 열 순서를 바꾸는 날 값이 엉뚱한 지표로 들어간다.
 * 그래서 항상 헤더 이름으로 맞춰 읽는다.
 */
export function parseReport(payload: unknown): ReportTable {
  const p = (payload ?? {}) as RawReport;
  const headers = Array.isArray(p.headers) ? p.headers : [];
  const names = headers.map((h) => String(h?.name ?? ""));
  const currency = headers.find((h) => h?.currencyCode)?.currencyCode ?? "";

  const toRecord = (cells: { value?: string }[] | undefined): Record<string, string> => {
    const rec: Record<string, string> = {};
    names.forEach((name, i) => {
      if (name) rec[name] = String(cells?.[i]?.value ?? "");
    });
    return rec;
  };

  return {
    currency,
    rows: (Array.isArray(p.rows) ? p.rows : []).map((r) => toRecord(r?.cells)),
    totals: toRecord(p.totals?.cells),
  };
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 통화 지표는 소수점 둘째 자리까지만 남긴다(부동소수 잔재를 화면에 흘리지 않기 위해). */
function money(v: string | undefined): number {
  return Math.round(num(v) * 100) / 100;
}

function count(v: string | undefined): number {
  return Math.round(num(v));
}

export type DailyPoint = { date: string; earnings: number; pageViews: number; clicks: number };

export function dailySeries(table: ReportTable): DailyPoint[] {
  return table.rows
    .filter((r) => r.DATE)
    .map((r) => ({
      date: r.DATE,
      earnings: money(r[METRIC.earnings]),
      pageViews: count(r[METRIC.pageViews]),
      clicks: count(r[METRIC.clicks]),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type PagePoint = { url: string; earnings: number; pageViews: number; clicks: number };

export function pageSeries(table: ReportTable, limit = 50): PagePoint[] {
  return table.rows
    .filter((r) => r.PAGE_URL)
    .map((r) => ({
      url: r.PAGE_URL,
      earnings: money(r[METRIC.earnings]),
      pageViews: count(r[METRIC.pageViews]),
      clicks: count(r[METRIC.clicks]),
    }))
    .sort((a, b) => b.earnings - a.earnings || b.pageViews - a.pageViews)
    .slice(0, limit);
}

export type Totals = {
  earnings: number;
  pageViews: number;
  clicks: number;
  impressions: number;
  cpc: number;
};

/**
 * 합계는 응답의 `totals` 를 우선 쓰고, 없으면 행을 더한다.
 * 단 CPC 는 더하면 안 되는 비율 지표라, 합계가 비어 있으면 수익÷클릭으로 되돌려 계산한다.
 */
export function reportTotals(table: ReportTable): Totals {
  const pick = (name: string): number => {
    const t = table.totals[name];
    if (t) return num(t);
    return table.rows.reduce((acc, r) => acc + num(r[name]), 0);
  };

  const earnings = Math.round(pick(METRIC.earnings) * 100) / 100;
  const clicks = Math.round(pick(METRIC.clicks));
  const totalCpc = table.totals[METRIC.cpc] ? num(table.totals[METRIC.cpc]) : 0;
  const cpc = totalCpc > 0 ? totalCpc : clicks > 0 ? earnings / clicks : 0;

  return {
    earnings,
    pageViews: Math.round(pick(METRIC.pageViews)),
    clicks,
    impressions: Math.round(pick(METRIC.impressions)),
    cpc: Math.round(cpc * 100) / 100,
  };
}

/* ------------------------------------------------------------------ *
 * 요약 조회 — 라우트가 그대로 내보낼 모양으로 만든다
 * ------------------------------------------------------------------ */

export type AdsenseSummary = {
  ok: boolean;
  days: number;
  currency: string;
  totals: Totals;
  daily: DailyPoint[];
  pages: PagePoint[];
  connected: boolean;
  error?: string;
};

const EMPTY_TOTALS: Totals = {
  earnings: 0,
  pageViews: 0,
  clicks: 0,
  impressions: 0,
  cpc: 0,
};

function failed(days: number, error: string, connected: boolean): AdsenseSummary {
  return {
    ok: false,
    days,
    currency: "",
    totals: EMPTY_TOTALS,
    daily: [],
    pages: [],
    connected,
    error,
  };
}

/** 일별 추이 + 글별 수익. 자격증명이 없어도 던지지 않고 connected:false 로 알려준다. */
export async function adsenseSummary(days: number, today = new Date()): Promise<AdsenseSummary> {
  const auth = await getAccessToken();
  if (!auth.ok) return failed(days, auth.error, auth.connected);

  const account = await resolveAccount(auth.token);
  if (!account.ok) return failed(days, account.error, true);

  const { start, end } = dateRange(days, today);
  const base = { account: account.account, start, end };

  // 일별과 글별은 서로 독립이라 같이 쏜다. 글별은 상위 수익 페이지만 있으면 충분하다.
  const [dailyRes, pageRes] = await Promise.all([
    apiGet(buildReportUrl({ ...base, dimensions: ["DATE"] }), auth.token),
    apiGet(
      buildReportUrl({
        ...base,
        dimensions: ["PAGE_URL"],
        orderBy: [`-${METRIC.earnings}`],
        limit: 50,
      }),
      auth.token,
    ),
  ]);

  if (!dailyRes.ok) return failed(days, dailyRes.error, true);

  const dailyTable = parseReport(dailyRes.data);
  // 글별 리포트만 실패하면 수익 요약까지 버릴 이유는 없다. 표만 비우고 사유를 함께 알린다.
  const pageTable = pageRes.ok ? parseReport(pageRes.data) : null;

  return {
    ok: true,
    days,
    currency: dailyTable.currency || pageTable?.currency || "USD",
    totals: reportTotals(dailyTable),
    daily: dailySeries(dailyTable),
    pages: pageTable ? pageSeries(pageTable) : [],
    connected: true,
    ...(pageRes.ok ? {} : { error: `글별 수익을 불러오지 못했습니다 — ${pageRes.error}` }),
  };
}

/* ------------------------------------------------------------------ *
 * OAuth 콜백 화면 — 브라우저가 직접 여는 유일한 응답이라 HTML 을 돌려준다
 * ------------------------------------------------------------------ */

/** 구글이 준 오류 원문이 그대로 들어가므로, 화면에 넣기 전에 반드시 통과시킨다. */
export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 설정 화면과 톤만 맞춘 최소한의 안내 페이지. */
export function resultPage(opts: {
  ok: boolean;
  title: string;
  lines: string[];
}): string {
  const body = opts.lines
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("\n      ");
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0d10; color: #e6e8eb; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
      main { max-width: 34rem; padding: 2rem; line-height: 1.7; }
      h1 { font-size: 1.25rem; margin: 0 0 1rem; color: ${opts.ok ? "#5ee9a4" : "#ff8080"}; }
      p { margin: 0 0 0.75rem; color: #b9c0c8; word-break: break-all; }
      a { display: inline-block; margin-top: 1rem; padding: 0.55rem 1rem; border-radius: 0.5rem; background: #1f6feb; color: #fff; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(opts.title)}</h1>
      ${body}
      <a href="/settings">설정 화면으로 돌아가기</a>
    </main>
  </body>
</html>`;
}
