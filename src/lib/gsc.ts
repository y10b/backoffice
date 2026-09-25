import { getSettings } from "./db";
import { getAccessToken, parseServiceAccount, type ServiceAccount } from "./google-auth";

/**
 * 구글 서치콘솔 Search Analytics.
 *
 * GA4 는 "들어온 뒤"만 본다. 어떤 검색어로 몇 번 노출됐고 몇 위였는지는 서치콘솔에만 있다.
 * 다음 글감은 "노출은 되는데 순위가 애매한 검색어"에서 나오므로 이 데이터가 핵심이다.
 * https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 *
 * 자격증명은 GA4 와 같은 서비스 계정(ga4_service_account)을 쓴다. 서치콘솔 속성에
 * 그 계정 이메일을 사용자로 추가해 두면 된다. 키를 두 벌 관리할 이유가 없다.
 */
export const GSC_ORIGIN = "https://www.googleapis.com/webmasters/v3";
/** 읽기만 하지만 권한 확인에 쓴 스코프와 맞춘다 (토큰 캐시 키가 스코프별이다) */
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters";
/** API 가 한 번에 주는 최대 행 수 */
const MAX_ROW_LIMIT = 25_000;
/** 페이지네이션 안전장치. 개인 블로그가 하루 수십만 행을 낼 일은 없다 */
const MAX_PAGES = 20;

export type GscDimension = "date" | "query" | "page" | "country" | "device" | "searchAppearance";

export type GscRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

type GscCreds = { serviceAccount: ServiceAccount; siteUrl: string };

/** 설정의 서치콘솔 속성 주소. URL 접두어 속성은 끝 슬래시까지 정확히 같아야 한다 */
export async function gscSiteUrl(): Promise<string> {
  const s = await getSettings(["gsc_site_url"]);
  return (s.gsc_site_url || process.env.GSC_SITE_URL || "").trim();
}

async function gscCreds(): Promise<GscCreds> {
  const s = await getSettings(["ga4_service_account", "gsc_site_url"]);
  const raw = (s.ga4_service_account || process.env.GA4_SERVICE_ACCOUNT || "").trim();
  const siteUrl = (s.gsc_site_url || process.env.GSC_SITE_URL || "").trim();
  if (!raw) throw new Error("서비스 계정이 설정되지 않았습니다. 설정 화면에 GCP 서비스 계정 JSON 을 넣으세요.");
  if (!siteUrl) {
    throw new Error(
      "서치콘솔 속성 주소가 설정되지 않았습니다. 예: https://example.tistory.com/ (URL 접두어) 또는 sc-domain:example.com",
    );
  }
  return { serviceAccount: parseServiceAccount(raw), siteUrl };
}

/** 오류 본문에서 사람이 읽을 부분만. 403 은 어디서 권한을 줘야 하는지까지 적는다 */
function explainGscError(status: number, raw: string, clientEmail: string, siteUrl: string): string {
  let message = raw.slice(0, 300);
  try {
    message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    /* 원문 그대로 */
  }
  if (/SERVICE_DISABLED|has not been used in project/i.test(message)) {
    return `Google Search Console API 가 사용 설정되지 않았습니다. GCP 콘솔 → API 라이브러리에서 켜세요. (${message})`;
  }
  if (status === 403) {
    return `서치콘솔 속성 ${siteUrl} 에 권한이 없습니다. 서치콘솔 → 설정 → 사용자 및 권한에 ${clientEmail} 을 추가하세요. 속성 주소의 끝 슬래시·http/https 도 정확히 같아야 합니다. (${message})`;
  }
  return `서치콘솔 API 오류 (HTTP ${status}): ${message}`;
}

async function gscFetch(creds: GscCreds, path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken(creds.serviceAccount, GSC_SCOPE);
  const res = await fetch(`${GSC_ORIGIN}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(explainGscError(res.status, text, creds.serviceAccount.clientEmail, creds.siteUrl));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("서치콘솔 응답을 해석하지 못했습니다.");
  }
}

/**
 * searchAnalytics.query. 행이 rowLimit 에 꽉 차면 startRow 를 밀어 끝까지 받는다.
 *
 * rowLimit 은 "한 번에 받을 양"이다(최대 25,000). 전체 상한이 아니다 — 잘린 데이터로
 * 합계를 내면 조용히 틀리므로, 끝까지 받는 쪽을 기본으로 한다.
 * dataState: "all" — 기본값(final)은 2~3일 전까지만 준다. 매일 7일을 다시 덮으니
 * 잠정치를 먼저 받고 확정치로 갈아끼우는 편이 화면이 덜 비어 보인다.
 */
export async function queryGsc(o: {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  rowLimit?: number;
  startRow?: number;
}): Promise<GscRow[]> {
  const creds = await gscCreds();
  const pageSize = Math.min(MAX_ROW_LIMIT, Math.max(1, o.rowLimit ?? MAX_ROW_LIMIT));
  const out: GscRow[] = [];
  let startRow = Math.max(0, o.startRow ?? 0);

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = (await gscFetch(
      creds,
      `/sites/${encodeURIComponent(creds.siteUrl)}/searchAnalytics/query`,
      {
        method: "POST",
        body: JSON.stringify({
          startDate: o.startDate,
          endDate: o.endDate,
          dimensions: o.dimensions,
          rowLimit: pageSize,
          startRow,
          dataState: "all",
        }),
      },
    )) as { rows?: Partial<GscRow>[] };
    const rows = r.rows ?? [];
    for (const row of rows) {
      out.push({
        keys: (row.keys ?? []).map(String),
        clicks: Number(row.clicks ?? 0),
        impressions: Number(row.impressions ?? 0),
        ctr: Number(row.ctr ?? 0),
        position: Number(row.position ?? 0),
      });
    }
    if (rows.length < pageSize) break;
    startRow += rows.length;
  }
  return out;
}

/**
 * 연결 확인. sites.list 에서 설정한 속성을 찾아 권한 수준을 돌려준다.
 * 목록에 없으면 권한을 안 준 것이다 — searchAnalytics 를 불러 403 을 보는 것보다 원인이 분명하다.
 */
export async function gscPing(): Promise<{ siteUrl: string; permissionLevel: string }> {
  const creds = await gscCreds();
  const r = (await gscFetch(creds, "/sites")) as {
    siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
  };
  const sites = r.siteEntry ?? [];
  const hit = sites.find((s) => s.siteUrl === creds.siteUrl);
  if (!hit) {
    const seen = sites.map((s) => s.siteUrl).filter(Boolean).join(", ") || "없음";
    throw new Error(
      `서비스 계정(${creds.serviceAccount.clientEmail})이 볼 수 있는 속성에 ${creds.siteUrl} 이 없습니다. 볼 수 있는 속성: ${seen}`,
    );
  }
  return { siteUrl: creds.siteUrl, permissionLevel: String(hit.permissionLevel ?? "") };
}
