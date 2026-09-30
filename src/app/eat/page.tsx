"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Help from "@/components/Help";
import { DeltaBadge, Sparkline } from "@/components/TrendBits";

/**
 * 제철 트렌드 — 요즘 뜨는 음식을 보고, 주변에서 파는 집을 찾는다.
 *
 * 방문 후기는 직접 간 곳만 쓰므로 이 화면의 끝은 "글 쓰기" 가 아니라 "가 보기" 다.
 *
 *   오르는 음식  →  주변 가게  →  다녀와서  →  /visit 에서 후기
 *
 * 가을이면 대하·새우가 위로 올라오고, 누르면 주변 새우집이 뜬다. 다녀온 뒤 "후기 쓰기" 를
 * 누르면 가게 이름이 채워진 채로 `/visit` 가 열린다.
 */

type Trend = {
  food: string;
  delta: number | null;
  series: { period: string; ratio: number }[];
  searches: number | null;
  /** 목록 밖에서 자동으로 찾은 음식 */
  discovered?: boolean;
};

type Discovered = { name: string; searches: number; firstSeen: string; lastSeen: string; seenCount: number };

type Place = {
  name: string;
  address: string;
  category: string;
  phone: string;
  url: string;
  distance?: number;
};

export default function EatPage() {
  const [area, setArea] = useState("");
  const [seedsText, setSeedsText] = useState("");
  const [savedArea, setSavedArea] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [discoverMsg, setDiscoverMsg] = useState("");

  const [trends, setTrends] = useState<Trend[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState("");
  /* 어떤 버튼이 돌고 있는지. 그 버튼에만 원을 돌린다 */
  const [busy, setBusy] = useState("");

  const [open, setOpen] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [placesBy, setPlacesBy] = useState("");

  useEffect(() => {
    fetch("/api/food-trend")
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return setError(d.error ?? "설정을 못 읽었습니다.");
        setArea(d.area ?? "");
        setSavedArea(d.area ?? "");
        setSeedsText((d.seeds ?? []).join(", "));
        setDiscovered(d.discovered ?? []);
        // 동네가 없으면 처음 온 것이다. 설정부터 열어 둔다
        if (!d.area) setShowSettings(true);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const run = useCallback(async () => {
    setError("");
    setBusy("trends");
    try {
      const d = await (await fetch("/api/food-trend", { method: "POST" })).json();
      if (!d.ok) throw new Error(d.error ?? "트렌드 조회에 실패했습니다.");
      setTrends(d.trends ?? []);
      setErrors(d.errors ?? []);
      if (Array.isArray(d.discovered)) setDiscovered(d.discovered);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, []);

  async function saveSettings() {
    setError("");
    setBusy("save");
    try {
      const d = await (
        await fetch("/api/food-trend", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ area, seeds: seedsText }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error ?? "저장에 실패했습니다.");
      setSavedArea(d.area ?? "");
      setSeedsText((d.seeds ?? []).join(", "));
      setShowSettings(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  /** 발견된 음식 하나를 목록에 넣거나(adopt) 뺀다(exclude) */
  async function judge(name: string, action: "adopt" | "exclude") {
    setError("");
    setBusy(`${action}:${name}`);
    try {
      const d = await (
        await fetch("/api/food-trend", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [action]: name }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error ?? "저장에 실패했습니다.");
      setSeedsText((d.seeds ?? []).join(", "));
      setDiscovered(d.discovered ?? []);
      // 빼면 오르는 순에서도 바로 지운다. 넣으면 다음 조회부터 목록 음식으로 보인다
      if (action === "exclude") setTrends((ts) => ts.filter((t) => t.food !== name));
      else setTrends((ts) => ts.map((t) => (t.food === name ? { ...t, discovered: false } : t)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function discoverNow() {
    setError("");
    setDiscoverMsg("");
    setBusy("discover");
    try {
      const d = await (await fetch("/api/food-trend/discover", { method: "POST" })).json();
      if (!d.ok) throw new Error(d.error ?? "음식 찾기에 실패했습니다.");
      setDiscoverMsg(`${d.found}개 찾음 · 새로 ${d.added}개 · 전체 ${d.total}개`);
      const g = await (await fetch("/api/food-trend")).json();
      if (g.ok) setDiscovered(g.discovered ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function findPlaces(food: string, useLocation: boolean) {
    setError("");
    setOpen(food);
    setPlaces([]);
    setBusy(`near:${food}:${useLocation ? "gps" : "area"}`);
    try {
      const q = new URLSearchParams({ food });
      if (useLocation) {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }),
        ).catch(() => {
          throw new Error("위치를 못 받았습니다. 브라우저 위치 권한을 확인하거나 동네로 찾으세요.");
        });
        q.set("x", String(pos.coords.longitude));
        q.set("y", String(pos.coords.latitude));
      }
      const d = await (await fetch(`/api/food-trend/nearby?${q}`)).json();
      if (!d.ok) throw new Error(d.error ?? "가게를 못 찾았습니다.");
      setPlaces(d.places ?? []);
      setPlacesBy(useLocation ? "내 위치 2km 안, 가까운 순" : `${d.area} 기준`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const spin = (key: string) => busy === key && <span className="spinner" />;

  return (
    <div className="main">
      <h1 className="page-title">제철 트렌드</h1>
      <p className="page-desc">
        요즘 검색이 오르는 음식을 보고 주변에서 파는 집을 찾습니다. 다녀와서 사진을 올리면
        방문 후기로 이어집니다.
      </p>

      {error && <div className="alert">{error}</div>}

      <div className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <button className="primary" onClick={run} disabled={Boolean(busy)}>
            {spin("trends")}
            {trends.length ? "다시 조회" : "지금 뜨는 음식 보기"}
          </button>
          <span className="hint" style={{ flex: 1 }}>
            {savedArea ? `동네: ${savedArea}` : "동네를 정하면 그 근처 가게를 찾습니다"}
          </span>
          <button className="ghost small" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? "설정 닫기" : "동네·음식 목록"}
          </button>
        </div>

        {showSettings && (
          <div style={{ marginTop: 12 }}>
            <div className="field">
              <label>
                동네
                <Help text="가게를 찾을 기준입니다. '신림', '관악구', '성수' 처럼 사람들이 검색할 때 쓰는 이름으로 적으세요." />
              </label>
              <input placeholder="신림" value={area} onChange={(e) => setArea(e.target.value)} />
            </div>
            <div className="field">
              <label>
                음식 목록 (쉼표 구분)
                <Help text="이 목록 안에서 요즘 오르는 것을 찾습니다. 계절 음식과 늘 찾는 음식을 섞어 두면 제철이 저절로 위로 올라옵니다. 비우면 기본 목록으로 돌아갑니다." />
              </label>
              <textarea rows={3} value={seedsText} onChange={(e) => setSeedsText(e.target.value)} />
            </div>
            <button onClick={saveSettings} disabled={Boolean(busy)}>
              {spin("save")}
              저장
            </button>

            <div className="field" style={{ marginTop: 20 }}>
              <label>
                발견된 음식
                <Help text="매일 아침 검색광고 연관 키워드에서 목록에 없는 음식을 찾아 자동으로 비교 대상에 넣습니다. 빼기를 누르면 다시 넣지 않습니다." />
              </label>
              <div className="row" style={{ alignItems: "center" }}>
                <button className="small" onClick={discoverNow} disabled={Boolean(busy)}>
                  {spin("discover")}
                  지금 찾기
                </button>
                {discoverMsg && <span className="hint">{discoverMsg}</span>}
              </div>
              {discovered.length === 0 ? (
                <p className="hint">아직 찾은 음식이 없습니다.</p>
              ) : (
                discovered.map((d) => (
                  <div key={d.name} className="list-item entry">
                    <div className="entry-main">
                      <div className="visit-line">
                        <strong className="entry-title">{d.name}</strong>
                        <span className="hint num">월 {d.searches.toLocaleString()}회</span>
                      </div>
                    </div>
                    <div className="entry-side row">
                      <button className="small" onClick={() => judge(d.name, "adopt")} disabled={Boolean(busy)}>
                        {spin(`adopt:${d.name}`)}
                        목록에 추가
                      </button>
                      <button className="small ghost" onClick={() => judge(d.name, "exclude")} disabled={Boolean(busy)}>
                        {spin(`exclude:${d.name}`)}
                        빼기
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {errors.map((e, i) => (
        <div className="alert warn" key={i}>
          {e}
        </div>
      ))}

      {trends.length > 0 && (
        <div className="card">
          <h2>
            오르는 순
            <Help text="최근 석 달을 셋으로 나눠, 마지막 한 달이 첫 한 달보다 얼마나 올랐는지입니다(네이버 데이터랩). 검색수는 한 달 기준(네이버 검색광고)입니다." />
          </h2>
          {trends.map((t) => (
            <div key={t.food}>
              <div className="list-item entry">
                <div className="entry-main">
                  <div className="visit-line">
                    <strong className="entry-title">{t.food}</strong>
                    <DeltaBadge delta={t.delta} />
                    {t.discovered && (
                      <span className="status-badge ready" title="목록 밖에서 자동으로 찾은 음식입니다">
                        새 후보
                      </span>
                    )}
                    {t.searches !== null && (
                      <span className="hint num">월 {t.searches.toLocaleString()}회</span>
                    )}
                  </div>
                </div>
                <Sparkline data={t.series} />
                <div className="entry-side row">
                  <button className="small" onClick={() => findPlaces(t.food, false)} disabled={Boolean(busy) || !savedArea}>
                    {spin(`near:${t.food}:area`)}
                    동네에서
                  </button>
                  <button className="small ghost" onClick={() => findPlaces(t.food, true)} disabled={Boolean(busy)}>
                    {spin(`near:${t.food}:gps`)}
                    내 위치
                  </button>
                </div>
              </div>

              {open === t.food && places.length > 0 && (
                <div className="card" style={{ margin: "4px 0 12px" }}>
                  <p className="hint">
                    {t.food} · {placesBy} · {places.length}곳
                  </p>
                  {places.map((p) => (
                    <div key={p.url || p.name} className="list-item entry">
                      <div className="entry-main">
                        <strong className="entry-title">{p.name}</strong>
                        <div className="entry-sub">
                          {[
                            p.category.split(">").pop()?.trim(),
                            p.address,
                            p.distance ? `${(p.distance / 1000).toFixed(1)}km` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <div className="entry-side row">
                        {p.url && (
                          <a className="link-btn" href={p.url} target="_blank" rel="noreferrer">
                            지도
                          </a>
                        )}
                        <Link
                          className="link-btn"
                          href={`/visit?place=${encodeURIComponent(`${p.name} ${p.address}`.trim())}`}
                          title="다녀온 뒤 누르세요. 가게 이름이 채워진 채로 방문 후기가 열립니다"
                        >
                          다녀왔어요
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
