/**
 * 유입 데이터 — 서치콘솔·GA4 를 하루 단위로 표에 쌓고(syncInsights), 그걸 집계해 화면과
 * 글감 고르기에 쓴다(getInsights · topicSignals).
 *
 *  | 누가              | 언제        | 하는 일                                  |
 *  |-------------------|-------------|------------------------------------------|
 *  | insights.yml      | 매일 09:30  | 최근 7일 GSC·GA4·이벤트 → 세 표 덮어쓰기 |
 *  | /api/insights/sync| 화면 버튼   | 같은 함수를 지금 돌린다                  |
 *  | /api/insights     | 화면        | 최근 N일 집계                            |
 *  | dailyPost         | 초안 만들 때| topicSignals 로 다음 키워드 후보         |
 *
 * 왜 표에 쌓나: 글감 신호는 "노출은 되는데 5~30위에 머무는 검색어"다. 이건 몇 주치를
 * 합쳐야 보이고, 초안 생성·키워드 수집·홈 화면이 각자 구글 API 를 부르면 호출도 늘고
 * 결과도 제각각이 된다. 하루치씩 떨어뜨려 두고 여기서 한 번에 집계한다.
 *
 * 날짜: 수집 범위는 KST 기준 어제부터 N일. 오늘치는 GA4·GSC 모두 집계 중이라 넣지 않는다.
 */
import { kstDate, listPosts, supabase } from "./db";
import { queryGsc } from "./gsc";
import { ga4Creds, isoDate, normalizePath, num, runReport, type RunReportResponse } from "./ga4";
import { GA4_READONLY_SCOPE, getAccessToken } from "./google-auth";

/** 서치콘솔은 2~3일 늦게 확정된다. 매번 이만큼은 다시 덮어야 잠정치가 확정치로 바뀐다 */
export const DEFAULT_SYNC_DAYS = 7;
const MAX_SYNC_DAYS = 90;
const GA4_PAGE_SIZE = 10_000;
const WRITE_CHUNK = 500;
const READ_CHUNK = 1000;

/* ------------------------------------------------------------------ *
 * 공통
 * ------------------------------------------------------------------ */

/** 퍼센트 인코딩을 풀되, 깨진 인코딩이면 원문을 둔다 (던지면 한 줄 때문에 전체가 죽는다) */
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 글 경로 키. 서치콘솔은 전체 URL(인코딩), GA4 는 경로(인코딩 여부가 들쭉날쭉)를 준다.
 * 둘을 같은 글로 묶으려면 호스트·쿼리를 떼고 디코드한 경로로 맞춰야 한다.
 */
export function pathKey(urlOrPath: string): string {
  let p = urlOrPath.trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      /* 그대로 */
    }
  }
  return normalizePath(decodeSafe(p)) || "/";
}

/** 공백을 빼고 비교한다. 키워드도구는 띄어쓰기를 빼고, 검색어는 띄어 쓴다 */
const bare = (s: string) => s.replace(/\s+/g, "").toLowerCase();

function range(days: number): { from: string; to: string } {
  return { from: kstDate(-days), to: kstDate(-1) };
}

/**
 * 범위를 지우고 새로 넣는다.
 *
 * upsert 만 하면 잠정치에만 있던 검색어 줄(확정치에서 사라진 것)이 영원히 남는다.
 * 조회가 성공했을 때만 부르므로, 지운 뒤 쓰기가 실패해도 다음 실행이 같은 범위를 다시 채운다.
 * 쓰기는 upsert — 수동 실행과 크론이 겹쳐도 유니크 충돌로 죽지 않게.
 */
async function replaceRange(
  table: string,
  onConflict: string,
  from: string,
  to: string,
  rows: object[],
): Promise<number> {
  const del = await supabase().from(table).delete().gte("date", from).lte("date", to);
  if (del.error) throw new Error(`${table} 정리 실패: ${del.error.message}`);
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await supabase()
      .from(table)
      .upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict });
    if (error) throw new Error(`${table} 저장 실패: ${error.message}`);
  }
  return rows.length;
}

/** PostgREST 는 한 번에 1,000줄까지만 준다. 기간 집계는 끝까지 읽어야 맞는다 */
async function selectAll<T>(table: string, columns: string, from: string, to: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += READ_CHUNK) {
    const { data, error } = await supabase()
      .from(table)
      .select(columns)
      .gte("date", from)
      .lte("date", to)
      .order("id", { ascending: true })
      .range(i, i + READ_CHUNK - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < READ_CHUNK) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 수집
 * ------------------------------------------------------------------ */

type SearchRow = {
  date: string;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

type TrafficRow = {
  date: string;
  page_path: string;
  page_title: string;
  source: string;
  medium: string;
  sessions: number;
  views: number;
  engaged_sessions: number;
  avg_engagement_sec: number;
};

type EventRow = { date: string; event_name: string; page_path: string; count: number };

export async function fetchSearch(from: string, to: string): Promise<SearchRow[]> {
  const rows = await queryGsc({ startDate: from, endDate: to, dimensions: ["date", "query", "page"] });
  return rows.map((r) => ({
    date: r.keys[0],
    query: r.keys[1] ?? "",
    page: r.keys[2] ?? "",
    clicks: Math.round(r.clicks),
    impressions: Math.round(r.impressions),
    ctr: r.ctr,
    position: Math.round(r.position * 100) / 100,
  }));
}

/** runReport 를 offset 으로 끝까지. GA4 는 한 번에 최대 25만 줄이지만 응답이 커져 1만씩 끊는다 */
async function ga4All(body: Record<string, unknown>): Promise<NonNullable<RunReportResponse["rows"]>> {
  const resolved = await ga4Creds();
  if ("error" in resolved) throw new Error(resolved.error);
  const { creds } = resolved;
  const token = await getAccessToken(creds.serviceAccount, GA4_READONLY_SCOPE);
  const out: NonNullable<RunReportResponse["rows"]> = [];
  for (let offset = 0; offset < 500_000; offset += GA4_PAGE_SIZE) {
    const r = await runReport(creds, token, { ...body, limit: GA4_PAGE_SIZE, offset });
    const rows = r.rows ?? [];
    out.push(...rows);
    if (rows.length < GA4_PAGE_SIZE || out.length >= (r.rowCount ?? 0)) break;
  }
  return out;
}

/**
 * GA4 페이지×유입경로. 같은 경로가 쿼리 꼬리·제목 수정으로 여러 줄로 오므로
 * (date, 경로, source, medium) 로 합친다 — 합치지 않으면 한 upsert 안에 같은 키가
 * 두 번 들어가 Postgres 가 통째로 거부한다.
 */
export async function fetchTraffic(from: string, to: string): Promise<TrafficRow[]> {
  const rows = await ga4All({
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [
      { name: "date" },
      { name: "pagePath" },
      { name: "pageTitle" },
      { name: "sessionSource" },
      { name: "sessionMedium" },
    ],
    metrics: [
      { name: "sessions" },
      { name: "screenPageViews" },
      { name: "engagedSessions" },
      { name: "userEngagementDuration" },
    ],
  });

  type Acc = TrafficRow & { titleViews: number; engagementTotal: number };
  const byKey = new Map<string, Acc>();
  for (const row of rows) {
    const d = row.dimensionValues ?? [];
    const m = row.metricValues ?? [];
    const date = isoDate(d[0]?.value ?? "");
    const page_path = pathKey(d[1]?.value ?? "");
    const title = (d[2]?.value ?? "").trim();
    const source = d[3]?.value ?? "";
    const medium = d[4]?.value ?? "";
    const sessions = num(m[0]?.value);
    const views = num(m[1]?.value);
    const engaged = num(m[2]?.value);
    const engagement = num(m[3]?.value);
    if (!date) continue;

    const key = [date, page_path, source, medium].join("\u0000");
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        date,
        page_path,
        page_title: title === "(not set)" ? "" : title,
        source,
        medium,
        sessions,
        views,
        engaged_sessions: engaged,
        avg_engagement_sec: 0,
        titleViews: views,
        engagementTotal: engagement,
      });
      continue;
    }
    prev.sessions += sessions;
    prev.views += views;
    prev.engaged_sessions += engaged;
    prev.engagementTotal += engagement;
    if (title && title !== "(not set)" && views > prev.titleViews) {
      prev.page_title = title;
      prev.titleViews = views;
    }
  }

  return [...byKey.values()].map(({ titleViews: _t, engagementTotal, ...r }) => ({
    ...r,
    // GA4 화면의 "세션당 평균 참여 시간"과 같은 정의
    avg_engagement_sec: r.sessions > 0 ? Math.round((engagementTotal / r.sessions) * 10) / 10 : 0,
  }));
}

export async function fetchEvents(from: string, to: string): Promise<EventRow[]> {
  const rows = await ga4All({
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "date" }, { name: "eventName" }, { name: "pagePath" }],
    metrics: [{ name: "eventCount" }],
  });
  const byKey = new Map<string, EventRow>();
  for (const row of rows) {
    const d = row.dimensionValues ?? [];
    const date = isoDate(d[0]?.value ?? "");
    if (!date) continue;
    const event_name = d[1]?.value ?? "";
    const page_path = pathKey(d[2]?.value ?? "");
    const count = num(row.metricValues?.[0]?.value);
    const key = [date, event_name, page_path].join("\u0000");
    const prev = byKey.get(key);
    if (prev) prev.count += count;
    else byKey.set(key, { date, event_name, page_path, count });
  }
  return [...byKey.values()];
}

export type SyncResult = {
  days: number;
  search: number;
  traffic: number;
  events: number;
  range: [string, string];
  /** 실패한 쪽의 오류. 나머지는 저장됐다 */
  errors: string[];
};

/**
 * 최근 N일(KST 어제까지)을 세 표에 다시 쓴다. 한쪽이 실패해도 나머지는 저장하고,
 * 실패는 errors 로 돌려준다 — 서치콘솔 권한 문제로 GA4 데이터까지 버릴 이유가 없다.
 */
export async function syncInsights(o: { days?: number } = {}): Promise<SyncResult> {
  const days = Math.min(MAX_SYNC_DAYS, Math.max(1, Math.trunc(o.days ?? DEFAULT_SYNC_DAYS)));
  const { from, to } = range(days);
  const errors: string[] = [];

  const run = async (
    label: string,
    table: string,
    onConflict: string,
    fetcher: () => Promise<object[]>,
  ): Promise<number> => {
    try {
      return await replaceRange(table, onConflict, from, to, await fetcher());
    } catch (e) {
      errors.push(`[${label}] ${(e as Error).message}`);
      return 0;
    }
  };

  // 서로 다른 API·표라 동시에 돌린다
  const [search, traffic, events] = await Promise.all([
    run("서치콘솔", "search_daily", "date,query,page", () => fetchSearch(from, to)),
    run("GA4", "traffic_daily", "date,page_path,source,medium", () => fetchTraffic(from, to)),
    run("GA4 이벤트", "event_daily", "date,event_name,page_path", () => fetchEvents(from, to)),
  ]);

  return { days, search, traffic, events, range: [from, to], errors };
}

/* ------------------------------------------------------------------ *
 * 집계
 * ------------------------------------------------------------------ */

export type QueryStat = {
  query: string;
  clicks: number;
  impressions: number;
  /** 0~1 */
  ctr: number;
  /** 노출 가중 평균 순위 */
  position: number;
  /** 이 검색어로 노출된 글 경로 */
  pages: string[];
};

export type Insights = {
  /** 표에 있는 가장 최근 날짜. 수집이 한 번도 안 돌았으면 null */
  lastDate: string | null;
  totals: { clicks: number; impressions: number; sessions: number; views: number };
  daily: { date: string; clicks: number; impressions: number; sessions: number; views: number }[];
  queries: QueryStat[];
  opportunities: QueryStat[];
  sources: { source: string; medium: string; sessions: number; views: number }[];
  pages: {
    path: string;
    title: string;
    views: number;
    sessions: number;
    clicks: number;
    impressions: number;
    /** 서치콘솔 노출이 없으면 null */
    position: number | null;
  }[];
  events: { name: string; count: number }[];
};

/** 글감 기준: 노출이 몇 번은 있고, 순위가 첫 화면 바로 밖~3페이지 안 */
const OPP_MIN_IMPRESSIONS = 3;
const OPP_MIN_POSITION = 5;
const OPP_MAX_POSITION = 30;
const QUERY_LIMIT = 200;
const PAGE_LIMIT = 200;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function clampInsightDays(v: unknown): number {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return 28;
  return Math.min(365, Math.max(1, Math.trunc(n)));
}

/** 표 가장 최근 날짜 (두 표 중 늦은 쪽) */
async function latestDate(): Promise<string | null> {
  const pick = async (table: string) => {
    const { data, error } = await supabase()
      .from(table)
      .select("date")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    return (data?.date as string | undefined) ?? null;
  };
  const [a, b] = await Promise.all([pick("search_daily"), pick("traffic_daily")]);
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** search_daily 줄을 검색어 단위로. 순위는 노출 가중 평균 — 노출 1 짜리가 평균을 흔들지 않게 */
export function aggregateQueries(rows: SearchRow[]): QueryStat[] {
  type Acc = { clicks: number; impressions: number; posWeighted: number; pages: Map<string, number> };
  const by = new Map<string, Acc>();
  for (const r of rows) {
    const a = by.get(r.query) ?? { clicks: 0, impressions: 0, posWeighted: 0, pages: new Map() };
    const imp = Number(r.impressions);
    a.clicks += Number(r.clicks);
    a.impressions += imp;
    a.posWeighted += Number(r.position) * imp;
    const p = pathKey(r.page);
    a.pages.set(p, (a.pages.get(p) ?? 0) + imp);
    by.set(r.query, a);
  }
  return [...by.entries()]
    .map(([query, a]) => ({
      query,
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: a.impressions ? round(a.clicks / a.impressions, 4) : 0,
      position: a.impressions ? round(a.posWeighted / a.impressions, 1) : 0,
      pages: [...a.pages.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => p),
    }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
}

export function pickOpportunities(queries: QueryStat[]): QueryStat[] {
  return queries.filter(
    (q) =>
      q.impressions >= OPP_MIN_IMPRESSIONS &&
      q.position >= OPP_MIN_POSITION &&
      q.position <= OPP_MAX_POSITION,
  );
}

async function loadRange(days: number) {
  const { from, to } = range(days);
  const [search, traffic, events] = await Promise.all([
    selectAll<SearchRow>("search_daily", "date, query, page, clicks, impressions, ctr, position", from, to),
    selectAll<TrafficRow>(
      "traffic_daily",
      "date, page_path, page_title, source, medium, sessions, views, engaged_sessions, avg_engagement_sec",
      from,
      to,
    ),
    selectAll<EventRow>("event_daily", "date, event_name, page_path, count", from, to),
  ]);
  return { search, traffic, events };
}

export async function getInsights(o: { days?: number } = {}): Promise<Insights> {
  const days = clampInsightDays(o.days ?? 28);
  const [{ search, traffic, events }, lastDate] = await Promise.all([loadRange(days), latestDate()]);

  /* 일별 */
  const dailyMap = new Map<string, Insights["daily"][number]>();
  const day = (date: string) => {
    let d = dailyMap.get(date);
    if (!d) {
      d = { date, clicks: 0, impressions: 0, sessions: 0, views: 0 };
      dailyMap.set(date, d);
    }
    return d;
  };
  for (const r of search) {
    const d = day(r.date);
    d.clicks += Number(r.clicks);
    d.impressions += Number(r.impressions);
  }
  for (const r of traffic) {
    const d = day(r.date);
    d.sessions += Number(r.sessions);
    d.views += Number(r.views);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals = daily.reduce(
    (t, d) => ({
      clicks: t.clicks + d.clicks,
      impressions: t.impressions + d.impressions,
      sessions: t.sessions + d.sessions,
      views: t.views + d.views,
    }),
    { clicks: 0, impressions: 0, sessions: 0, views: 0 },
  );

  /* 검색어 */
  const allQueries = aggregateQueries(search);
  const queries = allQueries.slice(0, QUERY_LIMIT);
  const opportunities = pickOpportunities(allQueries);

  /* 유입 경로 — search.naver.com · m.search.naver.com 도 합치지 않고 그대로 둔다 */
  const srcMap = new Map<string, Insights["sources"][number]>();
  for (const r of traffic) {
    const k = `${r.source}\u0000${r.medium}`;
    const s = srcMap.get(k) ?? { source: r.source, medium: r.medium, sessions: 0, views: 0 };
    s.sessions += Number(r.sessions);
    s.views += Number(r.views);
    srcMap.set(k, s);
  }
  const sources = [...srcMap.values()].sort((a, b) => b.sessions - a.sessions || b.views - a.views);

  /* 글 — GA4 조회수와 서치콘솔 노출을 경로로 붙인다 */
  type PageAcc = Insights["pages"][number] & { titleViews: number; posWeighted: number };
  const pageMap = new Map<string, PageAcc>();
  const page = (path: string) => {
    let p = pageMap.get(path);
    if (!p) {
      p = { path, title: "", views: 0, sessions: 0, clicks: 0, impressions: 0, position: null, titleViews: -1, posWeighted: 0 };
      pageMap.set(path, p);
    }
    return p;
  };
  for (const r of traffic) {
    const p = page(r.page_path);
    const views = Number(r.views);
    p.views += views;
    p.sessions += Number(r.sessions);
    if (r.page_title && views > p.titleViews) {
      p.title = r.page_title;
      p.titleViews = views;
    }
  }
  for (const r of search) {
    const p = page(pathKey(r.page));
    const imp = Number(r.impressions);
    p.clicks += Number(r.clicks);
    p.impressions += imp;
    p.posWeighted += Number(r.position) * imp;
  }
  const pages = [...pageMap.values()]
    .map(({ titleViews: _t, posWeighted, ...p }) => ({
      ...p,
      position: p.impressions ? round(posWeighted / p.impressions, 1) : null,
    }))
    .sort((a, b) => b.views - a.views || b.impressions - a.impressions)
    .slice(0, PAGE_LIMIT);

  /* 이벤트 */
  const evMap = new Map<string, number>();
  for (const r of events) evMap.set(r.event_name, (evMap.get(r.event_name) ?? 0) + Number(r.count));
  const eventList = [...evMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { lastDate, totals, daily, queries, opportunities, sources, pages, events: eventList };
}

/**
 * 다음 글감 후보. opportunities 중 이미 쓴 글(posts 의 main_keyword·title 에 그 검색어가
 * 들어 있는 것)은 뺀다. 노출은 되는데 순위가 애매하다는 건 "이 질문에 딱 맞는 글이 아직 없다"는
 * 신호라서, 그 검색어를 제목으로 한 글을 새로 쓰면 가장 빨리 유입이 생긴다.
 */
export async function topicSignals(o: { days?: number; limit?: number } = {}): Promise<QueryStat[]> {
  const days = clampInsightDays(o.days ?? 28);
  const { from, to } = range(days);
  const [search, posts] = await Promise.all([
    selectAll<SearchRow>("search_daily", "date, query, page, clicks, impressions, ctr, position", from, to),
    listPosts(1000),
  ]);
  const written = posts.map((p) => bare(`${p.main_keyword ?? ""}\u0000${p.title ?? ""}`));
  return pickOpportunities(aggregateQueries(search))
    .filter((q) => {
      const b = bare(q.query);
      return b && !written.some((w) => w.includes(b));
    })
    .slice(0, o.limit ?? 10);
}
