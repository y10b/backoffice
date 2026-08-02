"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BLOG_CATEGORIES } from "@/lib/categories";

type Keyword = {
  keyword: string;
  rank: number | null;
  metric: number | null;
  rankDelta: number | null;
  raw: Record<string, unknown>;
};

type FetchResult = {
  ok: boolean;
  status: number;
  requestUrl: string;
  keywords: Keyword[];
  raw: unknown;
  error?: string;
};

type Preset = { id: string; label: string };

function yesterdayKst(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

export default function KeywordsPage() {
  const router = useRouter();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState("");
  const [categoryId, setCategoryId] = useState("30");
  const [date, setDate] = useState(yesterdayKst());
  const [limit, setLimit] = useState(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FetchResult | null>(null);
  const [curl, setCurl] = useState("");
  const [cookieReady, setCookieReady] = useState<boolean | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setPresets(s.presets ?? []);
        setPresetId((prev) => prev || s.presets?.[0]?.id || "");
        setCookieReady(Boolean(s.naverCookieSet));
      })
      .catch(() => setCookieReady(false));
  }, []);

  const categoryName = useMemo(
    () => BLOG_CATEGORIES.find((c) => c.id === categoryId)?.name ?? "",
    [categoryId],
  );

  async function run(useCurl: boolean) {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/keywords", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          useCurl
            ? { curl, label: "cURL" }
            : { presetId, categoryId, date, limit, label: categoryName },
        ),
      });
      setResult(await res.json());
    } catch (e) {
      setResult({
        ok: false,
        status: 0,
        requestUrl: "",
        keywords: [],
        raw: null,
        error: (e as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }

  const visible = useMemo(() => {
    const list = result?.keywords ?? [];
    if (!filter.trim()) return list;
    const q = filter.trim().toLowerCase();
    return list.filter((k) => k.keyword.toLowerCase().includes(q));
  }, [result, filter]);

  function writeWith(keyword: string) {
    const context = (result?.keywords ?? [])
      .map((k) => k.keyword)
      .filter((k) => k && k !== keyword)
      .slice(0, 40);
    const params = new URLSearchParams({ main: keyword });
    if (context.length) params.set("context", context.join("|"));
    router.push(`/write?${params.toString()}`);
  }

  return (
    <>
      <h1 className="page-title">키워드 탐색</h1>
      <p className="page-desc">
        크리에이터 어드바이저에서 주제별 인기 키워드를 가져옵니다. 마음에 드는 키워드의
        <strong> 작성 </strong>버튼을 누르면 메인 키워드로 넘어갑니다.
      </p>

      {cookieReady === false && (
        <div className="alert warn">
          네이버 쿠키가 아직 등록되지 않았습니다. <a href="/settings">설정</a>에서 먼저
          등록하세요.
        </div>
      )}

      <div className="card">
        <h2>조회 조건</h2>
        <div className="row">
          <div className="field">
            <label>엔드포인트</label>
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>주제</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {BLOG_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>기준일</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>개수</label>
            <input
              type="number"
              min={5}
              max={100}
              value={limit}
              style={{ width: 80 }}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </div>
          <button className="primary" onClick={() => run(false)} disabled={loading}>
            {loading && <span className="spinner" />}
            {loading ? "조회 중" : "키워드 조회"}
          </button>
        </div>
        <p className="hint">
          네이버 통계는 KST 기준이고 당일 집계는 비어 있는 경우가 많아 기본값을 어제로
          둡니다.
        </p>
      </div>

      <details style={{ marginBottom: 18 }}>
        <summary>기본 엔드포인트가 안 맞나요? DevTools cURL 붙여넣기</summary>
        <p className="hint" style={{ marginTop: 10 }}>
          creator-advisor.naver.com 접속 → 개발자도구 Network 탭 → 원하는 데이터를 부르는
          요청 우클릭 → Copy as cURL → 아래에 붙여넣기. URL만 사용하고 인증은 저장된 쿠키를
          씁니다.
        </p>
        <textarea
          className="mono"
          rows={5}
          style={{ width: "100%", marginTop: 8 }}
          placeholder="curl 'https://creator-advisor.naver.com/api/v6/...' -H 'cookie: ...'"
          value={curl}
          onChange={(e) => setCurl(e.target.value)}
        />
        <button
          className="small"
          style={{ marginTop: 8 }}
          onClick={() => run(true)}
          disabled={loading || !curl.trim()}
        >
          이 URL 로 조회
        </button>
      </details>

      {result?.error && (
        <div className={`alert ${result.ok ? "warn" : "error"}`}>{result.error}</div>
      )}

      {result && (
        <div className="card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <h2 style={{ margin: 0 }}>
              결과 {result.keywords.length}건 {categoryName && `· ${categoryName}`}
            </h2>
            <input
              placeholder="키워드 필터"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 180 }}
            />
          </div>

          {visible.length === 0 ? (
            <div className="empty">표시할 키워드가 없습니다.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 50 }} className="num">
                    순위
                  </th>
                  <th>키워드</th>
                  <th style={{ width: 100 }} className="num">
                    지표
                  </th>
                  <th style={{ width: 70 }} className="num">
                    변동
                  </th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {visible.map((k, i) => (
                  <tr key={`${k.keyword}-${i}`}>
                    <td className="num">{k.rank ?? i + 1}</td>
                    <td className="kw-cell">{k.keyword}</td>
                    <td className="num">
                      {k.metric === null ? "—" : k.metric.toLocaleString()}
                    </td>
                    <td
                      className={`num ${
                        k.rankDelta === null
                          ? ""
                          : k.rankDelta > 0
                            ? "delta-up"
                            : k.rankDelta < 0
                              ? "delta-down"
                              : ""
                      }`}
                    >
                      {k.rankDelta === null
                        ? "—"
                        : k.rankDelta > 0
                          ? `▲${k.rankDelta}`
                          : k.rankDelta < 0
                            ? `▼${Math.abs(k.rankDelta)}`
                            : "—"}
                    </td>
                    <td>
                      <button className="small" onClick={() => writeWith(k.keyword)}>
                        작성
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <details style={{ marginTop: 14 }}>
            <summary>원본 응답 / 요청 URL (디버그)</summary>
            <p className="mono" style={{ wordBreak: "break-all", marginTop: 8 }}>
              {result.requestUrl}
            </p>
            <pre>{JSON.stringify(result.raw, null, 2)}</pre>
          </details>
        </div>
      )}
    </>
  );
}
