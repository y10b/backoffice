"use client";

import { useEffect, useState } from "react";
import Help from "@/components/Help";
import { DeltaBadge, Sparkline } from "@/components/TrendBits";

/**
 * 상품 트렌드 — 요즘 어떤 상품이 뜨는지.
 *
 * 카테고리를 고르면 검색광고 연관 키워드에서 상품 이름을 모아, 최근 석 달 검색 추세가 오르는
 * 순으로 보여준다. 옆의 찾아보기는 그냥 검색 결과 페이지다 — 제휴 링크는 아직 붙이지 않는다
 * (쿠팡 파트너스는 최종 승인 뒤 API 로, 오늘의집·올리브영은 공유 버튼으로 직접 발급).
 */

type ShopKey = "coupang" | "ohou" | "oliveyoung" | "naver";
type Category = { key: string; label: string; shops: ShopKey[]; seeds: string[] };
type Trend = {
  food: string;
  delta: number | null;
  series: { period: string; ratio: number }[];
  searches: number | null;
  seed: boolean;
};

/** 서버의 SHOP_SEARCH 와 같은 주소. 화면에서 링크만 만들면 되니 여기 둔다 */
const SHOP: Record<ShopKey, { label: string; url: (q: string) => string }> = {
  coupang: { label: "쿠팡", url: (q) => `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}` },
  ohou: { label: "오늘의집", url: (q) => `https://ohou.se/search/index?query=${encodeURIComponent(q)}` },
  oliveyoung: {
    label: "올리브영",
    url: (q) => `https://www.oliveyoung.co.kr/store/search/getSearchMain.do?query=${encodeURIComponent(q)}`,
  },
  naver: { label: "네이버쇼핑", url: (q) => `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(q)}` },
};

export default function ProductPanel() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState("living");
  const [extra, setExtra] = useState("");
  const [trends, setTrends] = useState<Trend[]>([]);
  const [shownFor, setShownFor] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/product-trend")
      .then((r) => r.json())
      .then((d) => d.ok && setCategories(d.categories))
      .catch((e) => setError((e as Error).message));
  }, []);

  const cat = categories.find((c) => c.key === category);

  async function run() {
    setError("");
    setBusy(true);
    try {
      const d = await (
        await fetch("/api/product-trend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, extra }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error ?? "트렌드를 못 불러왔습니다.");
      setTrends(d.trends ?? []);
      setErrors(d.errors ?? []);
      setShownFor(category);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shownCat = categories.find((c) => c.key === shownFor);

  return (
    <div>

      {error && <div className="alert">{error}</div>}

      <div className="card">
        <div className="seg" style={{ marginBottom: 12 }}>
          {categories.map((c) => (
            <button key={c.key} className={category === c.key ? "on" : ""} onClick={() => setCategory(c.key)}>
              {c.label}
            </button>
          ))}
        </div>
        {cat && <p className="hint">시드: {cat.seeds.join(", ")}</p>}
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>
              더 볼 상품 (선택, 쉼표로 5개까지)
              <Help text="시드에 없는 상품군을 이번 조회에만 더합니다. 예: 전기장판, 극세사이불" />
            </label>
            <input placeholder="전기장판, 극세사이불" value={extra} onChange={(e) => setExtra(e.target.value)} />
          </div>
          <button className="primary" onClick={run} disabled={busy || !categories.length}>
            {busy && <span className="spinner" />}
            {shownFor === category && trends.length ? "다시 보기" : "뜨는 상품 보기"}
          </button>
          {busy && <span className="hint">연관 키워드를 모으고 추세를 비교하는 중… 20초쯤</span>}
        </div>
      </div>

      {errors.map((e, i) => (
        <div className="alert warn" key={i}>
          {e}
        </div>
      ))}

      {trends.length > 0 && shownCat && (
        <div className="card">
          <h2>
            {shownCat.label} · 오르는 순
            <Help text="최근 석 달을 셋으로 나눠, 마지막 한 달이 첫 한 달보다 얼마나 올랐는지입니다(네이버 검색어트렌드). 검색수는 한 달 기준(네이버 검색광고)입니다. 찾아보기는 각 쇼핑몰의 일반 검색 결과입니다." />
          </h2>
          {trends.map((t) => (
            <div key={t.food} className="list-item entry">
              <div className="entry-main">
                <div className="visit-line">
                  <strong className="entry-title">{t.food}</strong>
                  <DeltaBadge delta={t.delta} />
                  {t.searches !== null && <span className="hint num">월 {t.searches.toLocaleString()}회</span>}
                  {!t.seed && <span className="tag">발견</span>}
                </div>
              </div>
              <Sparkline data={t.series} />
              <div className="entry-side row">
                {shownCat.shops.map((s) => (
                  <a key={s} className="link-btn" href={SHOP[s].url(t.food)} target="_blank" rel="noreferrer">
                    {SHOP[s].label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
