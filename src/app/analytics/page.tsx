"use client";

import { useEffect, useMemo, useState } from "react";
import Help from "@/components/Help";
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

/** 유입 경로를 사람이 읽는 이름으로 바꾼다. 같은 이름은 화면에서 하나로 합친다 */
function sourceLabel(sourceRaw: string, mediumRaw: string): string {
  const source = (sourceRaw ?? "").trim().toLowerCase();
  const medium = (mediumRaw ?? "").trim().toLowerCase();
  const organic = medium === "organic";

  if (source === "(direct)" || (source === "" && (medium === "(none)" || medium === ""))) {
    return "직접 방문";
  }
  // gemini.google.com 은 구글 검색이 아니라 AI 답변이라 구글보다 먼저 본다
  if (source.includes("gemini")) return "Gemini";
  if (source.includes("chatgpt") || source.includes("openai")) return "ChatGPT";
  if (source.includes("perplexity")) return "Perplexity";
  if (source.includes("naver")) {
    if (organic || source.includes("search.naver")) return "네이버 검색";
    if (source.includes("blog.naver")) return "네이버 블로그";
    if (source.includes("cafe.naver")) return "네이버 카페";
    return "네이버 (기타)";
  }
  if (source.includes("google")) {
    if (organic) return "구글 검색";
    if (medium === "cpc") return "구글 광고";
    return "구글 (기타)";
  }
  if (source.includes("daum") || source.includes("kakao")) {
    if (organic || source.includes("search.daum")) return "다음 검색";
    return source.includes("kakao") ? "카카오" : "다음 (기타)";
  }
  if (source.includes("bing")) return "빙 검색";
  if (source.includes("yahoo")) return "야후 검색";
  if (source.includes("tistory")) return "티스토리";
  if (source.includes("threads")) return "쓰레드";
  if (source.includes("instagram")) return "인스타그램";
  if (source.includes("facebook")) return "페이스북";
  if (source === "t.co" || source.includes("twitter") || source === "x.com") return "X (트위터)";
  if (source.includes("velog")) return "velog";
  return medium && medium !== "(none)" ? `${sourceRaw} / ${mediumRaw}` : sourceRaw || "(알 수 없음)";
}

type SourceLike = { source: string; medium: string; sessions: number; views: number };

type SourceGroup = {
  label: string;
  sessions: number;
  views: number;
  /** 합쳐진 원본 source / medium — 보조 줄에 보여준다 */
  raw: string[];
};

/** 같은 이름으로 묶고 세션 많은 순으로 */
function groupSources(rows: SourceLike[]): SourceGroup[] {
  const map = new Map<string, SourceGroup>();
  for (const r of rows) {
    const label = sourceLabel(r.source, r.medium);
    let hit = map.get(label);
    if (!hit) {
      hit = { label, sessions: 0, views: 0, raw: [] };
      map.set(label, hit);
    }
    hit.sessions += r.sessions ?? 0;
    hit.views += r.views ?? 0;
    hit.raw.push(`${r.source} / ${r.medium}`);
  }
  return [...map.values()].sort((a, b) => b.sessions - a.sessions || b.views - a.views);
}

/** GA4 이벤트 이름 → 한국어. 모르는 이름은 그대로 둔다 */
const EVENT_LABELS: Record<string, string> = {
  calculator_use: "계산기 사용",
  scroll: "끝까지 스크롤",
  page_view: "페이지 조회",
  session_start: "세션 시작",
  first_visit: "첫 방문",
  user_engagement: "참여(10초 이상 머묾)",
  click: "외부 링크 클릭",
  file_download: "파일 다운로드",
  view_search_results: "블로그 안 검색",
  form_start: "입력 시작",
  form_submit: "입력 제출",
  video_start: "동영상 재생",
  video_progress: "동영상 진행",
  video_complete: "동영상 끝까지 봄",
  copy: "복사",
  share: "공유",
};

function eventLabel(name: string): string {
  return EVENT_LABELS[name] ?? name;
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
 * 검색 유입 (서치콘솔 + GA4 유입 경로·이벤트) — /api/insights
 * ------------------------------------------------------------------ */

type InsightDaily = { date: string; clicks: number; impressions: number; sessions: number; views: number };
type InsightQuery = {
  query: string;
  clicks: number;
  impressions: number;
  /** 0~1 */
  ctr: number;
  /** 평균 순위. 작을수록 좋다 */
  position: number;
  pages: string[];
};
type InsightOpportunity = {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  pages: string[];
};
type InsightPage = {
  path: string;
  title?: string;
  views: number;
  sessions: number;
  clicks: number;
  impressions: number;
  position: number | null;
};
type Insights = {
  ok: boolean;
  error?: string;
  lastDate: string | null;
  totals: { clicks: number; impressions: number; sessions: number; views: number };
  daily: InsightDaily[];
  queries: InsightQuery[];
  opportunities: InsightOpportunity[];
  sources: SourceLike[];
  pages: InsightPage[];
  events: { name: string; count: number }[];
};

type QueueItem = { keyword: string; note?: string; done?: boolean; postId?: number };

const INSIGHT_EMPTY =
  "아직 데이터가 없습니다. 매일 아침 9시 30분에 어제까지의 데이터가 쌓입니다. 서치콘솔은 2~3일 늦게 들어옵니다.";

function rank(position: number | null | undefined, digits = 1): string {
  if (position === null || position === undefined || !Number.isFinite(position) || position <= 0) return "—";
  return `${position.toFixed(digits)}위`;
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/** 검색어가 걸린 페이지를 짧게. 여러 개면 첫 번째 + 외 N */
function pagesText(pages: string[] | undefined): string {
  const list = (pages ?? []).filter(Boolean);
  if (!list.length) return "";
  const first = normalizePath(list[0]);
  return list.length > 1 ? `${first} 외 ${list.length - 1}` : first;
}

/** 싱크 결과 조각은 숫자·문자열·{start,end} 무엇이 와도 한 줄로 */
function syncPart(v: unknown): string {
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("start" in o || "end" in o) return `${String(o.start ?? "?")} ~ ${String(o.end ?? "?")}`;
    if ("startDate" in o || "endDate" in o)
      return `${String(o.startDate ?? "?")} ~ ${String(o.endDate ?? "?")}`;
    if (typeof o.rows === "number") return o.rows.toLocaleString();
    if (typeof o.count === "number") return o.count.toLocaleString();
  }
  return v === undefined || v === null ? "—" : JSON.stringify(v);
}

const MINI_W = 600;
const MINI_H = 120;

/**
 * 노출·세션 두 줄. 단위가 달라 각자 기간 최대값을 100% 로 놓는다(아래 성과 그래프와 같은 규칙).
 * preserveAspectRatio="none" 으로 카드 폭에 맞춰 늘리고, 글자는 SVG 밖(HTML)에 둬서
 * 폰에서 글자가 깨알처럼 줄어들지 않게 한다.
 */
function MiniTrend({ points }: { points: InsightDaily[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const maxImpr = Math.max(1, ...points.map((p) => p.impressions ?? 0));
  const maxSess = Math.max(1, ...points.map((p) => p.sessions ?? 0));
  const toX = (i: number) => (points.length < 2 ? MINI_W / 2 : (i / (points.length - 1)) * MINI_W);
  const toY = (v: number, max: number) => 4 + (MINI_H - 8) * (1 - v / max);
  const line = (pick: (p: InsightDaily) => number, max: number) =>
    points.map((p, i) => `${toX(i).toFixed(1)},${toY(pick(p) ?? 0, max).toFixed(1)}`).join(" ");

  function onPointer(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    const i = Math.round(ratio * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  }

  const active = hover !== null ? points[hover] : null;
  const activeRatio = hover !== null ? toX(hover) / MINI_W : 0;
  const mid = points[Math.floor((points.length - 1) / 2)];

  return (
    <>
      <div className="legend">
        <span>
          <i style={{ borderColor: "var(--chart-impressions)" }} />
          검색 노출 <span className="dim">(최대 {maxImpr.toLocaleString()})</span>
        </span>
        <span>
          <i style={{ borderColor: "var(--chart-views)" }} />
          방문(세션) <span className="dim">(최대 {maxSess.toLocaleString()})</span>
        </span>
      </div>
      <div className="mini-chart">
        <svg
          viewBox={`0 0 ${MINI_W} ${MINI_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="일별 검색 노출과 방문 추이"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={0}
              x2={MINI_W}
              y1={toY(f, 1)}
              y2={toY(f, 1)}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hover !== null && (
            <line
              x1={toX(hover)}
              x2={toX(hover)}
              y1={0}
              y2={MINI_H}
              stroke="var(--text-dim)"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            points={line((p) => p.impressions, maxImpr)}
            fill="none"
            stroke="var(--chart-impressions)"
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={line((p) => p.sessions, maxSess)}
            fill="none"
            stroke="var(--chart-views)"
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {active && (
          <div
            className="chart-tip"
            style={{
              left: `${(activeRatio * 100).toFixed(2)}%`,
              transform: activeRatio > 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            }}
          >
            <div className="dim">{active.date}</div>
            <div>
              노출 <b>{num(active.impressions ?? 0)}</b>
              <span className="dim"> · 클릭 {num(active.clicks ?? 0)}</span>
            </div>
            <div>
              세션 <b>{num(active.sessions ?? 0)}</b>
              <span className="dim"> · 조회 {num(active.views ?? 0)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="mini-chart-axis">
        <span>{shortDate(points[0].date)}</span>
        {points.length > 2 && <span>{shortDate(mid.date)}</span>}
        <span>{shortDate(points[points.length - 1].date)}</span>
      </div>
    </>
  );
}

function SearchInsights() {
  const [days, setDays] = useState(28);
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** 검색어별 큐 추가 상태 */
  const [queued, setQueued] = useState<Record<string, "adding" | "added" | "exists" | "fail">>({});

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/insights?days=${days}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d: Insights) => {
        if (ac.signal.aborted) return;
        if (d.ok === false) setError(d.error ?? "불러오지 못했습니다.");
        setData(d);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [days, reload]);

  async function syncNow() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await fetch("/api/insights/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? "수집에 실패했습니다.");
      const r = (d.result ?? {}) as Record<string, unknown>;
      const errs = Array.isArray(r.errors) ? (r.errors as unknown[]) : [];
      const parts = [
        `검색 ${syncPart(r.search)}`,
        `유입 ${syncPart(r.traffic)}`,
        `이벤트 ${syncPart(r.events)}`,
      ];
      if (r.range !== undefined) parts.push(`기간 ${syncPart(r.range)}`);
      setSyncNote({
        ok: errs.length === 0,
        text:
          parts.join(" · ") +
          (errs.length
            ? ` — 실패 ${errs.length}건: ${typeof errs[0] === "string" ? errs[0] : JSON.stringify(errs[0])}`
            : ""),
      });
      setReload((n) => n + 1);
    } catch (e) {
      setSyncNote({ ok: false, text: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  }

  async function addToQueue(o: InsightOpportunity) {
    setQueued((q) => ({ ...q, [o.query]: "adding" }));
    try {
      const cur = await (await fetch("/api/queue")).json();
      if (cur.ok === false) throw new Error(cur.error);
      const list: QueueItem[] = Array.isArray(cur.queue) ? cur.queue : [];
      if (list.some((q) => q.keyword === o.query && !q.done)) {
        setQueued((q) => ({ ...q, [o.query]: "exists" }));
        return;
      }
      const next: QueueItem[] = [
        ...list,
        {
          keyword: o.query,
          note: `기회 검색어 · ${rank(o.position)} · 노출 ${num(o.impressions)}`,
        },
      ];
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queue: next }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setQueued((q) => ({ ...q, [o.query]: "added" }));
    } catch {
      setQueued((q) => ({ ...q, [o.query]: "fail" }));
    }
  }

  const queries = useMemo(
    () => [...(data?.queries ?? [])].sort((a, b) => b.impressions - a.impressions).slice(0, 50),
    [data],
  );
  const opportunities = useMemo(
    () => [...(data?.opportunities ?? [])].sort((a, b) => b.impressions - a.impressions),
    [data],
  );
  const sources = useMemo(() => groupSources(data?.sources ?? []), [data]);
  const sourceTotal = sources.reduce((a, s) => a + s.sessions, 0);
  const sourceMax = Math.max(1, ...sources.map((s) => s.sessions));
  const pages = useMemo(
    () => [...(data?.pages ?? [])].sort((a, b) => b.views - a.views || b.clicks - a.clicks),
    [data],
  );
  const events = useMemo(
    () => [...(data?.events ?? [])].sort((a, b) => b.count - a.count),
    [data],
  );
  const daily = data?.daily ?? [];

  const empty =
    !!data &&
    !daily.length &&
    !queries.length &&
    !opportunities.length &&
    !sources.length &&
    !pages.length &&
    !events.length;

  const t = data?.totals;

  return (
    <>
      <div className="card">
        <h2>
          검색 유입 {loading && <span className="spinner" />}
          <Help text="구글 서치콘솔의 검색어·노출·순위와 GA4 의 유입 경로·이벤트를 매일 저장해 둔 것입니다. 네이버 검색 노출 수는 여기 없고, 네이버에서 들어온 방문만 '유입 경로'에 보입니다." />
        </h2>
        <div className="insight-controls">
          <div className="segment" role="tablist" aria-label="기간">
            {RANGES.map((d) => (
              <button
                key={d}
                role="tab"
                aria-selected={d === days}
                className={d === days ? "on" : ""}
                onClick={() => setDays(d)}
              >
                {d}일
              </button>
            ))}
          </div>
          <span className="dim insight-last">
            마지막 데이터 {data?.lastDate ? <span className="mono">{data.lastDate}</span> : "—"}
          </span>
          <button className="small" onClick={syncNow} disabled={syncing}>
            {syncing && <span className="spinner" />}
            {syncing ? "수집 중… (몇 분 걸림)" : "지금 수집"}
          </button>
        </div>

        {syncNote && (
          <div className={`alert ${syncNote.ok ? "ok" : "error"}`}>{syncNote.text}</div>
        )}
        {error && <div className="alert error">{error}</div>}

        <div className="stats">
          <div className="stat">
            <div className="k">검색 노출</div>
            <div className="v">{t ? num(t.impressions) : "—"}</div>
            <div className="s">구글 검색 결과에 뜬 횟수</div>
          </div>
          <div className="stat">
            <div className="k">검색 클릭</div>
            <div className="v">{t ? num(t.clicks) : "—"}</div>
            <div className="s">
              CTR {t && t.impressions > 0 ? pct(t.clicks / t.impressions) : "—"}
            </div>
          </div>
          <div className="stat">
            <div className="k">방문(세션)</div>
            <div className="v">{t ? num(t.sessions) : "—"}</div>
            <div className="s">모든 경로 합계</div>
          </div>
          <div className="stat">
            <div className="k">조회수</div>
            <div className="v">{t ? num(t.views) : "—"}</div>
            <div className="s">GA4 페이지뷰</div>
          </div>
        </div>

        {empty && <div className="empty">{INSIGHT_EMPTY}</div>}

        {daily.length >= 2 && (
          <div style={{ marginTop: 16 }}>
            <MiniTrend points={daily} />
          </div>
        )}
      </div>

      {!empty && data && (
        <>
          <div className="card">
            <h2>
              기회 검색어{" "}
              {opportunities.length > 0 && (
                <span className="badge accent">{opportunities.length}</span>
              )}
            </h2>
            <p className="hint" style={{ marginTop: 0, marginBottom: 4 }}>
              구글에 이미 노출되지만 1페이지 아래에 있는 검색어입니다. 이 검색어로 글을
              보강하거나 새로 쓰면 가장 빨리 유입이 늘어납니다.
            </p>
            {opportunities.length === 0 ? (
              <div className="empty">지금은 5~30위 사이에 걸린 검색어가 없습니다.</div>
            ) : (
              opportunities.map((o) => {
                const st = queued[o.query];
                const where = pagesText(o.pages);
                return (
                  <div key={o.query} className="list-item entry">
                    <div className="entry-main">
                      <div className="entry-line">
                        <span className="entry-title">{o.query}</span>
                        <span className="badge accent">{rank(o.position, 0)}</span>
                      </div>
                      <div className="entry-sub">
                        노출 {num(o.impressions)} · 클릭 {num(o.clicks)}
                        {where && (
                          <>
                            {" · "}
                            <span className="mono">{where}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="entry-side">
                      <button
                        className={`small ${st === "added" || st === "exists" ? "ghost" : ""}`}
                        onClick={() => addToQueue(o)}
                        disabled={st === "adding" || st === "added" || st === "exists"}
                      >
                        {st === "adding" && <span className="spinner" />}
                        {st === "added"
                          ? "큐에 넣음"
                          : st === "exists"
                            ? "이미 큐에 있음"
                            : st === "fail"
                              ? "실패 · 다시"
                              : "글감 큐에 추가"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="card">
            <h2>
              검색어 <span className="dim">· 노출 많은 순 상위 {queries.length}</span>
              <Help text="CTR 은 노출 대비 클릭 비율, 순위는 기간 평균입니다. 순위는 좋은데 CTR 이 낮으면 제목·설명을 손볼 차례입니다." />
            </h2>
            {queries.length === 0 ? (
              <div className="empty">서치콘솔 검색어가 아직 없습니다. 2~3일 늦게 들어옵니다.</div>
            ) : (
              <>
                <div className="narrow-only">
                  {queries.map((q) => (
                    <div key={q.query} className="list-item">
                      <div className="entry-line">
                        <span className="entry-title">{q.query}</span>
                        <span className="entry-num">{num(q.impressions)}</span>
                      </div>
                      <div className="entry-sub">
                        클릭 {num(q.clicks)} · CTR {pct(q.ctr)} · {rank(q.position)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="wide-only">
                  <div className="table-wrap compact">
                    <table>
                      <thead>
                        <tr>
                          <th>검색어</th>
                          <th className="num" style={{ width: 90 }}>노출</th>
                          <th className="num" style={{ width: 80 }}>클릭</th>
                          <th className="num" style={{ width: 80 }}>CTR</th>
                          <th className="num" style={{ width: 80 }}>순위</th>
                        </tr>
                      </thead>
                      <tbody>
                        {queries.map((q) => (
                          <tr key={q.query}>
                            <td className="kw-cell">
                              {q.query}
                              {q.pages?.length > 0 && (
                                <div className="dim mono">{pagesText(q.pages)}</div>
                              )}
                            </td>
                            <td className="num strong">{num(q.impressions)}</td>
                            <td className="num">{num(q.clicks)}</td>
                            <td className="num dim">{pct(q.ctr)}</td>
                            <td className="num">{rank(q.position)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h2>
              유입 경로
              <Help text="GA4 가 센 방문(세션)을 어디서 왔는지로 나눈 것입니다. 네이버·다음 검색으로 들어온 방문도 여기서 보입니다." />
            </h2>
            {sources.length === 0 ? (
              <div className="empty">유입 경로 데이터가 아직 없습니다.</div>
            ) : (
              sources.map((s) => (
                <div key={s.label} className="list-item">
                  <div className="entry-line">
                    <span className="entry-title">{s.label}</span>
                    <span className="entry-num">
                      {num(s.sessions)}
                      <span className="dim" style={{ fontWeight: 400 }}>
                        {" "}
                        · {sourceTotal > 0 ? Math.round((s.sessions / sourceTotal) * 100) : 0}%
                      </span>
                    </span>
                  </div>
                  <div className="meter" aria-hidden="true">
                    <i style={{ width: `${((s.sessions / sourceMax) * 100).toFixed(1)}%` }} />
                  </div>
                  <div className="entry-sub">
                    조회 {num(s.views)} · <span className="mono">{s.raw.slice(0, 3).join(", ")}</span>
                    {s.raw.length > 3 ? ` 외 ${s.raw.length - 3}` : ""}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h2>
              페이지별
              <Help text="조회·세션은 GA4, 검색 클릭·평균 순위는 서치콘솔 값입니다. 조회는 많은데 검색 클릭이 적으면 검색 말고 다른 경로로 들어오는 글입니다." />
            </h2>
            {pages.length === 0 ? (
              <div className="empty">페이지 데이터가 아직 없습니다.</div>
            ) : (
              <>
                <div className="narrow-only">
                  {pages.map((p) => (
                    <div key={p.path} className="list-item">
                      <div className="entry-title">{p.title || normalizePath(p.path)}</div>
                      <div className="entry-sub">
                        조회 {num(p.views)} · 세션 {num(p.sessions)} · 검색 클릭 {num(p.clicks)} ·{" "}
                        {rank(p.position)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="wide-only">
                  <div className="table-wrap compact">
                    <table>
                      <thead>
                        <tr>
                          <th>글</th>
                          <th className="num" style={{ width: 80 }}>조회</th>
                          <th className="num" style={{ width: 80 }}>세션</th>
                          <th className="num" style={{ width: 96 }}>검색 클릭</th>
                          <th className="num" style={{ width: 96 }}>평균 순위</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pages.map((p) => (
                          <tr key={p.path}>
                            <td className="kw-cell">
                              {p.title || normalizePath(p.path)}
                              {p.title && <div className="dim mono">{normalizePath(p.path)}</div>}
                            </td>
                            <td className="num strong">{num(p.views)}</td>
                            <td className="num">{num(p.sessions)}</td>
                            <td className="num">{num(p.clicks)}</td>
                            <td className="num dim">{rank(p.position)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h2>
              이벤트
              <Help text="글 안에서 방문자가 한 행동입니다. '끝까지 스크롤' 이 조회수에 비해 적으면 글이 길거나 도입부에서 이탈한다는 뜻입니다." />
            </h2>
            {events.length === 0 ? (
              <div className="empty">이벤트 데이터가 아직 없습니다.</div>
            ) : (
              events.map((e) => (
                <div key={e.name} className="list-item entry-line">
                  <span>
                    {eventLabel(e.name)}
                    {eventLabel(e.name) !== e.name && (
                      <span className="dim mono" style={{ marginLeft: 6, fontSize: 12 }}>
                        {e.name}
                      </span>
                    )}
                  </span>
                  <span className="entry-num">{num(e.count)}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
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
        위는 검색 유입(어떤 검색어로 들어오는지), 아래는 GA4 조회수와 애드센스 수익입니다.
        가장 먼저 <strong>기회 검색어</strong>를 보세요. 수익 쪽은 아래{" "}
        <strong>글별 성과</strong> 표가 핵심입니다 — 어떤 키워드로 쓴 글이 실제로 돈이
        됐는지 확인하고 다음 키워드 선정에 반영하세요.
      </p>

      <SearchInsights />

      <h2 className="group-title">조회수 · 수익</h2>

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
        <h2>
          요약 · 최근 {days}일
          <Help text="네이버 블로그는 외부 스크립트를 막아서 여기 숫자는 티스토리만 집계됩니다.&#10;GA4 는 태그를 단 시점부터만 쌓이고 소급되지 않습니다." />
        </h2>
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
        <h2>
          일별 추이
          <Help text="조회수와 수익이 같이 움직이는지 봅니다. 조회수만 오르고 수익이 안 따라오면 광고가 안 붙는 주제라는 뜻이니, 키워드 탐색에서 '수익 잠재력' 정렬로 바꿔보세요." />
        </h2>
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
                  <th
                    style={{ width: 80 }}
                    className="num"
                    title="순 방문자 수. 조회수보다 훨씬 적으면 한 사람이 여러 번 본 것이거나 새로고침이 섞인 것입니다"
                  >
                    사용자
                  </th>
                  <th
                    style={{ width: 90 }}
                    className="num"
                    title="글에 머문 평균 시간. 30초 미만이면 제목과 본문이 안 맞아 바로 나간 것입니다 — 검색 의도를 다시 보세요"
                  >
                    평균 체류
                  </th>
                  <th style={{ width: 130 }} className="num">
                    {sortLabel("earnings", "수익")}
                  </th>
                  <th
                    style={{ width: 70 }}
                    className="num"
                    title="애드센스 광고 클릭 수. 조회수 대비 너무 낮으면 광고 위치나 주제의 상업적 의도를 점검하세요"
                  >
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
