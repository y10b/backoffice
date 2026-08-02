"use client";

import { useEffect, useMemo, useState } from "react";
import type { Ga4Report } from "@/lib/ga4";
import type { AdsenseSummary } from "@/lib/adsense";

/** 기간 후보. 7일은 방금 발행한 글 반응, 90일은 계절성까지 본다. */
const RANGES = [7, 28, 90];

/* ================================================================== *
 * PURE:START
 * 조인·정규화 규칙. React 도 다른 모듈도 쓰지 않는 순수 함수 블록이라
 * 이 구간만 그대로 떼어내 node 로 돌려볼 수 있다(그래서 import 를 안 건다).
 * ================================================================== */

/** 조인에 필요한 최소한만 구조적으로 받는다. lib 타입에 묶이면 순수성이 깨진다. */
type Ga4PageLike = {
  path: string;
  title?: string;
  views?: number;
  users?: number;
  avgSeconds?: number;
};

type AdsensePageLike = {
  url: string;
  earnings?: number;
  pageViews?: number;
  clicks?: number;
};

/** 한 줄에 조회수와 수익이 같이 오도록 합친 결과 */
type PerfRow = {
  /** 정규화된 경로. 두 소스를 잇는 키다. */
  path: string;
  title: string;
  /** 애드센스가 준 절대 URL. GA4 에만 있는 글은 원본 주소를 알 수 없어 null. */
  url: string | null;
  views: number | null;
  users: number | null;
  avgSeconds: number | null;
  earnings: number | null;
  clicks: number | null;
  /** 애드센스가 센 페이지뷰. GA4 조회수와 집계 기준이 달라 따로 둔다. */
  adPageViews: number | null;
  /** 1000회 조회당 수익 */
  rpm: number | null;
  /** 어느 쪽에서 온 행인지 — 한쪽에만 있는 글을 버리지 않는 대신 표시해 준다 */
  source: "both" | "ga4" | "adsense";
  /** 이 글을 쓸 때 쓴 메인/서브 키워드. 저장된 글과 제목이 이어질 때만 채워진다 */
  keyword?: string;
};

/**
 * 두 소스의 주소를 같은 모양으로 맞춘다.
 *
 * 애드센스는 `https://호스트/entry/제목` 절대 URL, GA4 는 `/entry/제목` 경로로 주고,
 * 티스토리 주소에는 한글이 그대로 들어간다. 한쪽만 퍼센트 인코딩돼 있거나 `?utm_...`,
 * 끝 슬래시가 붙는 것만으로 같은 글이 다른 글로 갈라져 조인이 통째로 빈다.
 * 그래서 비교 전에 호스트·쿼리·해시·끝슬래시를 털고 한글을 디코딩한다.
 */
function normalizePath(input: string): string {
  let path = (input ?? "").trim();
  if (!path) return "";

  // 절대 URL 이면 경로만 남긴다. 스킴 없이 호스트만 온 경우도 같이 흡수한다.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
    }
  } else if (/^[^/?#]+\.[^/?#]+\//.test(path)) {
    path = path.slice(path.indexOf("/"));
  }

  // 쿼리스트링·해시는 같은 글의 변형일 뿐이라 버린다(utm 파라미터가 대부분)
  path = path.split("#")[0].split("?")[0];

  /*
   * 한쪽만 인코딩된 한글을 맞춘다. 잘못된 % 시퀀스면 decodeURIComponent 가 던지는데,
   * 그때는 원본을 그대로 쓰는 편이 낫다(조인은 못 해도 행은 살아남는다).
   */
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 원본 유지 */
  }

  // macOS 에서 올라온 한글은 자모 분리(NFD)라 눈에 같아 보여도 문자열이 다르다
  path = path.normalize("NFC");

  path = path.replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  return path;
}

/** 정규화 과정에서 여러 주소가 한 경로로 합쳐질 수 있어 누적 상태를 따로 둔다 */
type Acc = {
  row: PerfRow;
  /** 체류시간은 조회수로 가중평균해야 맞다 */
  secondsWeighted: number;
  secondsViews: number;
  /** 제목은 가장 많이 조회된 주소 것을 남긴다 */
  titleViews: number;
  fromGa4: boolean;
  fromAdsense: boolean;
};

/**
 * GA4 글별 성과와 애드센스 글별 수익을 경로로 조인한다.
 *
 * 한쪽에만 있는 글도 남긴다. 수익만 있고 조회수가 없으면 GA4 태그가 그 글에 안 붙은
 * 것이고, 반대면 트래픽은 있는데 돈이 안 되는 글이다. 둘 다 다음 키워드 선정에 쓰는
 * 정보라 버리면 안 된다.
 */
function joinPerformance(
  ga4Pages: Ga4PageLike[],
  adsensePages: AdsensePageLike[],
): PerfRow[] {
  const acc = new Map<string, Acc>();

  const touch = (path: string): Acc => {
    let hit = acc.get(path);
    if (!hit) {
      hit = {
        row: {
          path,
          title: "",
          url: null,
          views: null,
          users: null,
          avgSeconds: null,
          earnings: null,
          clicks: null,
          adPageViews: null,
          rpm: null,
          source: "ga4",
        },
        secondsWeighted: 0,
        secondsViews: 0,
        titleViews: -1,
        fromGa4: false,
        fromAdsense: false,
      };
      acc.set(path, hit);
    }
    return hit;
  };

  for (const p of ga4Pages) {
    const path = normalizePath(p.path);
    if (!path) continue;
    const hit = touch(path);
    const views = p.views ?? 0;
    hit.fromGa4 = true;
    hit.row.views = (hit.row.views ?? 0) + views;
    hit.row.users = (hit.row.users ?? 0) + (p.users ?? 0);
    hit.secondsWeighted += (p.avgSeconds ?? 0) * views;
    hit.secondsViews += views;
    if (p.title && views > hit.titleViews) {
      hit.row.title = p.title;
      hit.titleViews = views;
    }
  }

  for (const p of adsensePages) {
    const path = normalizePath(p.url);
    if (!path) continue;
    const hit = touch(path);
    hit.fromAdsense = true;
    hit.row.earnings = (hit.row.earnings ?? 0) + (p.earnings ?? 0);
    hit.row.clicks = (hit.row.clicks ?? 0) + (p.clicks ?? 0);
    hit.row.adPageViews = (hit.row.adPageViews ?? 0) + (p.pageViews ?? 0);
    // 원본 주소는 표에서 글로 바로 넘어가는 링크로 쓴다
    if (!hit.row.url) hit.row.url = p.url;
  }

  return [...acc.values()].map(({ row, secondsWeighted, secondsViews, fromGa4, fromAdsense }) => {
    /*
     * RPM 은 GA4 조회수를 기준으로 삼는다. 다만 애드센스에만 있는 글은 GA4 조회수가
     * 아예 없어서 늘 "—" 가 되는데, 그러면 정작 돈이 되는 글의 효율을 못 본다.
     * 그런 행에 한해 애드센스 페이지뷰로 대신 계산한다(집계 기준이 달라 근사값).
     */
    const base = row.views ?? row.adPageViews ?? 0;
    return {
      ...row,
      title: row.title || row.path,
      avgSeconds: secondsViews > 0 ? Math.round(secondsWeighted / secondsViews) : null,
      rpm: row.earnings !== null && base > 0 ? (row.earnings / base) * 1000 : null,
      source: fromGa4 && fromAdsense ? "both" : fromAdsense ? "adsense" : "ga4",
    } satisfies PerfRow;
  });
}

type SortKey = "earnings" | "views" | "rpm";

/**
 * 기본은 수익 내림차순이되, 수익이 없거나 같으면 조회수로 가른다.
 * 아직 수익이 한 푼도 없는 초기에도 표가 의미 있는 순서를 갖게 하려는 것.
 * null 은 방향과 무관하게 항상 뒤로 보낸다(빈 칸이 위에 오면 표를 못 읽는다).
 */
function sortRows(rows: PerfRow[], key: SortKey, desc: boolean): PerfRow[] {
  const dir = desc ? 1 : -1;
  const pick = (r: PerfRow): number | null =>
    key === "earnings" ? r.earnings : key === "views" ? r.views : r.rpm;

  return [...rows].sort((a, b) => {
    const av = pick(a);
    const bv = pick(b);
    if (av === null && bv === null) return (b.views ?? 0) - (a.views ?? 0);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return (bv - av) * dir;
    return (b.views ?? 0) - (a.views ?? 0);
  });
}

/** 일별 추이는 두 API 의 날짜 합집합 위에 그린다(한쪽만 있는 날도 빠뜨리지 않게) */
type DailyPoint = {
  date: string;
  views: number | null;
  users: number | null;
  earnings: number | null;
  clicks: number | null;
};

function mergeDaily(
  ga4Daily: { date: string; views?: number; users?: number }[],
  adsenseDaily: { date: string; earnings?: number; clicks?: number }[],
): DailyPoint[] {
  const map = new Map<string, DailyPoint>();
  const touch = (date: string): DailyPoint => {
    let hit = map.get(date);
    if (!hit) {
      hit = { date, views: null, users: null, earnings: null, clicks: null };
      map.set(date, hit);
    }
    return hit;
  };
  for (const d of ga4Daily) {
    const hit = touch(d.date);
    hit.views = (hit.views ?? 0) + (d.views ?? 0);
    hit.users = (hit.users ?? 0) + (d.users ?? 0);
  }
  for (const d of adsenseDaily) {
    const hit = touch(d.date);
    hit.earnings = (hit.earnings ?? 0) + (d.earnings ?? 0);
    hit.clicks = (hit.clicks ?? 0) + (d.clicks ?? 0);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

type PostLike = { main_keyword: string; sub_keyword: string; title: string };

/**
 * 제목을 비교용으로 깎는다.
 *
 * GA4 의 pageTitle 은 티스토리가 붙이는 `:: 블로그명`, ` - 블로그명`, `| 블로그명` 같은
 * 꼬리표를 달고 온다. 백오피스에 저장된 제목에는 그게 없어서 그대로 비교하면 하나도 안 맞는다.
 */
function normalizeTitle(input: string): string {
  return input
    .normalize("NFC")
    .split(/\s*(?:::|\||—|–|-)\s*/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 성과 행에 "무슨 키워드로 쓴 글인지"를 붙인다.
 *
 * 이게 있어야 키워드 선정 → 작성 → 발행 → 성과의 고리가 닫힌다. 조회수만 보면 트래픽 많은
 * 글이 좋아 보이지만, 실제로는 검색량이 적어도 단가 높은 키워드로 쓴 글이 더 벌 수 있다.
 *
 * 발행 주소를 저장하지 않아 제목으로 잇는다. 그래서 확실한 순서로만 매칭하고,
 * 애매하면 붙이지 않는다 — 틀린 키워드가 붙는 것보다 비어 있는 편이 낫다.
 */
function attachKeywords(rows: PerfRow[], posts: PostLike[]): PerfRow[] {
  const byTitle = new Map<string, PostLike>();
  for (const p of posts) {
    const key = normalizeTitle(p.title ?? "");
    if (key && !byTitle.has(key)) byTitle.set(key, p);
  }
  if (!byTitle.size) return rows;

  return rows.map((r) => {
    const key = normalizeTitle(r.title ?? "");
    if (!key) return r;

    let hit = byTitle.get(key);
    if (!hit) {
      // 꼬리표를 못 떼는 형태가 남을 수 있어 포함 관계도 본다.
      // 짧은 제목은 우연히 겹치기 쉬워 길이 하한을 둔다.
      for (const [k, p] of byTitle) {
        if (k.length >= 6 && (key.startsWith(k) || key.includes(k))) {
          hit = p;
          break;
        }
      }
    }
    if (!hit) return r;

    const keyword = [hit.main_keyword, hit.sub_keyword]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" + ");
    return keyword ? { ...r, keyword } : r;
  });
}

/* ================================================================== *
 * PURE:END
 * ================================================================== */

function num(v: number | null): string {
  return v === null ? "—" : v.toLocaleString();
}

/** 금액은 통화 코드를 붙여 보여준다. 애드센스 계정 통화가 KRW 가 아닐 수도 있다. */
function money(v: number | null, currency: string, digits = 0): string {
  if (v === null) return "—";
  const n = v.toLocaleString("ko-KR", { maximumFractionDigits: digits });
  return currency ? `${n} ${currency}` : n;
}

function duration(sec: number | null): string {
  if (sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

/** `2026-08-01` → `08-01`. 축이 좁아 연도는 뺀다. */
function shortDate(date: string): string {
  return date.length >= 10 ? date.slice(5) : date;
}

/* ------------------------------------------------------------------ *
 * 일별 추이 그래프
 * ------------------------------------------------------------------ */

const VB_W = 760;
const VB_H = 210;
const PAD = { l: 36, r: 12, t: 14, b: 24 };
const INNER_W = VB_W - PAD.l - PAD.r;
const INNER_H = VB_H - PAD.t - PAD.b;

/** 값이 없는 날에서 선을 끊는다. 0 으로 이으면 없는 데이터가 있는 것처럼 보인다. */
function segments(
  points: DailyPoint[],
  pick: (p: DailyPoint) => number | null,
  toX: (i: number) => number,
  toY: (v: number) => number,
): { lines: string[]; dots: { x: number; y: number }[] } {
  const lines: string[] = [];
  const dots: { x: number; y: number }[] = [];
  let run: string[] = [];
  points.forEach((p, i) => {
    const v = pick(p);
    if (v === null) {
      if (run.length > 1) lines.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${toX(i).toFixed(1)},${toY(v).toFixed(1)}`);
    // 앞뒤가 모두 비어 외톨이로 남은 점은 선이 안 그려져 점으로 찍어 준다
    const lonely =
      (i === 0 || pick(points[i - 1]) === null) &&
      (i === points.length - 1 || pick(points[i + 1]) === null);
    if (lonely) dots.push({ x: toX(i), y: toY(v) });
  });
  if (run.length > 1) lines.push(run.join(" "));
  return { lines, dots };
}

/**
 * 조회수와 수익을 한 그래프에 겹친다.
 *
 * 단위가 전혀 다르니 y 축을 두 개 두는 대신 각 지표를 <자기 기간 최대값=100%> 로
 * 지수화해 축 하나에 얹는다. 축이 두 개면 눈금을 어떻게 놓느냐에 따라 없는 상관관계도
 * 있어 보이기 때문이다. 절대값은 범례와 툴팁이 책임진다.
 */
function TrendChart({
  points,
  currency,
  hasEarnings,
}: {
  points: DailyPoint[];
  currency: string;
  hasEarnings: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const maxViews = Math.max(1, ...points.map((p) => p.views ?? 0));
  const maxEarnings = Math.max(1, ...points.map((p) => p.earnings ?? 0));

  const toX = (i: number) =>
    PAD.l + (points.length < 2 ? INNER_W / 2 : (i / (points.length - 1)) * INNER_W);
  const yViews = (v: number) => PAD.t + INNER_H - (v / maxViews) * INNER_H;
  const yEarnings = (v: number) => PAD.t + INNER_H - (v / maxEarnings) * INNER_H;

  const viewsPath = segments(points, (p) => p.views, toX, yViews);
  const earningsPath = hasEarnings
    ? segments(points, (p) => p.earnings, toX, yEarnings)
    : { lines: [], dots: [] };

  // 날짜 눈금은 5개면 충분하다. 90일치를 다 찍으면 글자가 서로 겹친다.
  const tickStep = Math.max(1, Math.ceil(points.length / 5));
  const active = hover !== null ? points[hover] : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * VB_W;
    const ratio = (svgX - PAD.l) / INNER_W;
    const i = Math.round(ratio * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  }

  return (
    <>
      <div className="legend">
        <span>
          <i style={{ borderColor: "var(--chart-views)" }} />
          조회수 <span className="dim">(최대 {maxViews.toLocaleString()})</span>
        </span>
        {hasEarnings && (
          <span>
            <i style={{ borderColor: "var(--chart-earnings)" }} />
            수익 <span className="dim">(최대 {money(maxEarnings, currency)})</span>
          </span>
        )}
      </div>

      <div className="chart-wrap">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="chart"
          role="img"
          aria-label="일별 조회수와 수익 추이"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* 격자는 읽는 데 방해가 안 되도록 뒤로 물린다 */}
          {[0, 50, 100].map((p) => {
            const y = PAD.t + INNER_H - (p / 100) * INNER_H;
            return (
              <g key={p}>
                <line
                  x1={PAD.l}
                  x2={VB_W - PAD.r}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth="1"
                />
                <text x={PAD.l - 8} y={y + 4} className="axis" textAnchor="end">
                  {p}%
                </text>
              </g>
            );
          })}

          {points.map((p, i) =>
            i % tickStep === 0 || i === points.length - 1 ? (
              <text
                key={p.date}
                x={toX(i)}
                y={VB_H - 6}
                className="axis"
                textAnchor={i === points.length - 1 ? "end" : i === 0 ? "start" : "middle"}
              >
                {shortDate(p.date)}
              </text>
            ) : null,
          )}

          {hover !== null && (
            <line
              x1={toX(hover)}
              x2={toX(hover)}
              y1={PAD.t}
              y2={PAD.t + INNER_H}
              stroke="var(--text-dim)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          )}

          {earningsPath.lines.map((d, i) => (
            <polyline
              key={`e${i}`}
              points={d}
              fill="none"
              stroke="var(--chart-earnings)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {earningsPath.dots.map((d, i) => (
            <circle key={`ed${i}`} cx={d.x} cy={d.y} r="4" fill="var(--chart-earnings)" />
          ))}

          {viewsPath.lines.map((d, i) => (
            <polyline
              key={`v${i}`}
              points={d}
              fill="none"
              stroke="var(--chart-views)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {viewsPath.dots.map((d, i) => (
            <circle key={`vd${i}`} cx={d.x} cy={d.y} r="4" fill="var(--chart-views)" />
          ))}

          {/* 겹친 두 선 위에 찍히므로 표면색 링을 둘러 서로 파묻히지 않게 한다 */}
          {active && active.views !== null && (
            <circle
              cx={toX(hover as number)}
              cy={yViews(active.views)}
              r="4"
              fill="var(--chart-views)"
              stroke="var(--surface)"
              strokeWidth="2"
            />
          )}
          {active && hasEarnings && active.earnings !== null && (
            <circle
              cx={toX(hover as number)}
              cy={yEarnings(active.earnings)}
              r="4"
              fill="var(--chart-earnings)"
              stroke="var(--surface)"
              strokeWidth="2"
            />
          )}
        </svg>

        {active && (
          <div
            className="chart-tip"
            style={{
              left: `${((toX(hover as number) / VB_W) * 100).toFixed(2)}%`,
              // 오른쪽 끝에서는 툴팁이 카드 밖으로 나가므로 왼쪽으로 뒤집는다
              transform:
                toX(hover as number) / VB_W > 0.6
                  ? "translateX(calc(-100% - 10px))"
                  : "translateX(10px)",
            }}
          >
            <div className="dim">{active.date}</div>
            <div>
              조회수 <b>{num(active.views)}</b>
              {active.users !== null && <span className="dim"> · 사용자 {num(active.users)}</span>}
            </div>
            {hasEarnings && (
              <div>
                수익 <b>{money(active.earnings, currency)}</b>
                {active.clicks !== null && (
                  <span className="dim"> · 클릭 {num(active.clicks)}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 페이지
 * ------------------------------------------------------------------ */

export default function AnalyticsPage() {
  const [days, setDays] = useState(28);
  const [loading, setLoading] = useState(true);
  const [ga4, setGa4] = useState<Ga4Report | null>(null);
  const [adsense, setAdsense] = useState<AdsenseSummary | null>(null);
  /** 응답 자체를 못 받은 경우(네트워크·서버 다운). API 계약상 200 이 정상이라 따로 잡는다. */
  const [ga4Down, setGa4Down] = useState("");
  const [adsenseDown, setAdsenseDown] = useState("");
  /** 저장된 글 — 성과 행에 어떤 키워드로 썼는지 붙이는 데만 쓴다 */
  const [posts, setPosts] = useState<PostLike[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("earnings");
  const [sortDesc, setSortDesc] = useState(true);

  // 글 목록은 기간과 무관하므로 한 번만 받는다
  useEffect(() => {
    fetch("/api/posts")
      .then((r) => r.json())
      .then((d) => setPosts(Array.isArray(d.posts) ? d.posts : []))
      .catch(() => setPosts([]));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setGa4Down("");
    setAdsenseDown("");

    /*
     * 두 API 는 서로 독립이라 한쪽이 죽어도 나머지는 보여야 한다.
     * allSettled 로 각각 따로 받아, 실패한 쪽에만 경고를 띄운다.
     */
    Promise.allSettled([
      fetch(`/api/analytics/ga4?days=${days}`, { signal: ac.signal }).then((r) => r.json()),
      fetch(`/api/analytics/adsense?days=${days}`, { signal: ac.signal }).then((r) => r.json()),
    ])
      .then(([g, a]) => {
        if (ac.signal.aborted) return;
        if (g.status === "fulfilled") setGa4(g.value as Ga4Report);
        else {
          setGa4(null);
          setGa4Down((g.reason as Error).message);
        }
        if (a.status === "fulfilled") setAdsense(a.value as AdsenseSummary);
        else {
          setAdsense(null);
          setAdsenseDown((a.reason as Error).message);
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [days]);

  const currency = adsense?.currency || "";
  const connected = adsense?.connected === true;
  /** 연결은 됐는데 응답이 실패한 경우에만 수익 숫자를 믿을 수 없다 */
  const adsenseUsable = connected && adsense?.ok === true;

  const daily = useMemo(
    () => mergeDaily(ga4?.daily ?? [], adsenseUsable ? (adsense?.daily ?? []) : []),
    [ga4, adsense, adsenseUsable],
  );

  const rows = useMemo(
    () =>
      attachKeywords(
        joinPerformance(ga4?.pages ?? [], adsenseUsable ? (adsense?.pages ?? []) : []),
        posts,
      ),
    [ga4, adsense, adsenseUsable, posts],
  );

  const sorted = useMemo(() => sortRows(rows, sortKey, sortDesc), [rows, sortKey, sortDesc]);

  const hasEarningsSeries = adsenseUsable && daily.some((d) => d.earnings !== null);

  /*
   * "오류" 와 "아직 0" 은 완전히 다른 상황이다. 태그를 방금 단 블로그는 GA4 가 정상
   * 응답하면서도 며칠간 0 을 준다. 이때 0 만 띄우면 고장난 줄 알고 설정을 다시 만진다.
   */
  const ga4Empty =
    ga4?.ok === true && !ga4.error && ga4.totals.views === 0 && ga4.daily.length === 0;

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDesc((v) => !v);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  function sortLabel(key: SortKey, label: string) {
    return (
      <button className="small ghost" onClick={() => toggleSort(key)}>
        {label} {sortKey === key ? (sortDesc ? "▾" : "▴") : ""}
      </button>
    );
  }

  return (
    <>
      <h1 className="page-title">성과</h1>
      <p className="page-desc">
        GA4 조회수와 애드센스 수익을 한 화면에서 봅니다. 아래{" "}
        <strong>글별 성과</strong> 표가 핵심입니다 — 어떤 키워드로 쓴 글이 실제로 돈이
        됐는지 확인하고 다음 키워드 선정에 반영하세요.
      </p>

      <div className="card">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>
            기간 {loading && <span className="spinner" />}
          </h2>
          <div className="row" style={{ gap: 6 }}>
            {RANGES.map((d) => (
              <button
                key={d}
                className={d === days ? "primary small" : "small ghost"}
                onClick={() => setDays(d)}
                disabled={loading}
              >
                {d}일
              </button>
            ))}
          </div>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          두 API 에 같은 기간을 넘깁니다. 애드센스 수치는 확정 전 추정치라 최근 1~2일은
          나중에 조금 바뀔 수 있습니다.
        </p>
      </div>

      {/* 실패한 쪽만 경고한다. 나머지 절반은 그대로 쓸 수 있어야 한다. */}
      {ga4Down && (
        <div className="alert error">
          GA4 응답을 받지 못했습니다 — {ga4Down}. 개발 서버가 떠 있는지 확인하세요.
        </div>
      )}
      {ga4?.error && (
        <div className={`alert ${ga4.ok ? "warn" : "error"}`}>
          GA4 — {ga4.error} <a href="/settings">설정</a>에서 서비스 계정과 속성 ID 를
          확인하세요.
        </div>
      )}
      {ga4Empty && (
        <div className="alert warn">
          GA4 는 정상 연결됐지만 <strong>아직 수집된 데이터가 없습니다</strong> — 태그를
          설치한 뒤 실제 방문이 집계되기까지 몇 시간 걸립니다. 설정이 잘못된 게 아니니
          내일 다시 열어 보세요.
        </div>
      )}
      {adsenseDown && (
        <div className="alert error">애드센스 응답을 받지 못했습니다 — {adsenseDown}</div>
      )}
      {adsense && !connected && (
        <div className="alert warn">
          애드센스가 연결되지 않아 수익·클릭·RPM 은 비어 있습니다. 조회수 지표는 그대로
          쓸 수 있습니다. <a href="/settings">설정</a>에서 애드센스를 연결하세요.
          {adsense.error ? ` (${adsense.error})` : ""}
        </div>
      )}
      {adsense && connected && !adsense.ok && (
        <div className="alert error">
          애드센스 — {adsense.error ?? "수익을 가져오지 못했습니다."}{" "}
          <a href="/settings">설정</a>에서 다시 연결해 보세요.
        </div>
      )}

      <div className="card">
        <h2>요약 · 최근 {days}일</h2>
        <div className="stats">
          <div className="stat">
            <div className="k">조회수</div>
            <div className="v">{num(ga4?.totals.views ?? null)}</div>
            <div className="s">GA4 페이지뷰</div>
          </div>
          <div className="stat">
            <div className="k">사용자</div>
            <div className="v">{num(ga4?.totals.users ?? null)}</div>
            <div className="s">중복 제거</div>
          </div>

          {adsenseUsable ? (
            <>
              <div className="stat">
                <div className="k">수익</div>
                <div className="v">{money(adsense?.totals.earnings ?? null, currency)}</div>
                <div className="s">노출 {num(adsense?.totals.impressions ?? null)}</div>
              </div>
              <div className="stat">
                <div className="k">클릭</div>
                <div className="v">{num(adsense?.totals.clicks ?? null)}</div>
                <div className="s">애드센스 조회 {num(adsense?.totals.pageViews ?? null)}</div>
              </div>
              <div className="stat">
                <div className="k">CPC</div>
                <div className="v">{money(adsense?.totals.cpc ?? null, currency)}</div>
                <div className="s">클릭 1회당</div>
              </div>
            </>
          ) : (
            /*
             * 0 으로 채우면 "벌이가 없다" 로 읽히는데 연결이 안 된 것과는 전혀 다르다.
             * 아직 응답을 못 받은 동안 "연결 필요" 를 띄우는 것도 거짓말이라,
             * 모르는 상태 · 미연결 · 연결됐지만 실패 세 가지를 나눠 적는다.
             */
            ["수익", "클릭", "CPC"].map((label) => (
              <div className={`stat${adsense ? " off" : ""}`} key={label}>
                <div className="k">{label}</div>
                <div className="v">
                  {!adsense ? "—" : connected ? "가져오기 실패" : "연결 필요"}
                </div>
                <div className="s">
                  {!adsense ? (
                    loading ? (
                      "불러오는 중"
                    ) : (
                      "응답 없음"
                    )
                  ) : connected ? (
                    "잠시 후 다시 시도하세요"
                  ) : (
                    <a href="/settings">설정에서 애드센스 연결</a>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <h2>일별 추이</h2>
        {daily.length < 2 ? (
          <div className="empty">
            {loading
              ? "불러오는 중입니다."
              : daily.length === 1
                ? "데이터가 하루치뿐이라 추이를 그릴 수 없습니다. 며칠 더 쌓이면 나타납니다."
                : "아직 그릴 데이터가 없습니다."}
          </div>
        ) : (
          <TrendChart points={daily} currency={currency} hasEarnings={hasEarningsSeries} />
        )}
        <p className="hint">
          단위가 다른 두 지표라 각각 <strong>기간 내 자기 최대값을 100%</strong> 로 놓고
          한 축에 겹쳤습니다. 절대값은 범례와 마우스를 올렸을 때 나오는 값에 있습니다.
          두 선이 벌어지면 <em>조회수는 늘었는데 수익은 안 늘었다</em> 는 뜻이라, 그
          구간에 발행한 글의 주제가 광고 단가가 낮았는지 의심해 볼 수 있습니다.
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>
            글별 성과{" "}
            {sorted.length > 0 && <span className="badge on">{sorted.length}건</span>}
          </h2>
        </div>

        {sorted.length === 0 ? (
          <div className="empty">
            {loading
              ? "불러오는 중입니다."
              : ga4Empty
                ? "아직 수집된 데이터가 없습니다 — 태그 설치 후 몇 시간 걸립니다."
                : "표시할 글이 없습니다."}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>글</th>
                  <th
                    style={{ width: 150 }}
                    title="이 글을 쓸 때 쓴 메인 + 서브 키워드. 저장된 글과 제목이 이어질 때만 보입니다"
                  >
                    키워드
                  </th>
                  <th style={{ width: 96 }} className="num">
                    {sortLabel("views", "조회수")}
                  </th>
                  <th style={{ width: 80 }} className="num">
                    사용자
                  </th>
                  <th style={{ width: 90 }} className="num">
                    평균 체류
                  </th>
                  <th style={{ width: 130 }} className="num">
                    {sortLabel("earnings", "수익")}
                  </th>
                  <th style={{ width: 70 }} className="num">
                    클릭
                  </th>
                  <th
                    style={{ width: 120 }}
                    className="num"
                    title="1000회 조회당 수익 = 수익 ÷ 조회수 × 1000"
                  >
                    {sortLabel("rpm", "RPM")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.path}>
                    <td className="kw-cell">
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.title}
                        </a>
                      ) : (
                        r.title
                      )}
                      {r.source === "both" ? (
                        <span className="badge on" style={{ marginLeft: 6 }}>
                          양쪽
                        </span>
                      ) : r.source === "ga4" ? (
                        <span className="badge" style={{ marginLeft: 6 }} title="애드센스 수익 데이터에 이 주소가 없습니다">
                          조회수만
                        </span>
                      ) : (
                        <span className="badge" style={{ marginLeft: 6 }} title="GA4 에 이 주소가 없습니다 — 해당 글에 태그가 안 붙었을 수 있습니다">
                          수익만
                        </span>
                      )}
                      <div className="dim mono">{r.path}</div>
                    </td>
                    <td>
                      {r.keyword ? (
                        <span className="tag">{r.keyword}</span>
                      ) : (
                        <span className="dim" title="저장된 글 중 제목이 이어지는 것이 없습니다">
                          —
                        </span>
                      )}
                    </td>
                    <td className="num strong">{num(r.views)}</td>
                    <td className="num dim">{num(r.users)}</td>
                    <td className="num dim">{duration(r.avgSeconds)}</td>
                    <td className="num strong">{money(r.earnings, currency)}</td>
                    <td className="num dim">{num(r.clicks)}</td>
                    <td className="num">{money(r.rpm, currency, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="hint">
          GA4 의 경로와 애드센스의 절대 URL 을 <strong>경로 기준</strong>으로 맞췄습니다
          (쿼리·끝슬래시 제거, 한글 디코딩). 한쪽에만 있는 글도 배지를 달아 남깁니다 —
          <strong> 수익만</strong> 이면 그 글에 GA4 태그가 안 붙었을 수 있고,{" "}
          <strong>조회수만</strong> 이면 트래픽은 도는데 광고 수익이 안 잡히는 글입니다.{" "}
          <strong>RPM</strong> 은 조회수 1000회당 수익으로, 조회수가 적어도 단가 높은
          주제면 크게 나옵니다. 다음 키워드를 고를 때 조회수보다 이 열을 먼저 보세요.
          (수익만 있는 글은 GA4 조회수가 없어 애드센스 페이지뷰로 대신 계산한
          근사값입니다.)
        </p>
      </div>

      {daily.length > 0 && (
        <details>
          <summary>일별 원본 수치 (표로 보기)</summary>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>날짜</th>
                  <th className="num">조회수</th>
                  <th className="num">사용자</th>
                  <th className="num">수익</th>
                  <th className="num">클릭</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => (
                  <tr key={d.date}>
                    <td className="mono">{d.date}</td>
                    <td className="num">{num(d.views)}</td>
                    <td className="num dim">{num(d.users)}</td>
                    <td className="num">{money(d.earnings, currency)}</td>
                    <td className="num dim">{num(d.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
