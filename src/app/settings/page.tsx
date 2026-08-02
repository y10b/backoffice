"use client";

import { useCallback, useEffect, useState } from "react";

type SettingsState = {
  searchAd: {
    configured: boolean;
    fromEnv: boolean;
    apiKeyPreview: string;
    secretKeySet: boolean;
    customerId: string;
  };
  openApi: {
    configured: boolean;
    fromEnv: boolean;
    clientIdPreview: string;
    clientSecretSet: boolean;
  };
  gemini: {
    configured: boolean;
    fromEnv: boolean;
    apiKeyPreview: string;
    /** 설정값과 환경변수를 합쳐 실제로 쓸 수 있는 키 개수 */
    keyCount: number;
    model: string;
  };
  ga4: {
    configured: boolean;
    fromEnv: boolean;
    clientEmail: string;
    propertyId: string;
    keyValid: boolean;
  };
  adsense: {
    configured: boolean;
    fromEnv: boolean;
    clientIdPreview: string;
    connected: boolean;
    account: string;
  };
};

/** 애드센스 OAuth 클라이언트에 이 URI 를 그대로 등록해야 한다 */
const OAUTH_REDIRECT = "http://localhost:3939/api/oauth/callback";

type TestState = Record<string, { ok: boolean; message: string } | "loading">;

function Status({
  configured,
  fromEnv,
  preview,
}: {
  configured: boolean;
  fromEnv: boolean;
  preview?: string;
}) {
  return (
    <span className={`badge ${configured ? "on" : ""}`}>
      {!configured
        ? "미등록"
        : fromEnv
          ? "환경변수 사용 중"
          : `등록됨${preview ? ` ${preview}` : ""}`}
    </span>
  );
}

export default function SettingsPage() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [adKey, setAdKey] = useState("");
  const [adSecret, setAdSecret] = useState("");
  const [adCustomer, setAdCustomer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gemini-2.5-pro");
  const [ga4Json, setGa4Json] = useState("");
  const [ga4Property, setGa4Property] = useState("");
  const [adsenseId, setAdsenseId] = useState("");
  const [adsenseSecret, setAdsenseSecret] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tests, setTests] = useState<TestState>({});

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s: SettingsState) => {
        setState(s);
        setModel(s.gemini.model);
        setAdCustomer((prev) => prev || s.searchAd.customerId);
      });
  }, []);

  useEffect(load, [load]);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  }

  async function save(payload: Record<string, unknown>) {
    setError("");
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (d.warnings?.length) setError(d.warnings.join("\n"));
    else flash("저장했습니다.");
    load();
  }

  async function test(target: string) {
    setTests((t) => ({ ...t, [target]: "loading" }));
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const d = await res.json();
      setTests((t) => ({ ...t, [target]: { ok: d.ok, message: d.message } }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [target]: { ok: false, message: (e as Error).message },
      }));
    }
  }

  function TestButton({ target }: { target: string }) {
    const r = tests[target];
    return (
      <>
        <button className="ghost" onClick={() => test(target)} disabled={r === "loading"}>
          {r === "loading" && <span className="spinner" />}
          연결 테스트
        </button>
        {r && r !== "loading" && (
          <span className={`test-result ${r.ok ? "ok" : "fail"}`}>{r.message}</span>
        )}
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">설정</h1>
      <p className="page-desc">
        전부 네이버 공식 API 자격증명입니다. 이 컴퓨터의{" "}
        <span className="mono">data/backoffice.db</span> 에만 저장됩니다.
      </p>

      {notice && <div className="alert ok">{notice}</div>}
      {error && (
        <div className="alert warn" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}

      <div className="card">
        <h2>
          네이버 검색광고 API{" "}
          {state && (
            <Status
              configured={state.searchAd.configured}
              fromEnv={state.searchAd.fromEnv}
              preview={state.searchAd.apiKeyPreview}
            />
          )}
        </h2>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          연관 키워드와 월간 검색수(PC/모바일)를 가져오는 핵심 소스입니다.{" "}
          <a href="https://searchad.naver.com" target="_blank" rel="noreferrer">
            searchad.naver.com
          </a>{" "}
          로그인 → 우측 상단 <strong>도구 → API 사용 관리</strong> → 액세스라이선스와
          비밀키를 발급하세요. CUSTOMER_ID 는 같은 화면에 표시되는 숫자입니다. 광고를
          집행하지 않아도 발급됩니다.
        </p>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>액세스라이선스 (API 키)</label>
            <input
              type="password"
              className="mono"
              placeholder="0100000000..."
              value={adKey}
              onChange={(e) => setAdKey(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>비밀키</label>
            <input
              type="password"
              className="mono"
              placeholder="AQAAAAA..."
              value={adSecret}
              onChange={(e) => setAdSecret(e.target.value)}
            />
          </div>
          <div className="field">
            <label>CUSTOMER_ID</label>
            <input
              className="mono"
              placeholder="1234567"
              style={{ width: 130 }}
              value={adCustomer}
              onChange={(e) => setAdCustomer(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            onClick={() =>
              save({
                searchAdApiKey: adKey,
                searchAdSecretKey: adSecret,
                searchAdCustomerId: adCustomer,
              }).then(() => {
                setAdKey("");
                setAdSecret("");
              })
            }
            disabled={!adKey.trim() && !adSecret.trim() && !adCustomer.trim()}
          >
            저장
          </button>
          <TestButton target="searchad" />
          <button className="ghost" onClick={() => save({ clearSearchAd: true })}>
            삭제
          </button>
        </div>
        {state?.searchAd.configured === false && state.searchAd.secretKeySet && (
          <p className="hint">비밀키는 저장돼 있지만 다른 값이 비어 있습니다.</p>
        )}
      </div>

      <div className="card">
        <h2>
          네이버 개발자센터 (검색 API · 데이터랩){" "}
          {state && (
            <Status
              configured={state.openApi.configured}
              fromEnv={state.openApi.fromEnv}
              preview={state.openApi.clientIdPreview}
            />
          )}
        </h2>
        <div className="alert warn" style={{ marginTop: 0 }}>
          <strong>현재 신규 발급이 막혀 있습니다.</strong> 앱을 새로 등록해도 사용 API
          목록에 <span className="mono">검색</span>·
          <span className="mono">데이터랩</span> 이 없어, 호출하면{" "}
          <span className="mono">401 Scope Status Invalid</span> 가 돌아옵니다. 기존에
          승인된 키가 있을 때만 채우세요. 없으면 비워두면 되고, 키워드 탐색은 검색광고
          지표만으로 동작합니다.
        </div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          블로그 문서수(경쟁률 계산)와 검색어 트렌드에 씁니다. 하나의 Client ID/Secret 을
          둘이 같이 씁니다. 발급처는{" "}
          <a
            href="https://developers.naver.com/apps/#/register"
            target="_blank"
            rel="noreferrer"
          >
            developers.naver.com
          </a>{" "}
          입니다.
        </p>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>Client ID</label>
            <input
              className="mono"
              placeholder="abcdEFGH..."
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>Client Secret</label>
            <input
              type="password"
              className="mono"
              placeholder="••••••••"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            onClick={() =>
              save({
                naverClientId: clientId,
                naverClientSecret: clientSecret,
              }).then(() => {
                setClientId("");
                setClientSecret("");
              })
            }
            disabled={!clientId.trim() && !clientSecret.trim()}
          >
            저장
          </button>
          <TestButton target="search" />
          <TestButton target="datalab" />
          <button className="ghost" onClick={() => save({ clearOpenApi: true })}>
            삭제
          </button>
        </div>
      </div>

      <div className="card">
        <h2>
          GA4 (블로그 조회수){" "}
          {state && (
            <Status
              configured={state.ga4.configured}
              fromEnv={state.ga4.fromEnv}
              preview={state.ga4.propertyId && `속성 ${state.ga4.propertyId}`}
            />
          )}
        </h2>
        {state?.ga4.clientEmail && (
          <p className="hint" style={{ marginTop: 0 }}>
            서비스 계정: <span className="mono">{state.ga4.clientEmail}</span>
            <br />이 이메일이 <strong>GA4 → 관리 → 속성 액세스 관리</strong>에 뷰어로
            추가되어 있어야 조회됩니다. (계정 액세스가 아니라 <strong>속성</strong> 액세스)
          </p>
        )}
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 280 }}>
            <label>서비스 계정 JSON (파일 내용 전체)</label>
            <textarea
              className="mono"
              rows={4}
              placeholder='{"type":"service_account","project_id":"...","client_email":"...","private_key":"-----BEGIN PRIVATE KEY-----..."}'
              value={ga4Json}
              onChange={(e) => setGa4Json(e.target.value)}
            />
          </div>
          <div className="field">
            <label>속성 ID (숫자)</label>
            <input
              className="mono"
              placeholder="123456789"
              style={{ width: 130 }}
              value={ga4Property}
              onChange={(e) => setGa4Property(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            onClick={() =>
              save({ ga4ServiceAccount: ga4Json, ga4PropertyId: ga4Property }).then(() =>
                setGa4Json(""),
              )
            }
            disabled={!ga4Json.trim() && !ga4Property.trim()}
          >
            저장
          </button>
          <TestButton target="ga4" />
          <button className="ghost" onClick={() => save({ clearGa4: true })}>
            삭제
          </button>
        </div>
        <p className="hint">
          속성 ID 는 측정 ID(<span className="mono">G-XXXXXXX</span>)가 아니라 관리 → 속성
          설정에 있는 숫자입니다.
        </p>
      </div>

      <div className="card">
        <h2>
          애드센스 (수익){" "}
          {state && (
            <span className={`badge ${state.adsense.connected ? "on" : ""}`}>
              {state.adsense.connected
                ? `연결됨${state.adsense.account ? ` ${state.adsense.account}` : ""}`
                : state.adsense.configured
                  ? "자격증명만 등록됨 — 연결 필요"
                  : "미등록"}
            </span>
          )}
        </h2>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          애드센스는 서비스 계정을 지원하지 않아 <strong>사용자 동의</strong>가 필요합니다.
          GCP → 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션)를 만들고, 승인된
          리디렉션 URI 에 <span className="mono">{OAUTH_REDIRECT}</span> 를 정확히 그대로
          등록하세요.
        </p>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>클라이언트 ID</label>
            <input
              className="mono"
              placeholder="....apps.googleusercontent.com"
              value={adsenseId}
              onChange={(e) => setAdsenseId(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>클라이언트 보안 비밀번호</label>
            <input
              type="password"
              className="mono"
              placeholder="GOCSPX-..."
              value={adsenseSecret}
              onChange={(e) => setAdsenseSecret(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            onClick={() =>
              save({
                adsenseClientId: adsenseId,
                adsenseClientSecret: adsenseSecret,
              }).then(() => setAdsenseSecret(""))
            }
            disabled={!adsenseId.trim() && !adsenseSecret.trim()}
          >
            저장
          </button>
          <button
            className="tistory"
            onClick={() => {
              window.location.href = "/api/oauth/adsense";
            }}
            disabled={!state?.adsense.configured}
            title={
              state?.adsense.configured
                ? "구글 동의 화면으로 이동합니다"
                : "먼저 클라이언트 ID/시크릿을 저장하세요"
            }
          >
            {state?.adsense.connected ? "다시 연결" : "애드센스 연결"}
          </button>
          <button className="ghost" onClick={() => save({ clearAdsense: true })}>
            연결 해제
          </button>
        </div>
      </div>

      <div className="card">
        <h2>
          Gemini API{" "}
          {state && (
            <Status
              configured={state.gemini.configured}
              fromEnv={state.gemini.fromEnv}
              preview={state.gemini.apiKeyPreview}
            />
          )}
        </h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>
              API 키 (aistudio.google.com/apikey)
              {state && state.gemini.keyCount > 1 && (
                <> — 현재 {state.gemini.keyCount}개 등록됨</>
              )}
            </label>
            <textarea
              className="mono"
              rows={3}
              placeholder={"AIza...\nAIza...  ← 한 줄에 하나씩, 여러 개 넣을 수 있습니다"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="hint" style={{ marginTop: 6 }}>
              무료 티어는 프로젝트당 요청 수가 정해져 있어 글 몇 개만 써도 429 가 납니다.
              키를 여러 개 넣으면 쿼터에 걸린 키를 건너뛰고 다음 키로 넘어갑니다.
              저장하면 기존 목록을 덮어쓰므로 쓰던 키도 함께 넣으세요.
            </p>
          </div>
          <div className="field">
            <label>모델</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="gemini-2.5-pro">gemini-2.5-pro (품질)</option>
              <option value="gemini-2.5-flash">gemini-2.5-flash (속도·저비용)</option>
              <option value="gemini-2.0-flash">gemini-2.0-flash</option>
            </select>
          </div>
          <button
            className="primary"
            onClick={() =>
              save({ geminiApiKey: apiKey, geminiModel: model }).then(() => setApiKey(""))
            }
          >
            저장
          </button>
        </div>
      </div>
    </>
  );
}
