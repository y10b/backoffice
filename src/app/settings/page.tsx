"use client";

import { useCallback, useEffect, useState } from "react";

type SettingsState = {
  naverCookieSet: boolean;
  naverCookieValid: boolean;
  naverCookiePreview: string;
  geminiKeySet: boolean;
  geminiKeyFromEnv: boolean;
  geminiKeyPreview: string;
  geminiModel: string;
  presets: { id: string; label: string; path: string; query: Record<string, string> }[];
};

export default function SettingsPage() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [cookie, setCookie] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gemini-2.5-pro");
  const [presetsJson, setPresetsJson] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s: SettingsState) => {
        setState(s);
        setModel(s.geminiModel);
        setPresetsJson(JSON.stringify(s.presets, null, 2));
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

  return (
    <>
      <h1 className="page-title">설정</h1>
      <p className="page-desc">
        인증 정보는 이 컴퓨터의 <span className="mono">data/backoffice.db</span> 에만
        저장됩니다.
      </p>

      {notice && <div className="alert ok">{notice}</div>}
      {error && <div className="alert warn" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}

      <div className="card">
        <h2>
          네이버 쿠키{" "}
          {state && (
            <span className={`badge ${state.naverCookieValid ? "on" : ""}`}>
              {state.naverCookieValid
                ? `등록됨 ${state.naverCookiePreview}`
                : state.naverCookieSet
                  ? "등록됨 (NID_AUT/NID_SES 미확인)"
                  : "미등록"}
            </span>
          )}
        </h2>
        <ol className="hint" style={{ paddingLeft: 18, margin: "0 0 12px" }}>
          <li>
            크롬에서 <span className="mono">creator-advisor.naver.com</span> 에 로그인
          </li>
          <li>개발자도구(⌥⌘I) → Network 탭 → 아무 통계 요청 클릭</li>
          <li>
            Headers → Request Headers → <span className="mono">cookie</span> 값 전체 복사
          </li>
          <li>아래에 붙여넣고 저장. 만료되면 401 이 뜨니 그때 다시 붙여넣으면 됩니다.</li>
        </ol>
        <textarea
          className="mono"
          rows={4}
          style={{ width: "100%" }}
          placeholder="NID_AUT=...; NID_SES=...; NNB=..."
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            onClick={() => save({ naverCookie: cookie }).then(() => setCookie(""))}
            disabled={!cookie.trim()}
          >
            쿠키 저장
          </button>
          <button className="ghost" onClick={() => save({ clearNaverCookie: true })}>
            삭제
          </button>
        </div>
      </div>

      <div className="card">
        <h2>
          Gemini API{" "}
          {state && (
            <span className={`badge ${state.geminiKeySet ? "on" : ""}`}>
              {state.geminiKeyFromEnv
                ? "환경변수 사용 중"
                : state.geminiKeySet
                  ? `등록됨 ${state.geminiKeyPreview}`
                  : "미등록"}
            </span>
          )}
        </h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>API 키 (aistudio.google.com/apikey)</label>
            <input
              type="password"
              className="mono"
              placeholder="AIza..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
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

      <div className="card">
        <h2>엔드포인트 프리셋</h2>
        <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          크리에이터 어드바이저는 비공개 API 라 경로가 바뀔 수 있습니다. 404 가 뜨면
          DevTools 에서 실제 요청 URL 을 확인해 아래 JSON 을 고치세요.{" "}
          <span className="mono">{"{{date}}"}</span>,{" "}
          <span className="mono">{"{{dateStart}}"}</span>,{" "}
          <span className="mono">{"{{dateEnd}}"}</span>,{" "}
          <span className="mono">{"{{categoryId}}"}</span>,{" "}
          <span className="mono">{"{{limit}}"}</span> 이 치환됩니다.
        </p>
        <textarea
          className="mono"
          rows={18}
          style={{ width: "100%" }}
          value={presetsJson}
          onChange={(e) => setPresetsJson(e.target.value)}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            onClick={() => {
              try {
                const parsed = JSON.parse(presetsJson);
                if (!Array.isArray(parsed)) throw new Error("배열이어야 합니다.");
                save({ presets: parsed });
              } catch (e) {
                setError(`JSON 오류: ${(e as Error).message}`);
              }
            }}
          >
            프리셋 저장
          </button>
          <button className="ghost" onClick={() => save({ resetPresets: true })}>
            기본값으로 되돌리기
          </button>
        </div>
      </div>
    </>
  );
}
