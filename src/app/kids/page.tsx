"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { copyText } from "@/lib/clipboard";
import Help from "@/components/Help";

/**
 * 유아 채널.
 *
 * 게임 채널과 다른 파이프라인이다. 남의 영상을 자르는 게 아니라 전부 새로 생성하므로
 * 흐름이 이렇게 된다.
 *
 *   1. 무엇이 먹히는지 본다 (제목·조회수만 — 기획 근거)
 *   2. Claude 로 기획안을 만든다 (캐릭터 고정 + 장면별 영어 프롬프트)
 *   3. 장면을 하나씩 Veo 로 렌더한다 (또는 Flow 웹에서 만들어 업로드)
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
  /** 참고 영상에서 읽어낸 구성 */
  analysis: string;
  theme: string;
  title: string;
  description: string;
  concept: string;
  characterSheet: string;
  styleSheet: string;
  scenes: Scene[];
  tags: string[];
  safetyNotes: string[];
  /** 이번 기획에 쓴 토큰과 정가 기준 값. 예전 기획안에는 없어 선택 필드다 */
  usage?: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
};

type SourceFile = { name: string; originalName: string; sizeBytes: number; path: string };

type RenderJob = {
  sceneIndex: number;
  /** Veo 롱러닝 오퍼레이션 이름 */
  operation: string;
  status: string;
  videoUri: string | null;
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
  /* 분석할 참고 영상 하나. 체크박스 여러 개 대신 행 클릭으로 고른다 */
  const [source, setSource] = useState<YtVideo | null>(null);
  const [discoverNote, setDiscoverNote] = useState("");
  const [searching, setSearching] = useState(false);

  const [theme, setTheme] = useState("");
  const [sceneCount, setSceneCount] = useState(8);
  const [secondsPerScene, setSecondsPerScene] = useState(5);
  const [notes, setNotes] = useState("");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);

  const [ratio, setRatio] = useState<"9:16" | "16:9">("9:16");
  const [resolution, setResolution] = useState<"720p" | "1080p">("720p");
  /* 장면별 내레이션 음성 (Fish Audio). 재생 중인 것만 들고 있는다 */
  const [ttsBusy, setTtsBusy] = useState<number | null>(null);
  const [audio, setAudio] = useState<Record<number, string>>({});
  const [jobs, setJobs] = useState<Record<number, RenderJob>>({});

  /* 조립: Flow 에서 만들어 받은 클립들 */
  const [clips, setClips] = useState<SourceFile[]>([]);
  /* 아래 여백에 얹을 댓글. 본문이 비면 보내지 않는다 */
  const [commentAuthor, setCommentAuthor] = useState("");
  const [commentText, setCommentText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [narration, setNarration] = useState<SourceFile | null>(null);
  const [makingNarration, setMakingNarration] = useState(false);
  const [withTitle, setWithTitle] = useState(true);
  const [assembling, setAssembling] = useState(false);
  const [assembleJob, setAssembleJob] = useState<number | null>(null);

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

  /** 목록의 나머지 제목들. 같은 장르에서 무엇이 먹히는지 함께 넘긴다 */
  const motifs = useMemo(
    () => videos.filter((v) => v.id !== source?.id).map((v) => v.title).slice(0, 20),
    [videos, source],
  );

  /**
   * 참고 영상을 골라 바로 기획까지 간다.
   *
   * 영상을 고르는 것과 기획을 시작하는 것을 따로 누르게 하면 한 번 더 손이 간다.
   * 행을 누르면 그 영상을 분석해 주제까지 모델이 정한다.
   */
  async function analyzeAndPlan(v: YtVideo) {
    setSource(v);
    await makePlan(v);
  }

  async function makePlan(sourceVideo?: YtVideo | null) {
    const src = sourceVideo ?? source;
    if (!theme.trim() && !src) {
      setError("주제를 입력하거나 위에서 참고 영상을 고르세요.");
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
            sourceVideoId: src?.id,
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
      [scene.index]: { sceneIndex: scene.index, operation: "", status: "제출 중", videoUri: null },
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
            aspectRatio: ratio,
            resolution,
          }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error);
      setJobs((prev) => ({
        ...prev,
        [scene.index]: {
          sceneIndex: scene.index,
          operation: d.operation,
          status: "생성 중",
          videoUri: null,
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

  /**
   * 장면 내레이션 음성. Fish Audio 는 오디오 바이트를 그대로 주므로 blob URL 로 재생한다.
   * 무료 등급(s2.1-pro-free)에서도 같은 모델이 돌아간다.
   */
  async function speak(scene: Scene) {
    setTtsBusy(scene.index);
    setError("");
    try {
      const res = await fetch("/api/kids", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "tts", text: scene.korean }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `음성 생성에 실패했습니다 (HTTP ${res.status}).`);
      }
      const url = URL.createObjectURL(await res.blob());
      setAudio((prev) => {
        // 같은 장면을 다시 만들면 이전 blob 을 놓아준다. 안 그러면 메모리에 쌓인다
        if (prev[scene.index]) URL.revokeObjectURL(prev[scene.index]);
        return { ...prev, [scene.index]: url };
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTtsBusy(null);
    }
  }

  /**
   * Flow 에서 만들어 받은 클립들을 한 번에 올린다.
   *
   * 파일명 순으로 정렬해 저장하므로, Flow 에서 받을 때 장면 번호가 이름에 들어가면
   * 그대로 순서가 맞는다. 순서가 틀리면 아래 목록에서 확인하고 다시 올리면 된다.
   */
  async function uploadClips(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      form.append("origin", `자체 생성 (Google Flow) · ${plan?.title ?? "유아 채널"}`);
      form.append("license", "자체 생성물");
      const d = await (
        await fetch("/api/shorts/sources", { method: "POST", body: form })
      ).json();
      if (!d.ok) throw new Error(d.error);
      setClips((prev) => [...prev, ...(d.sources ?? [])]);
      if (d.failed?.length) {
        setError(
          `${d.failed.length}개는 올리지 못했습니다: ${d.failed.map((f: any) => f.name).join(", ")}`,
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  /** 장면 대사를 한 번에 읽혀 파일로 저장한다. 조립에서 오디오 트랙이 된다 */
  async function makeNarration() {
    if (!plan) return;
    setMakingNarration(true);
    setError("");
    try {
      const d = await (
        await fetch("/api/kids", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "narration", plan }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error);
      setNarration(d.source);
      flash("내레이션을 만들었습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMakingNarration(false);
    }
  }

  /** 조립을 큐에 넣는다. ffmpeg 는 로컬 워커가 돌린다 */
  async function assemble() {
    if (!clips.length) {
      setError("클립을 먼저 올리세요.");
      return;
    }
    setAssembling(true);
    setError("");
    try {
      const d = await (
        await fetch("/api/kids", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "assemble",
            plan,
            clips: clips.map((c) => c.path),
            comment: commentText.trim()
              ? { author: commentAuthor.trim() || "시청자", text: commentText.trim() }
              : undefined,
            narration: narration?.path,
            withTitle,
          }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error);
      setAssembleJob(d.jobId);
      flash(`조립 작업 #${d.jobId} 을 등록했습니다. 로컬 워커가 처리합니다.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAssembling(false);
    }
  }

  /*
   * 렌더는 30~120초 걸린다. 진행 중인 작업이 있을 때만 폴링하고, 전부 끝나면 멈춘다.
   */
  const DONE = ["완료", "실패"];
  const pending = Object.values(jobs).filter(
    (j) => j.operation && !DONE.includes(j.status),
  );

  const pollAll = useCallback(async () => {
    for (const job of Object.values(jobs)) {
      if (!job.operation || DONE.includes(job.status)) continue;
      try {
        const d = await (
          await fetch(`/api/kids?mode=poll&operation=${encodeURIComponent(job.operation)}`)
        ).json();
        if (!d.ok) continue;
        setJobs((prev) => ({
          ...prev,
          [job.sceneIndex]: {
            ...prev[job.sceneIndex],
            // Veo 는 상태 문자열이 아니라 done 플래그를 준다
            status: d.error ? "실패" : d.done ? "완료" : "생성 중",
            videoUri: d.videoUri,
            error: d.error,
          },
        }));
      } catch {
        /* 폴링 실패는 다음 주기에 다시 시도한다 */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <details className="card" style={{ marginBottom: 14 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          쓰는 순서 — 처음이면 열어보세요
        </summary>
        <ol style={{ marginTop: 12, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            <strong>참고 영상 찾기</strong> — 검색어를 넣고 인기 영상을 봅니다. 여기서
            가져가는 건 <em>구성</em>(길이, 반복 패턴, 어떤 소재가 먹히는지)뿐입니다.
            행을 누르면 그 영상의 구성을 분석해 다음 단계로 넘어갑니다. 건너뛰고
            주제만 직접 넣어도 됩니다.
          </li>
          <li>
            <strong>기획안 생성</strong> — Claude 가 제목·설명·캐릭터 시트·장면별 대사와
            영어 프롬프트를 만듭니다. 캐릭터 시트가 핵심입니다. 장면마다 이 문장을 앞에
            붙여야 캐릭터 외형이 흔들리지 않습니다. 제목 옆에 이번 호출이 쓴 토큰과 값이
            표시되니, 장면 수를 늘릴지 여기서 판단하세요.
          </li>
          <li>
            <strong>영상 만들기 — 둘 중 하나</strong>
            <ul style={{ marginTop: 6 }}>
              <li>
                <strong>구글 Flow (무료)</strong> — flow.google 에 장면별 영어 프롬프트를
                하나씩 붙여넣어 만들고 내려받습니다. Flow 는 API 가 없어 이 단계만
                수동입니다. 받은 파일은 아래 <strong>클립 업로드</strong>로 넣으세요.
              </li>
              <li>
                <strong>Veo (유료)</strong> — 장면마다 [렌더] 버튼을 누르면 자동으로
                만듭니다. 결제가 설정된 GCP 프로젝트의 Gemini 키가 필요합니다. 무료
                티어에는 Veo 가 없습니다.
              </li>
            </ul>
          </li>
          <li>
            <strong>내레이션 (선택)</strong> — [내레이션 만들기]를 누르면 장면 대사를
            이어 한 번에 읽습니다. 장면별로 따로 만들어 붙이면 문장 사이가 끊겨 들려서
            한 번에 읽습니다. 목소리를 고르려면 먼저 [목소리 찾기]로 골라두세요.
            안 만들면 무성으로 나옵니다 — 클립 자체의 소리는 쓰지 않습니다.
          </li>
          <li>
            <strong>조립</strong> — 클립을 올린 순서대로 잇고 자막·내레이션·댓글을
            얹습니다. 댓글은 비워두면 안 들어갑니다. ffmpeg 는 배포본에서 못 돌아서
            작업은 큐에 쌓이고, 로컬에서 <span className="mono">npm run worker</span> 가
            떠 있어야 처리됩니다. 결과는 <a href="/shorts">쇼츠</a> 화면의 작업 목록에서
            받습니다.
          </li>
        </ol>
        <p className="hint" style={{ marginTop: 4 }}>
          클립 수와 장면 수가 다르면 자막이 어긋납니다. 장면 하나에 클립 하나가
          기본이고, 다르면 화면이 경고를 띄웁니다.
        </p>
      </details>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="card">
        <h2>
            1. 무엇이 먹히는지 보기
            <Help text="유아 콘텐츠 인기 영상을 조회합니다. 제목과 조회수만 봅니다 — 남의 영상 파일은 쓰지 않습니다. 마음에 드는 구성을 체크하면 제목이 기획 근거로 넘어갑니다." />
          </h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>
              검색어
              <Help text="부모가 검색할 말로 넣으세요. 예: 유아 동요, 아기 색깔놀이, 유아 숫자.&#10;영어로 넣으면 해외 채널이 잡혀 참고가 덜 됩니다." />
            </label>
            <input
              value={query}
              placeholder="예: 유아 동요, 아기 색깔놀이"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && discover()}
            />
          </div>
          <div className="field">
            <label>
              카테고리
              <Help text="유아 콘텐츠는 보통 영화·애니메이션에 몰려 있습니다. 결과가 너무 적으면 전체로 넓히세요." />
            </label>
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
              {discoverNote} · <strong>행을 누르면</strong> 그 영상의 구성을 분석해 기획안까지
              바로 만듭니다. 제목·설명란·길이만 읽습니다 — 영상 파일은 쓰지 않습니다.
            </p>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 70 }} />
                    <th>제목</th>
                    <th style={{ width: 130 }}>채널</th>
                    <th style={{ width: 90 }} className="num">
                      조회수
                    </th>
                    <th style={{ width: 60 }} className="num">
                      길이
                    </th>
                    <th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr
                      key={v.id}
                      onClick={() => analyzeAndPlan(v)}
                      style={{ cursor: "pointer" }}
                      className={source?.id === v.id ? "picked-row" : ""}
                    >
                      <td>
                        {/* 원격 썸네일이라 next/image 최적화 대상이 아니다 */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={v.thumbnail} alt="" style={{ width: 60, borderRadius: 4 }} />
                      </td>
                      <td>
                        {/* 제목 링크는 행 클릭과 겹치므로 전파를 멈춘다 */}
                        <a
                          href={v.url}
                          target="_blank"
                          rel="noopener"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {v.title}
                        </a>
                      </td>
                      <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{v.channel}</td>
                      <td className="num">{num(v.views)}</td>
                      <td className="num">{mmss(v.durationSec)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          className="small"
                          onClick={() => analyzeAndPlan(v)}
                          disabled={planning}
                        >
                          {planning && source?.id === v.id && <span className="spinner" />}
                          분석
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>
          2. 기획
          <Help text="Claude 가 캐릭터·대본·장면별 영어 프롬프트를 한 번에 만듭니다. 기존 캐릭터를 닮게 만들지 않도록 프롬프트에 제약을 걸어두었고, 결과에 사람이 확인할 항목이 함께 나옵니다." />
        </h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>
              주제 (선택)
              <Help text="위에서 영상을 골라 분석했다면 비워두세요 — 모델이 구성에 맞는 주제를 직접 정합니다.&#10;직접 정하고 싶을 때만 넣으세요. 한 편에 하나만 다루세요. '색깔 배우기'처럼 좁을수록 반복 구조가 잘 나옵니다.&#10;아래 버튼으로 검증된 주제를 바로 넣을 수 있습니다." />
            </label>
            <input
              value={theme}
              placeholder="비워두면 분석한 영상에 맞춰 자동으로 정합니다"
              onChange={(e) => setTheme(e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              장면 수
              <Help text="장면 하나가 클립 하나입니다. 8개면 Flow 에서 8번 만들어야 합니다.&#10;처음에는 4개로 짧게 만들어 화풍을 확인한 뒤 늘리세요." />
            </label>
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
            <label>
              장면당 초
              <Help text="유아용은 한 장면이 길어도 됩니다(5~8초). 장면이 빨리 바뀌면 오히려 산만합니다.&#10;Veo 로 렌더할 경우 4·6·8초만 받아 가장 가까운 값으로 맞춰 보냅니다." />
            </label>
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
          <label>
            추가 지시 (선택)
            <Help text="꼭 넣을 요소나 피할 요소를 적으세요. 예: 노래 후렴을 3번 반복, 물놀이 장면은 빼기.&#10;캐릭터 외형을 여기서 지정하면 characterSheet 에 반영됩니다." />
          </label>
          <textarea
            rows={2}
            value={notes}
            placeholder="꼭 넣을 요소, 피할 요소 등"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <p className="hint">
          Veo 는 장면당 4·6·8초만 받습니다(가장 가까운 값으로 맞춰 보냅니다). Flow 로
          만드실 거면 이 값은 자막 배분 기준으로만 쓰입니다. 총 길이는{" "}
          {sceneCount * secondsPerScene}초.
        </p>

        <button
          className="primary"
          style={{ marginTop: 10 }}
          onClick={() => makePlan()}
          disabled={planning || (!theme.trim() && !source)}
        >
          {planning && <span className="spinner" />}
          {planning ? "기획 중… (1분 내외)" : "기획안 생성"}
        </button>
      </div>

      {plan && (
        <>
          <div className="card">
            <h2>
              기획안
              {plan.usage && (
                <span className="badge" style={{ marginLeft: 8, fontWeight: 400 }}>
                  {plan.usage.model} · 입력 {plan.usage.inputTokens.toLocaleString()} · 출력{" "}
                  {plan.usage.outputTokens.toLocaleString()} · $
                  {plan.usage.costUsd.toFixed(3)}
                </span>
              )}
            </h2>
            <div className="field">
              <label>제목</label>
              <input value={plan.title} readOnly />
            </div>
            {plan.analysis && (
              <details open style={{ marginTop: 12 }}>
                <summary>
                  참고 영상에서 읽어낸 구성
                  {source && (
                    <span className="dim" style={{ fontSize: 12 }}> · {source.title}</span>
                  )}
                </summary>
                <p style={{ margin: "8px 0 0", whiteSpace: "pre-line", fontSize: 13 }}>
                  {plan.analysis}
                </p>
              </details>
            )}

            <p className="hint" style={{ marginTop: 10 }}>
              <strong>주제</strong> {plan.theme} · <strong>컨셉</strong> {plan.concept}
            </p>

            <div className="field" style={{ marginTop: 10 }}>
              <label>
                캐릭터 고정 묘사 — 매 장면 프롬프트 앞에 자동으로 붙습니다
                <Help text="AI 영상 모델은 장면마다 캐릭터 외형이 흔들립니다. 이 문장을 모든 장면 프롬프트 앞에 똑같이 붙여 외형을 고정합니다.&#10;Flow 에 직접 넣을 때도 이 문장을 반드시 앞에 붙이세요 — 아래 '전체 프롬프트 복사' 버튼이 이미 붙여줍니다." />
              </label>
              <textarea className="mono" rows={3} value={plan.characterSheet} readOnly />
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>
                화풍
                <Help text="영상 전체의 그림 스타일입니다. 캐릭터 묘사와 함께 매 장면에 붙어 편 전체의 톤을 맞춥니다." />
              </label>
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
            <h2>
              3. 장면 렌더
              <Help text="두 가지 길이 있습니다.&#10;· 무료 — '전체 프롬프트 복사' 로 Flow 웹에서 만들어 내려받고, 아래 4단계에 올립니다.&#10;· 유료 — '렌더' 버튼으로 Veo API 를 직접 부릅니다." />
            </h2>
            <div className="alert warn" style={{ marginBottom: 12 }}>
              <strong>Veo 는 유료입니다.</strong> 초당 약 $0.15~0.40 라 8초 클면 $1.2~3.2,
              8장면이면 한 편에 $10~26 입니다. <strong>무료로 하려면</strong>{" "}
              <a href="https://flow.google" target="_blank" rel="noreferrer">
                구글 플로우
              </a>{" "}
              웹에서 아래 <strong>장면 프롬프트를 복사해</strong> 만들고, 내려받은 파일을{" "}
              <a href="/shorts">쇼츠</a> 화면의 소재 업로드로 넣으세요. Flow 는 API 가 없어
              백오피스에서 직접 부를 수 없습니다.
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="field">
                <label>
                  화면비
                  <Help text="쇼츠는 9:16 입니다. 유아 채널은 태블릿으로 보는 비중이 높아 일반 영상(16:9)도 함께 만들면 좋습니다." />
                </label>
                <select value={ratio} onChange={(e) => setRatio(e.target.value as "9:16")}>
                  <option value="9:16">9:16 (쇼츠)</option>
                  <option value="16:9">16:9 (일반)</option>
                </select>
              </div>
              <div className="field">
                <label>
                  해상도
                  <Help text="Veo API 로 렌더할 때만 적용됩니다. 720p 로도 쇼츠에는 충분하고 비용이 절반 이하입니다." />
                </label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value as "720p")}
                >
                  <option value="720p">720p (저렴)</option>
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
                  <th style={{ width: 90 }} title="이 장면 하나의 프롬프트를 복사합니다. Flow 는 한 번에 한 클립씩 만들므로, 장면마다 눌러 붙여넣는 게 실제 작업 순서와 맞습니다">
                    Flow
                  </th>
                  <th style={{ width: 130 }}>상태</th>
                  <th style={{ width: 80 }} />
                  <th style={{ width: 150 }} title="장면 대사를 Fish Audio 로 읽힙니다. 여기서 만드는 건 미리듣기용이고, 실제 영상에 깔리는 오디오는 4단계의 &#39;내레이션 만들기&#39; 입니다">내레이션</th>
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
                      <td>
                        <button
                          className="small"
                          onClick={() =>
                            copyText(
                              `${plan.characterSheet} ${plan.styleSheet} ${s.videoPrompt}`,
                            ).then(() => flash(`${s.index}번 장면 프롬프트 복사됨`))
                          }
                        >
                          복사
                        </button>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {!job && <span className="dim">—</span>}
                        {job?.status === "완료" && job.videoUri && (
                          /* Veo URI 는 키 헤더가 필요해 서버 프록시를 거친다 */
                          <a
                            href={`/api/kids?mode=video&uri=${encodeURIComponent(job.videoUri)}`}
                            target="_blank"
                            rel="noopener"
                          >
                            영상 열기
                          </a>
                        )}
                        {job && job.status !== "완료" && (
                          <span className={job.error ? "delta-down" : ""}>
                            {job.error ?? job.status}
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          className="small"
                          onClick={() => renderScene(s)}
                          disabled={Boolean(job && job.status !== "실패")}
                        >
                          {job?.status === "완료" ? "완료" : "렌더"}
                        </button>
                      </td>
                      <td>
                        {audio[s.index] ? (
                          <audio controls src={audio[s.index]} style={{ height: 30, width: 140 }} />
                        ) : (
                          <button
                            className="small ghost"
                            onClick={() => speak(s)}
                            disabled={ttsBusy === s.index || !s.korean.trim()}
                          >
                            {ttsBusy === s.index && <span className="spinner" />}
                            음성 만들기
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="ghost small"
                onClick={() =>
                  copyText(
                    plan.scenes
                      .map(
                        (s) =>
                          `[${s.index}] ${plan.characterSheet} ${plan.styleSheet} ${s.videoPrompt}`,
                      )
                      .join("\n\n"),
                  ).then(() => flash("전체 장면 프롬프트를 복사했습니다 — Flow 에 붙여넣으세요"))
                }
              >
                전체 프롬프트 복사 (Flow 용)
              </button>
            </div>
            <p className="hint">
              Veo 는 장면당 30~120초 걸리고 4·6·8초만 받아서, 기획안의 초를 가장 가까운
              허용값으로 맞춰 보냅니다. 결과 URL 은 24시간 뒤 만료되니 받아두세요.
              장면 이어붙이기와 자막은 쇼츠 화면의 렌더 워커나 편집기에서 하시면 됩니다.
            </p>
        </div>

          <div className="card">
            <h2>
              4. 조립
              <Help text="Flow 에서 받은 클립들을 한 편으로 합칩니다.&#10;순서대로 이어붙이고 → 장면 대사를 자막으로 얹고 → 내레이션을 오디오로 깔아 9:16 영상을 만듭니다.&#10;ffmpeg 가 필요해 로컬에서 npm run worker 가 돌고 있어야 합니다." />
            </h2>
            <p className="hint" style={{ marginTop: 0 }}>
              Flow 에서 만들어 받은 클립들을 한 번에 올리면 순서대로 이어 붙이고, 장면 대사를
              자막으로 얹고, 내레이션을 오디오로 깔아 한 편으로 만듭니다.
            </p>

            <div className="row" style={{ marginTop: 12 }}>
              <div className="field" style={{ flex: 1, minWidth: 260 }}>
                <label>
                  장면 클립 (여러 개 한 번에 선택)
                  <Help text="Flow 에서 받은 파일을 전부 한 번에 선택하세요(⌘A).&#10;파일명 속 숫자 순서로 정렬합니다 — scene-1, scene-2 … scene-10 처럼 번호가 들어가면 그대로 순서가 맞습니다.&#10;순서가 틀리면 아래 표에서 확인하고 제거 후 다시 올리세요." />
                </label>
                <input
                  type="file"
                  accept="video/*"
                  multiple
                  disabled={uploading}
                  onChange={(e) => {
                    uploadClips(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {uploading && (
                <span className="badge on" style={{ alignSelf: "center" }}>
                  <span className="spinner" />
                  올리는 중
                </span>
              )}
            </div>

            {clips.length > 0 && (
              <table style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th style={{ width: 40 }} className="num">
                      순서
                    </th>
                    <th>파일</th>
                    <th style={{ width: 200 }} title="이 클립 구간에 얹힐 장면 대사입니다. 여기가 어긋나면 클립 순서가 틀린 것입니다">
                      이 순서에 붙는 자막
                    </th>
                    <th style={{ width: 90 }} className="num">
                      크기
                    </th>
                    <th style={{ width: 60 }} />
                  </tr>
                </thead>
                <tbody>
                  {clips.map((c, i) => (
                    <tr key={c.name}>
                      <td className="num">{i + 1}</td>
                      <td style={{ fontSize: 12 }}>{c.originalName}</td>
                      <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                        {plan.scenes[i]?.korean ?? "—"}
                      </td>
                      <td className="num" style={{ fontSize: 12 }}>
                        {Math.round(c.sizeBytes / 1024 / 1024)}MB
                      </td>
                      <td>
                        <button
                          className="small ghost"
                          onClick={() => setClips((prev) => prev.filter((x) => x.name !== c.name))}
                        >
                          제거
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {clips.length > 0 && clips.length !== plan.scenes.length && (
              <div className="alert warn" style={{ marginTop: 12 }}>
                클립 {clips.length}개, 장면 {plan.scenes.length}개로 수가 다릅니다. 자막은
                순서대로 붙으니 남는 쪽은 비거나 버려집니다.
              </div>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              <button onClick={makeNarration} disabled={makingNarration}>
                {makingNarration && <span className="spinner" />}
                내레이션 만들기
              </button>
              <Help text="장면 대사를 전부 이어 한 번에 읽혀 파일로 저장합니다. 장면마다 따로 만들어 붙이면 문장 사이가 끊긴 티가 납니다.&#10;안 만들면 무성 영상이 됩니다 — 클립 자체의 소리는 쓰지 않습니다." />
              {narration && (
                <span className="badge on" style={{ alignSelf: "center" }}>
                  {narration.originalName}
                </span>
              )}
              <label
                style={{ display: "flex", alignItems: "center", gap: 6, alignSelf: "center" }}
              >
                <input
                  type="checkbox"
                  checked={withTitle}
                  onChange={(e) => setWithTitle(e.target.checked)}
                />
                <span style={{ fontSize: 12 }}>제목 얹기</span>
              </label>
              <Help text="영상 위쪽 여백에 기획안 제목을 큰 글씨로 얹습니다. 쇼츠 첫 화면에서 무슨 영상인지 바로 보여 이탈이 줄어듭니다." />
              <button
                className="primary"
                onClick={assemble}
                disabled={assembling || !clips.length}
              >
                {assembling && <span className="spinner" />}
                한 편으로 조립
              </button>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <div className="field" style={{ width: 150 }}>
                <label>댓글 작성자</label>
                <input
                  value={commentAuthor}
                  placeholder="시청자"
                  onChange={(e) => setCommentAuthor(e.target.value)}
                />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 240 }}>
                <label>
                  댓글 (아래 여백)
                  <Help text="영상 아래 여백에 @작성자와 함께 얹습니다. 본문을 비우면 아무것도 안 들어갑니다.&#10;네 줄까지 들어가고 넘치는 만큼은 잘립니다." />
                </label>
                <input
                  value={commentText}
                  placeholder="아이가 계속 돌려봐요"
                  onChange={(e) => setCommentText(e.target.value)}
                />
              </div>
            </div>

            {assembleJob !== null && (
              <div className="alert ok" style={{ marginTop: 12 }}>
                조립 작업 <strong>#{assembleJob}</strong> 등록됨. 로컬에서{" "}
                <span className="mono">npm run worker</span> 가 돌고 있어야 처리됩니다.
                결과는 <a href="/shorts">쇼츠</a> 화면의 작업 목록에서 받으세요.
              </div>
            )}

            <p className="hint">
              내레이션을 안 만들면 무성으로 나옵니다. 클립 자체의 소리는 쓰지 않습니다 —
              클립마다 오디오 구성이 달라 이어 붙일 때 통째로 실패하기 때문입니다.
            </p>
          </div>
        </>
      )}
    </>
  );
}
