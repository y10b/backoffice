"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * 유아 채널.
 *
 * 게임 채널과 다른 파이프라인이다. 남의 영상을 자르는 게 아니라 전부 새로 생성하므로
 * 흐름이 이렇게 된다.
 *
 *   1. 무엇이 먹히는지 본다 (제목·조회수만 — 기획 근거)
 *   2. Claude 로 기획안을 만든다 (캐릭터 고정 + 장면별 영어 프롬프트)
 *   3. 장면을 하나씩 Seedance 로 렌더한다
 *
 * 1단계 영상은 참고용일 뿐 소재가 아니다. 캐릭터는 2단계에서 새로 설계된다.
 */

type YtVideo = {
  id: string;
  title: string;
  channel: string;
  views: number | null;
  durationSec: number | null;
  publishedAt: string;
  thumbnail: string;
  url: string;
};

type Scene = {
  index: number;
  seconds: number;
  korean: string;
  videoPrompt: string;
  onScreenText: string;
};

type Plan = {
  title: string;
  description: string;
  concept: string;
  characterSheet: string;
  styleSheet: string;
  scenes: Scene[];
  tags: string[];
  safetyNotes: string[];
};

type RenderJob = {
  sceneIndex: number;
  taskId: string;
  status: string;
  videoUrl: string | null;
  error?: string;
};

const CATEGORIES = [
  { id: "", name: "전체" },
  { id: "1", name: "영화·애니메이션" },
  { id: "24", name: "엔터테인먼트" },
  { id: "27", name: "교육" },
];

const THEME_PRESETS = [
  "색깔 배우기",
  "동물 소리 따라하기",
  "숫자 세기 1~10",
  "탈것 이름 배우기",
  "과일 이름 배우기",
  "인사말 배우기",
];

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

function mmss(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function KidsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [videos, setVideos] = useState<YtVideo[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [discoverNote, setDiscoverNote] = useState("");
  const [searching, setSearching] = useState(false);

  const [theme, setTheme] = useState("");
  const [sceneCount, setSceneCount] = useState(8);
  const [secondsPerScene, setSecondsPerScene] = useState(5);
  const [notes, setNotes] = useState("");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);

  const [ratio, setRatio] = useState<"9:16" | "16:9">("9:16");
  const [resolution, setResolution] = useState<"480p" | "720p" | "1080p">("720p");
  const [jobs, setJobs] = useState<Record<number, RenderJob>>({});

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  }

  async function discover() {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try {
      const params = new URLSearchParams({ mode: "discover", q: query, months: "12" });
      if (category) params.set("category", category);
      const d = await (await fetch(`/api/kids?${params}`)).json();
      setVideos(d.videos ?? []);
      setDiscoverNote(d.note ?? "");
      if (d.error) setError(d.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const motifs = useMemo(
    () => videos.filter((v) => picked.has(v.id)).map((v) => v.title),
    [videos, picked],
  );

  async function makePlan() {
    if (!theme.trim()) {
      setError("주제를 입력하세요.");
      return;
    }
    setPlanning(true);
    setError("");
    setPlan(null);
    setJobs({});
    try {
      const d = await (
        await fetch("/api/kids", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "plan",
            theme,
            motifs,
            sceneCount,
            secondsPerScene,
            notes,
          }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error);
      setPlan(d.plan);
      flash("기획안을 만들었습니다. 안전 확인 항목을 먼저 읽어보세요.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function renderScene(scene: Scene) {
    if (!plan) return;
    setError("");
    setJobs((prev) => ({
      ...prev,
      [scene.index]: { sceneIndex: scene.index, taskId: "", status: "제출 중", videoUrl: null },
    }));
    try {
      const d = await (
        await fetch("/api/kids", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "render",
            plan,
            sceneIndex: scene.index,
            ratio,
            resolution,
          }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error);
      setJobs((prev) => ({
        ...prev,
        [scene.index]: {
          sceneIndex: scene.index,
          taskId: d.taskId,
          status: "queued",
          videoUrl: null,
        },
      }));
    } catch (e) {
      setError((e as Error).message);
      setJobs((prev) => {
        const next = { ...prev };
        delete next[scene.index];
        return next;
      });
    }
  }

  /*
   * 렌더는 30~120초 걸린다. 진행 중인 작업이 있을 때만 폴링하고, 전부 끝나면 멈춘다.
   */
  const pending = Object.values(jobs).filter(
    (j) => j.taskId && !["succeeded", "failed", "expired", "cancelled"].includes(j.status),
  );

  const pollAll = useCallback(async () => {
    for (const job of Object.values(jobs)) {
      if (!job.taskId) continue;
      if (["succeeded", "failed", "expired", "cancelled"].includes(job.status)) continue;
      try {
        const d = await (
          await fetch(`/api/kids?mode=poll&taskId=${encodeURIComponent(job.taskId)}`)
        ).json();
        if (!d.ok) continue;
        setJobs((prev) => ({
          ...prev,
          [job.sceneIndex]: {
            ...prev[job.sceneIndex],
            status: d.status,
            videoUrl: d.videoUrl,
            error: d.error,
          },
        }));
      } catch {
        /* 폴링 실패는 다음 주기에 다시 시도한다 */
      }
    }
  }, [jobs]);

  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(pollAll, 6000);
    return () => clearInterval(t);
  }, [pending.length, pollAll]);

  return (
    <>
      <h1 className="page-title">유아 채널</h1>
      <p className="page-desc">
        인기 영상에서 <strong>구성</strong>만 참고해 기획하고, 캐릭터와 화면은 전부 새로
        생성합니다. 남의 영상 파일은 쓰지 않습니다.
      </p>

      <div className="alert warn">
        <strong>유아 채널 필수 확인 2가지.</strong> ① 업로드 시{" "}
        <strong>아동용(Made for Kids)</strong> 지정이 필요하고, 그러면 유튜브가 댓글을 끄고
        개인맞춤 광고를 막아 RPM 이 크게 떨어집니다. ② 기존 캐릭터(핑크퐁·코코멜론·뽀로로 등)를
        닮게 만들면 침해입니다. 기획안의 안전 확인 항목을 반드시 읽어보세요.
      </div>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="card">
        <h2>1. 무엇이 먹히는지 보기</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>검색어</label>
            <input
              value={query}
              placeholder="예: 유아 동요, 아기 색깔놀이"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && discover()}
            />
          </div>
          <div className="field">
            <label>카테고리</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button className="primary" onClick={discover} disabled={searching || !query.trim()}>
            {searching && <span className="spinner" />}
            조회
          </button>
        </div>

        {videos.length > 0 && (
          <>
            <p className="hint">
              {discoverNote} · 구성을 참고할 영상을 고르세요 ({picked.size}개 선택). 제목만
              기획 근거로 넘어갑니다.
            </p>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 40 }} />
                  <th>제목</th>
                  <th style={{ width: 130 }}>채널</th>
                  <th style={{ width: 90 }} className="num">
                    조회수
                  </th>
                  <th style={{ width: 60 }} className="num">
                    길이
                  </th>
                </tr>
              </thead>
              <tbody>
                {videos.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.has(v.id)}
                        onChange={() => togglePick(v.id)}
                      />
                    </td>
                    <td>
                      <a href={v.url} target="_blank" rel="noopener">
                        {v.title}
                      </a>
                    </td>
                    <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{v.channel}</td>
                    <td className="num">{num(v.views)}</td>
                    <td className="num">{mmss(v.durationSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h2>2. 기획</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>주제</label>
            <input
              value={theme}
              placeholder="예: 색깔 배우기"
              onChange={(e) => setTheme(e.target.value)}
            />
          </div>
          <div className="field">
            <label>장면 수</label>
            <input
              type="number"
              min={3}
              max={20}
              value={sceneCount}
              style={{ width: 80 }}
              onChange={(e) => setSceneCount(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>장면당 초</label>
            <input
              type="number"
              min={4}
              max={15}
              value={secondsPerScene}
              style={{ width: 80 }}
              onChange={(e) => setSecondsPerScene(Number(e.target.value))}
            />
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          {THEME_PRESETS.map((t) => (
            <button
              key={t}
              className="small ghost"
              style={{ marginRight: 5, marginBottom: 5 }}
              onClick={() => setTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="field" style={{ marginTop: 10 }}>
          <label>추가 지시 (선택)</label>
          <textarea
            rows={2}
            value={notes}
            placeholder="꼭 넣을 요소, 피할 요소 등"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <p className="hint">
          Seedance 는 장면당 4~15초입니다. 장면당 초를 그 범위로 맞추세요. 총 길이는{" "}
          {sceneCount * secondsPerScene}초.
        </p>

        <button
          className="primary"
          style={{ marginTop: 10 }}
          onClick={makePlan}
          disabled={planning || !theme.trim()}
        >
          {planning && <span className="spinner" />}
          {planning ? "기획 중… (1분 내외)" : "기획안 생성"}
        </button>
      </div>

      {plan && (
        <>
          <div className="card">
            <h2>기획안</h2>
            <div className="field">
              <label>제목</label>
              <input value={plan.title} readOnly />
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              <strong>컨셉</strong> · {plan.concept}
            </p>

            <div className="field" style={{ marginTop: 10 }}>
              <label>캐릭터 고정 묘사 — 매 장면 프롬프트 앞에 자동으로 붙습니다</label>
              <textarea className="mono" rows={3} value={plan.characterSheet} readOnly />
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>화풍</label>
              <textarea className="mono" rows={2} value={plan.styleSheet} readOnly />
            </div>

            <div style={{ marginTop: 12 }}>
              {plan.tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
            </div>

            {plan.safetyNotes.length > 0 && (
              <div className="alert warn" style={{ marginTop: 14 }}>
                <strong>사람이 확인할 항목</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {plan.safetyNotes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="card">
            <h2>3. 장면 렌더</h2>
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="field">
                <label>화면비</label>
                <select value={ratio} onChange={(e) => setRatio(e.target.value as "9:16")}>
                  <option value="9:16">9:16 (쇼츠)</option>
                  <option value="16:9">16:9 (일반)</option>
                </select>
              </div>
              <div className="field">
                <label>해상도</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value as "720p")}
                >
                  <option value="480p">480p (저렴)</option>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </div>
              {pending.length > 0 && (
                <span className="badge on" style={{ alignSelf: "center" }}>
                  <span className="spinner" />
                  {pending.length}개 렌더 중
                </span>
              )}
            </div>

            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }} className="num">
                    #
                  </th>
                  <th style={{ width: 200 }}>한국어 (자막/가사)</th>
                  <th>장면 프롬프트 (영문)</th>
                  <th style={{ width: 130 }}>상태</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {plan.scenes.map((s) => {
                  const job = jobs[s.index];
                  return (
                    <tr key={s.index}>
                      <td className="num">{s.index}</td>
                      <td>
                        {s.korean}
                        {s.onScreenText && (
                          <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>
                            자막 강조: {s.onScreenText}
                          </div>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {s.videoPrompt}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {!job && <span className="dim">—</span>}
                        {job?.status === "succeeded" && job.videoUrl && (
                          <a href={job.videoUrl} target="_blank" rel="noopener">
                            영상 열기
                          </a>
                        )}
                        {job && job.status !== "succeeded" && (
                          <span className={job.error ? "delta-down" : ""}>
                            {job.error ?? job.status}
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          className="small"
                          onClick={() => renderScene(s)}
                          disabled={Boolean(
                            job && !["failed", "expired", "cancelled"].includes(job.status),
                          )}
                        >
                          {job?.status === "succeeded" ? "완료" : "렌더"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p className="hint">
              장면당 30~120초 걸립니다. 완성 영상 URL 은 24시간 뒤 만료되니 받아두세요.
              장면들을 이어붙이고 자막을 얹는 건 쇼츠 화면의 렌더 워커를 쓰거나 편집기에서
              하시면 됩니다.
            </p>
          </div>
        </>
      )}
    </>
  );
}
