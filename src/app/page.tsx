"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { COMPETITION_LABEL, competitionLevel } from "@/lib/competition";
import type { SerpStats } from "@/lib/serp";
import type { Keyword, KeywordFetchResult } from "@/lib/types";

type SettingsState = {
  searchAd: { configured: boolean };
  openApi: { configured: boolean };
};

type TrendingRow = {
  keyword: string;
  approxTraffic: number | null;
  bid: number | null;
  totalSearches: number | null;
  revenueScore: number | null;
};

const SORTS = [
  { id: "revenue", label: "수익 잠재력 높은 순 (애드센스)" },
  { id: "bid", label: "광고 단가 높은 순" },
  { id: "searches", label: "월간 검색수 많은 순" },
  { id: "absorption", label: "광고 흡수율 낮은 순" },
  { id: "mobile", label: "모바일 비중 높은 순" },
  { id: "competition", label: "경쟁률 낮은 순" },
  { id: "docs", label: "문서수 적은 순" },
];

/** 경쟁 분석 한 번에 긁을 수 있는 최대 개수 (서버도 같은 상한을 건다) */
const MAX_SELECT = 20;
/** 데이터랩은 키워드 그룹을 5개까지만 받는다 */
const MAX_TREND = 5;

function num(v: number | null): string {
  return v === null ? "—" : v.toLocaleString();
}

function pct(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

/** 데이터랩 상대지수 추이를 작은 折れ선으로 */
function Sparkline({ data }: { data: { ratio: number }[] }) {
  if (data.length < 2) return <span className="dim">—</span>;
  const w = 68;
  const h = 18;
  const max = Math.max(...data.map((d) => d.ratio), 1);
  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (d.ratio / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="spark" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function KeywordsPage() {
  const router = useRouter();
  const [seedInput, setSeedInput] = useState("");
  const [limit, setLimit] = useState(50);
  const [minSearches, setMinSearches] = useState(100);
  const [sort, setSort] = useState("revenue");
  const [includeDocs, setIncludeDocs] = useState(true);
  const [includeTrend, setIncludeTrend] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KeywordFetchResult | null>(null);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [trendError, setTrendError] = useState("");
  const [trendLoading, setTrendLoading] = useState(false);
  const [serpError, setSerpError] = useState("");
  const [serpLoading, setSerpLoading] = useState(false);
  /** 진입 시 복원한 스냅샷의 조회 시각. 지금 막 조회한 게 아니라는 표시용 */
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [trending, setTrending] = useState<TrendingRow[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => setSettings(null));

    /*
     * 들어오자마자 지난 조회 결과를 되살린다. DB 에 저장된 스냅샷이라 API 를 다시
     * 때리지 않으므로 즉시 뜨고 쿼터도 안 먹는다.
     */
    fetch("/api/keywords?latest=1")
      .then((r) => r.json())
      .then((d) => {
        if (!d.latest?.keywords?.length) return;
        setSeedInput(d.latest.seeds.join(", "));
        setRestoredAt(d.latest.fetchedAt);
        setResult({
          ok: true,
          seeds: d.latest.seeds,
          keywords: d.latest.keywords,
          sources: [],
        });
      })
      .catch(() => {});

    // 실시간 급상승은 캐시(10분)가 걸려 있어 진입 때마다 불러도 부담이 적다
    setTrendingLoading(true);
    fetch("/api/trending")
      .then((r) => r.json())
      .then((d) => {
        setTrending(d.items ?? []);
        if (d.error) setTrendingError(d.error);
      })
      .catch((e) => setTrendingError((e as Error).message))
      .finally(() => setTrendingLoading(false));
  }, []);

  const seeds = useMemo(
    () =>
      seedInput
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [seedInput],
  );

  async function run() {
    setLoading(true);
    setResult(null);
    setSelected([]);
    setTrendError("");
    setRestoredAt(null);
    try {
      const res = await fetch("/api/keywords", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seeds,
          limit,
          minSearches,
          sort,
          includeDocs,
          includeTrend,
        }),
      });
      setResult(await res.json());
    } catch (e) {
      setResult({
        ok: false,
        seeds,
        keywords: [],
        sources: [],
        error: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }

  /** 체크한 키워드(최대 5개)의 추세를 따로 불러 표에 덧붙인다 */
  async function loadTrend() {
    if (!selected.length) return;
    setTrendLoading(true);
    setTrendError("");
    try {
      const res = await fetch("/api/trend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keywords: selected.slice(0, MAX_TREND) }),
      });
      const d = await res.json();
      if (!d.ok) {
        setTrendError(d.error ?? "추세를 가져오지 못했습니다.");
        return;
      }
      const byKeyword = new Map<string, { data: { period: string; ratio: number }[]; delta: number | null }>(
        d.series.map((s: { keyword: string; data: { period: string; ratio: number }[]; delta: number | null }) => [
          s.keyword,
          { data: s.data, delta: s.delta },
        ]),
      );
      setResult((prev) =>
        prev
          ? {
              ...prev,
              keywords: prev.keywords.map((k) => {
                const hit = byKeyword.get(k.keyword);
                return hit ? { ...k, trend: hit.data, trendDelta: hit.delta } : k;
              }),
            }
          : prev,
      );
    } catch (e) {
      setTrendError((e as Error).message);
    } finally {
      setTrendLoading(false);
    }
  }

  /** 체크한 키워드의 블로그 검색 결과를 긁어 상위권 경쟁 지표를 채운다 */
  async function loadSerp() {
    if (!selected.length) return;
    setSerpLoading(true);
    setSerpError("");
    try {
      const res = await fetch("/api/serp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keywords: selected }),
      });
      const d = await res.json();
      if (!d.ok) {
        setSerpError(d.error ?? "경쟁 분석에 실패했습니다.");
        return;
      }
      if (d.error) setSerpError(d.error);
      const byKeyword = new Map<string, SerpStats>(
        (d.results as { keyword: string; stats: SerpStats | null }[])
          .filter((r) => r.stats)
          .map((r) => [r.keyword, r.stats as SerpStats]),
      );
      setResult((prev) =>
        prev
          ? {
              ...prev,
              keywords: prev.keywords.map((k) => {
                const hit = byKeyword.get(k.keyword);
                return hit ? { ...k, serp: hit } : k;
              }),
            }
          : prev,
      );
    } catch (e) {
      setSerpError((e as Error).message);
    } finally {
      setSerpLoading(false);
    }
  }

  const visible = useMemo(() => {
    const list = result?.keywords ?? [];
    if (!filter.trim()) return list;
    const q = filter.trim().toLowerCase();
    return list.filter((k) => k.keyword.toLowerCase().includes(q));
  }, [result, filter]);

  const hasTrend = useMemo(
    () => (result?.keywords ?? []).some((k) => k.trend?.length),
    [result],
  );

  const hasSerp = useMemo(
    () => (result?.keywords ?? []).some((k) => k.serp),
    [result],
  );

  /** 진입 난이도 0~100 을 경쟁률과 같은 4단계 배지로 */
  function difficultyLevel(v: number | null) {
    if (v === null) return null;
    if (v < 25) return "good" as const;
    if (v < 45) return "ok" as const;
    if (v < 65) return "warn" as const;
    return "bad" as const;
  }

  function toggleSelect(keyword: string) {
    setSelected((prev) =>
      prev.includes(keyword)
        ? prev.filter((k) => k !== keyword)
        : prev.length >= MAX_SELECT
          ? prev
          : [...prev, keyword],
    );
  }

  /**
   * 같은 조회에서 나온 다른 키워드를 제안 근거(context)로 함께 넘긴다.
   * auto 면 /write 가 진입 즉시 제안→본문 파이프라인을 돌린다.
   */
  function writeWith(keyword: string, auto = false) {
    const context = (result?.keywords ?? [])
      .map((k) => k.keyword)
      .filter((k) => k && k !== keyword)
      .slice(0, 40);
    const params = new URLSearchParams({ main: keyword });
    if (context.length) params.set("context", context.join("|"));
    if (auto) params.set("auto", "1");
    router.push(`/write?${params.toString()}`);
  }

  return (
    <>
      <h1 className="page-title">키워드 탐색</h1>
      <p className="page-desc">
        시드 키워드를 넣으면 <strong>검색광고 키워드도구</strong>로 연관 키워드와 월간
        검색수를 가져오고, <strong>검색 API</strong>로 블로그 문서수를 세어 경쟁률을
        계산합니다. 마음에 드는 키워드의 <strong>작성</strong> 버튼을 누르면 메인 키워드로
        넘어가고, 옆의 <strong>⚡</strong> 는 서브 키워드 제안부터 본문까지 한 번에
        만듭니다.
      </p>

      {settings && !settings.searchAd.configured && (
        <div className="alert warn">
          검색광고 API 자격증명이 없습니다. <a href="/settings">설정</a>에서 API 키·비밀키·
          CUSTOMER_ID 를 먼저 등록하세요.
        </div>
      )}
      {settings?.searchAd.configured && !settings.openApi.configured && (
        <div className="alert warn">
          검색 API·데이터랩은 네이버가 신규 신청을 받지 않아 문서수·경쟁률·추세 열은
          비어 있습니다. 대신 <strong>광고 흡수율</strong>과 <strong>모바일 비중</strong>
          으로 판단하세요. 승인된 키가 있다면 <a href="/settings">설정</a>에서 등록하면
          바로 채워집니다.
        </div>
      )}

      <div className="card">
        <h2>
          지금 급상승{" "}
          {trendingLoading && <span className="spinner" />}
          {!trendingLoading && trending.length > 0 && (
            <span className="badge on">{trending.length}건 · 단가순</span>
          )}
        </h2>
        {trendingError && <div className="alert warn">{trendingError}</div>}
        {!trendingLoading && trending.length === 0 && !trendingError ? (
          <div className="empty">급상승 키워드가 없습니다.</div>
        ) : (
          <div className="trending">
            {trending.map((t) => (
              <button
                key={t.keyword}
                className="trend-chip"
                onClick={() => {
                  setSeedInput(t.keyword);
                  setSort("revenue");
                }}
                title={`시드로 넣기 · 급상승 트래픽 ${t.approxTraffic?.toLocaleString() ?? "?"}`}
              >
                <span className="tk">{t.keyword}</span>
                <span className={`tb ${t.bid !== null && t.bid >= 1000 ? "hi" : ""}`}>
                  {t.bid === null ? "단가 —" : `${t.bid.toLocaleString()}원`}
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="hint">
          구글 트렌드 실시간 급상승어에 검색광고 단가를 붙여 <strong>단가 높은 순</strong>
          으로 늘어놓았습니다. 급상승어는 대부분 스포츠·연예라 단가가 바닥이니, 앞쪽에
          몇 개만 쓸 만합니다. 누르면 시드 키워드로 들어갑니다. 10분간 캐시됩니다.
        </p>
      </div>

      <div className="card">
        <h2>조회 조건</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 300 }}>
            <label>시드 키워드 (콤마 구분, 최대 5개)</label>
            <input
              placeholder="제주도 여행, 캠핑 준비물"
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && seeds.length) run();
              }}
            />
          </div>
          <div className="field">
            <label>정렬</label>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>최소 검색수</label>
            <input
              type="number"
              min={0}
              step={100}
              value={minSearches}
              style={{ width: 100 }}
              onChange={(e) => setMinSearches(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>개수</label>
            <input
              type="number"
              min={5}
              max={200}
              value={limit}
              style={{ width: 80 }}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </div>
          <button className="primary" onClick={run} disabled={loading || !seeds.length}>
            {loading && <span className="spinner" />}
            {loading ? "조회 중" : "키워드 조회"}
          </button>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={includeDocs}
              onChange={(e) => setIncludeDocs(e.target.checked)}
            />
            블로그 문서수 · 경쟁률 함께 조회
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={includeTrend}
              onChange={(e) => setIncludeTrend(e.target.checked)}
            />
            상위 5개 검색어 추세 함께 조회
          </label>
        </div>
        <p className="hint">
          문서수는 키워드 1건당 검색 API 를 1회 호출합니다 (일 한도 25,000회). 개수를 크게
          잡으면 그만큼 호출이 늘고 조회도 느려집니다.
        </p>
      </div>

      {result?.error && (
        <div className={`alert ${result.ok ? "warn" : "error"}`}>{result.error}</div>
      )}
      {trendError && <div className="alert warn">{trendError}</div>}
      {serpError && <div className="alert warn">{serpError}</div>}

      {result && result.sources.length > 0 && (
        <div className="row" style={{ marginBottom: 14, gap: 8 }}>
          {result.sources.map((s) => (
            <span
              key={s.id}
              className={`badge ${s.ok ? "on" : s.skipped ? "" : "off"}`}
              title={s.message}
            >
              {s.label} · {s.ok ? "성공" : s.skipped ? "건너뜀" : "실패"}
            </span>
          ))}
        </div>
      )}

      {result && (
        <div className="card">
          <div className="card-head">
            <h2 style={{ margin: 0 }}>
              결과 {result.keywords.length}건
              {result.seeds.length > 0 && ` · 시드 ${result.seeds.join(", ")}`}
              {restoredAt && (
                <span className="badge" style={{ marginLeft: 8 }}>
                  지난 조회 {new Date(restoredAt).toLocaleString("ko-KR")}
                </span>
              )}
            </h2>
            <div className="row" style={{ gap: 8 }}>
              {selected.length > 0 && (
                <button
                  className="primary small"
                  onClick={loadSerp}
                  disabled={serpLoading}
                  title="선택한 키워드의 네이버 블로그 검색 결과를 읽어 상위권 경쟁을 분석합니다"
                >
                  {serpLoading && <span className="spinner" />}
                  {serpLoading
                    ? `분석 중 (${selected.length}건)`
                    : `선택 ${selected.length}개 경쟁 분석`}
                </button>
              )}
              {selected.length > 0 && (
                <button
                  className="small"
                  onClick={loadTrend}
                  disabled={trendLoading}
                  title={`데이터랩은 한 번에 ${MAX_TREND}개까지만 조회됩니다`}
                >
                  {trendLoading && <span className="spinner" />}
                  추세 보기
                </button>
              )}
              <input
                placeholder="키워드 필터"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: 160 }}
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="empty">표시할 키워드가 없습니다.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }} />
                    <th style={{ width: 44 }} className="num">
                      #
                    </th>
                    <th>키워드</th>
                    <th style={{ width: 90 }} className="num">
                      월간 검색
                    </th>
                    <th
                      style={{ width: 90 }}
                      className="num"
                      title="1위 노출 예상 입찰가(모바일). 애드센스 단가의 대리 지표"
                    >
                      광고 단가
                    </th>
                    <th
                      style={{ width: 96 }}
                      className="num"
                      title="월간 검색수 × 입찰가 ÷ 1000. 비교용 지수이지 금액이 아님"
                    >
                      수익 잠재력
                    </th>
                    <th style={{ width: 78 }} className="num" title="모바일 검색 비중">
                      모바일
                    </th>
                    <th
                      style={{ width: 88 }}
                      className="num"
                      title="월평균 광고 클릭수 ÷ 월간 검색수. 검색 중 몇 %가 광고로 빠지는지"
                    >
                      광고 흡수
                    </th>
                    <th style={{ width: 72 }} title="광고 경쟁정도 / 월평균 노출 광고수">
                      광고
                    </th>
                    {hasSerp && (
                      <>
                        <th
                          style={{ width: 88 }}
                          className="num"
                          title="상위 노출 글 중 최근 30일 내 비율. 높으면 계속 새 글로 갈아치워진다"
                        >
                          최신글
                        </th>
                        <th
                          style={{ width: 88 }}
                          className="num"
                          title="상위 노출 블로그 중 네이버 인플루언서 비율"
                        >
                          인플루언서
                        </th>
                        <th
                          style={{ width: 118 }}
                          className="num"
                          title="최신글 비율과 인플루언서 비율을 절반씩 섞은 경험칙 (0~100)"
                        >
                          진입 난이도
                        </th>
                      </>
                    )}
                    <th style={{ width: 100 }} className="num">
                      문서수
                    </th>
                    <th style={{ width: 120 }} className="num">
                      경쟁률
                    </th>
                    {hasTrend && <th style={{ width: 110 }}>추세</th>}
                    <th style={{ width: 92 }} />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((k: Keyword) => {
                    const level = competitionLevel(k.competitionRatio);
                    return (
                      <tr key={k.keyword}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.includes(k.keyword)}
                            disabled={
                              !selected.includes(k.keyword) &&
                              selected.length >= MAX_SELECT
                            }
                            onChange={() => toggleSelect(k.keyword)}
                          />
                        </td>
                        <td className="num">{k.rank}</td>
                        <td className="kw-cell">
                          {k.keyword}
                          {k.isSeed && <span className="tag seed">시드</span>}
                        </td>
                        <td className="num strong" title={`PC ${num(k.pcSearches)} · 모바일 ${num(k.mobileSearches)}`}>
                          {num(k.totalSearches)}
                        </td>
                        <td className="num strong">
                          {k.bid === null ? "—" : `${k.bid.toLocaleString()}원`}
                        </td>
                        <td className="num">{num(k.revenueScore)}</td>
                        <td className="num dim">{pct(k.mobileShare)}</td>
                        <td className="num">{pct(k.adAbsorption)}</td>
                        <td className="dim">
                          {k.adCompetition ?? "—"}
                          {k.adDepth !== null && (
                            <span className="ad-depth" title="월평균 노출 광고수">
                              {k.adDepth}
                            </span>
                          )}
                        </td>
                        {hasSerp &&
                          (() => {
                            const s = k.serp;
                            const lv = difficultyLevel(s?.difficulty ?? null);
                            return (
                              <>
                                <td
                                  className="num dim"
                                  title={
                                    s?.medianAgeDays === null || s === null
                                      ? undefined
                                      : `상위권 발행일 중앙값 ${s.medianAgeDays}일 전 · ${s.results}건 분석`
                                  }
                                >
                                  {pct(s?.freshShare ?? null)}
                                </td>
                                <td className="num dim">
                                  {pct(s?.influencerShare ?? null)}
                                </td>
                                <td className="num">
                                  {s?.difficulty === undefined ||
                                  s?.difficulty === null ? (
                                    "—"
                                  ) : (
                                    <>
                                      {s.difficulty}
                                      {lv && (
                                        <span className={`grade ${lv}`}>
                                          {COMPETITION_LABEL[lv]}
                                        </span>
                                      )}
                                    </>
                                  )}
                                </td>
                              </>
                            );
                          })()}
                        <td className="num">{num(k.blogDocs)}</td>
                        <td className="num">
                          {k.competitionRatio === null ? (
                            "—"
                          ) : (
                            <>
                              {k.competitionRatio.toLocaleString()}
                              {level && (
                                <span className={`grade ${level}`}>
                                  {COMPETITION_LABEL[level]}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        {hasTrend && (
                          <td>
                            {k.trend?.length ? (
                              <span className="trend-cell">
                                <Sparkline data={k.trend} />
                                {k.trendDelta !== null && (
                                  <span
                                    className={
                                      k.trendDelta > 0
                                        ? "delta-up"
                                        : k.trendDelta < 0
                                          ? "delta-down"
                                          : "dim"
                                    }
                                  >
                                    {k.trendDelta > 0 ? "+" : ""}
                                    {k.trendDelta}%
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </td>
                        )}
                        <td>
                          {/* 열이 이미 많아 라벨 두 개를 나란히 두면 표가 더 밀린다.
                              자동 작성은 아이콘 하나로 줄이고 설명은 툴팁에 맡긴다 */}
                          <span className="cell-actions">
                            <button
                              className="small"
                              onClick={() => writeWith(k.keyword)}
                              title="이 키워드를 메인 키워드로 글 작성 화면 열기"
                            >
                              작성
                            </button>
                            <button
                              className="small icon"
                              onClick={() => writeWith(k.keyword, true)}
                              title="자동 작성 — 서브 키워드 제안부터 본문까지 한 번에 (1~2분 소요)"
                              aria-label={`${k.keyword} 자동 작성`}
                            >
                              ⚡
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!hasSerp && (
            <p className="hint">
              후보를 좁혔으면 왼쪽 체크박스로 최대 {MAX_SELECT}개까지 고르고{" "}
              <strong>경쟁 분석</strong> 을 누르세요. 각 키워드의 네이버 블로그 검색
              결과를 읽어 상위권을 누가 얼마나 단단히 잡고 있는지 알려줍니다.
            </p>
          )}

          <p className="hint">
            {hasSerp && (
              <>
                <strong>최신글</strong> = 상위 노출 글 중 최근 30일 내 비율. 높으면 계속
                새 글로 갈아치워지는 레드오션입니다. <strong>인플루언서</strong> 비율이
                높으면 일반 블로그가 밀립니다. <strong>진입 난이도</strong> 는 이 둘을
                절반씩 섞은 값입니다.{" "}
              </>
            )}
            <strong>광고 단가</strong> = 그 키워드 1위 노출에 광고주가 내는 예상 입찰가.
            네이버 값이라 애드센스 단가와 같지는 않지만, 같은 시장에서 같은 광고주가 그
            주제에 얼마를 쓰는지를 보여줘 수익성의 대리 지표가 됩니다.{" "}
            <strong>수익 잠재력</strong> = 검색수 × 단가 ÷ 1000 으로, 트래픽과 단가를 한
            축으로 묶은 비교용 지수입니다(금액 아님).{" "}
            <strong>광고 흡수</strong> = 월평균 광고 클릭수 ÷ 월간 검색수. 검색 중 몇 %가
            광고로 빠지는지를 뜻합니다. 애드센스를 단다면 이 값이 <em>높은</em> 쪽이 돈이
            도는 주제이고, 순수 유입만 원하면 낮은 쪽이 유리합니다.{" "}
            <strong>광고</strong> 열의 숫자는 월평균 노출 광고수(0~15)로, 높으면 화면을
            광고가 덮습니다. <strong>모바일</strong> 비중이 높은 키워드가 블로그 유입에
            유리합니다. <strong>경쟁률</strong> = 블로그 문서수 ÷ 월간 검색수 (문서수를
            채웠을 때만). 모두 공식 지표가 아니라 경험칙이니 같은 표 안의 상대 비교로
            쓰세요. 월간 검색수의 <span className="mono">9</span> 는 네이버가{" "}
            <span className="mono">{"< 10"}</span> 으로 가린 값입니다.
          </p>

          <details style={{ marginTop: 12 }}>
            <summary>소스별 상세 / 원본 응답 (디버그)</summary>
            <ul className="hint" style={{ paddingLeft: 18 }}>
              {result.sources.map((s) => (
                <li key={s.id}>
                  <strong>{s.label}</strong> — {s.message ?? "—"}
                </li>
              ))}
            </ul>
            <pre>{JSON.stringify(result.keywords.slice(0, 5), null, 2)}</pre>
          </details>
        </div>
      )}
    </>
  );
}
