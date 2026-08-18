"use client";

import { useCallback, useEffect, useState } from "react";
import Help from "@/components/Help";

/**
 * 쇼츠 만들기 — 롱폼을 잘라 쇼츠로.
 *
 * 흐름은 세 단계다.
 *   1. CC 라이선스 롱폼을 찾는다 (가공해도 되는 것만)
 *   2. 행을 누르면 그 영상의 댓글 타임스탬프를 집계해 하이라이트 구간을 찾는다
 *   3. 그 구간을 잘라 쇼츠로 렌더한다
 *
 * 목록에 표준 라이선스를 섞지 않는다. 잘라 쓰는 게 목적인데 쓸 수 없는 줄이 섞여
 * 있으면 목록을 매번 눈으로 걸러야 한다. CC 로 좁히면 목록이 곧 후보가 된다.
 *
 * 길이는 20분 초과가 기본이다. 한 편에서 여러 컷을 뽑을 수 있어 소재 하나로 여러
 * 편이 나온다. 댓글 타임스탬프가 어디에 몰렸는지를 보고 어느 구간을 뜰지 정한다.
 *
 * CC 라도 출처 표기는 필요하다 — 발행할 때 원작자와 채널을 설명란에 적어야 한다.
 */

type YtVideo = {
  id: string;
  title: string;
  channel: string;
  views: number | null;
  comments: number | null;
  durationSec: number | null;
  thumbnail: string;
  license: string | null;
  embeddable: boolean | null;
  blockedInKR: boolean;
  commentsEnabled: boolean;
  url: string;
};



type Comment = { id: string; author: string; text: string; likes: number };

/** 댓글이 몰린 지점. peakAt 은 언급 위치, cutStart 는 리드인을 뺀 실제 컷 시작 */
type Highlight = {
  peakAt: number;
  cutStart: number;
  cutDuration: number;
  mentions: number;
  score: number;
  samples: { at: number; likes: number; text: string; author: string }[];
};
type HistBin = { start: number; mentions: number; score: number };
type Source = { id: string; label: string; ok: boolean; message: string };
type Job = {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  options: { title?: string; input?: string };
  result_url: string;
  size_bytes: number | null;
  error: string;
  created_at: string;
};

/**
 * 채널 방향에 맞춘 소재 검색어 프리셋.
 *
 * 한국 근현대사 기록영상으로 잡았다. 미국 뉴스릴이 16만 건으로 훨씬 많지만 한국
 * 시청자에게는 남의 나라 이야기라 스크롤을 멈추지 않는다. 한국 관련은 2,000건대로
 * 적어도 대부분 처음 보는 영상이라 쇼츠에서 강하다.
 *
 * 좁은 검색어는 금방 마른다(`seoul 1950` 은 88건뿐이었다). 넓게 훑고 그 안에서 고른다.
 */
/**
 * 자주 쓰는 검색어.
 *
 * 게임으로 방향을 잡았다. 댓글 타임스탬프는 "그 장면"이 뚜렷한 장르에서 많이 달리고,
 * 게임이 그중 제일 많다. 롱폼 하이라이트 영상에 특히 잘 붙는다.
 */
/**
 * 자주 쓰는 검색어.
 *
 * 예전 목록은 "배그 클러치"·"오버워치 팀킬"처럼 장면을 콕 집는 말이었다. 표준
 * 라이선스까지 뒤지던 시절에는 그게 맞았는데, CC 롱폼으로 좁히니 절반이 0건이었다
 * (배그 클러치·오버워치 팀킬·피파 골모음 전부 0건). CC 로 영상을 통째로 푸는 쪽은
 * 장면 편집본이 아니라 실황·풀 플레이라, 게임 이름이나 갈래로 찾아야 걸린다.
 *
 * 아래는 전부 눌러 보고 20분 초과 CC 가 열 건씩 나오는 것만 남긴 목록이다.
 */
const SEED_PRESETS = [
  "리그오브레전드",
  "배틀그라운드",
  "마인크래프트",
  "로블록스",
  "공포게임",
  "레트로 게임",
  "게임 실황",
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

/**
 * 라이선스와 접근 제약을 한눈에.
 *
 * 표준 라이선스를 빨간 배지로 "가공 불가"라고 띄우고 있었다. 그런데 이 화면은
 * 영상을 가공하는 곳이 아니다 — 댓글이 몰린 지점을 찾는 곳이고, 화면 위에 이미
 * "남의 영상 파일은 건드리지 않습니다"라고 적혀 있다.
 *
 * 인기 급상승은 사실상 전부 표준 라이선스라(실측 10/10) 모든 줄이 빨갛게 뜨고,
 * 그러면 기능이 고장난 것처럼 보인다. 게다가 100% 에 붙는 표시는 아무것도 알려주지
 * 않는다. 그래서 표준은 담담한 기본 배지로 두고, 드물게 나오는 CC 만 강조한다.
 *
 * 진짜 경고는 따로다 — 댓글이 잠겨 있으면 이 화면의 목적 자체가 불가능하고,
 * 국내 차단이면 확인조차 못 한다. 빨간색은 그쪽에 남긴다.
 */
function LicenseBadge({ video }: { video: YtVideo }) {
  const reusable = video.license === "creativeCommon";
  const notes: string[] = [];
  // 이 화면은 댓글을 읽는 곳이라 댓글 잠김이 가장 치명적이다. 먼저 보이게 둔다
  if (!video.commentsEnabled) notes.push("댓글 잠김");
  if (video.blockedInKR) notes.push("국내 차단");

  return (
    <>
      <span className={`badge${reusable ? " on" : ""}`}>
        {reusable ? "CC · 가공 가능" : "표준 라이선스"}
      </span>
      {notes.map((n) => (
        <span key={n} className="badge off" style={{ marginLeft: 4 }}>
          {n}
        </span>
      ))}
    </>
  );
}

export default function ShortsPage() {
  /* 검색·인기 급상승이 같은 표를 채운다. 두 탭으로 나눌 이유가 없었다 */
  const [videos, setVideos] = useState<YtVideo[]>([]);
  const [listNote, setListNote] = useState("");
  const [query, setQuery] = useState("");
  /* 잘라 쓸 소재는 길수록 뽑을 구간이 많다. 기본은 20분 초과 */
  const [duration, setDuration] = useState<"long" | "medium" | "any">("long");
  const [srcSources, setSrcSources] = useState<Source[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingTrend, setLoadingTrend] = useState(false);

  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsFor, setCommentsFor] = useState("");
  const [loadingComments, setLoadingComments] = useState(false);

  // 댓글 타임스탬프 하이라이트
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [histogram, setHistogram] = useState<HistBin[]>([]);
  const [highlightsFor, setHighlightsFor] = useState("");
  const [highlightNote, setHighlightNote] = useState("");
  const [loadingHighlights, setLoadingHighlights] = useState(false);
  /* 피크보다 몇 초 앞에서 컷을 시작할지. 사람은 반응한 뒤에 댓글을 쓴다 */
  const [leadInSec, setLeadInSec] = useState(4);
  const [cutLenSec, setCutLenSec] = useState(15);

  // 렌더 입력
  const [input, setInput] = useState("");
  const [startSec, setStartSec] = useState(0);
  const [durationSec, setDurationSec] = useState(30);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  /* 컷 길이. 0 이면 한 구간을 통째로 쓴다 */
  const [cutSec, setCutSec] = useState(4);
  /* 컷 위치를 실제 장면 전환에서 딸지. 첫 분석은 오래 걸리지만 소재별로 캐시된다 */
  const [sceneDetect, setSceneDetect] = useState(true);
  /* 줄바꿈으로 나눈 자막 대본. 전체 길이에 고르게 배분된다 */
  const [script, setScript] = useState("");
  const [picked, setPicked] = useState<Comment | null>(null);

  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);


  const loadJobs = useCallback(() => {
    fetch("/api/shorts/jobs")
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadJobs();
    loadDefault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 처리 중인 작업이 있을 때만 폴링한다. 워커가 가져가 렌더를 마치는 순간을
   * 화면이 알 방법이 이것뿐이고, 다 끝났는데 계속 두드릴 이유는 없다.
   */
  const pending = jobs.filter((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(loadJobs, 4000);
    return () => clearInterval(t);
  }, [pending.length, loadJobs]);

  /**
   * 워커가 안 떠 있으면 작업이 queued 에서 움직이지 않는다. 그 상태가 길어지면
   * 화면이 멈춘 것처럼 보이므로, 30초 넘게 대기 중인 게 있으면 안내한다.
   */
  const stalled = jobs.some(
    (j) => j.status === "queued" && Date.now() - new Date(j.created_at).getTime() > 30_000,
  );

  /**
   * 첫 화면 목록.
   *
   * 예전에는 인기 급상승을 띄웠는데, 그건 사실상 전부 표준 라이선스라(실측 10/10)
   * 손댈 수 없는 줄만 스물다섯 개 나왔다. 화면을 열자마자 보이는 목록은 바로
   * 쓸 수 있는 것이어야 한다. 프리셋 첫 항목으로 CC 롱폼을 채운다.
   */
  const loadDefault = useCallback(async () => {
    setLoadingTrend(true);
    setError("");
    try {
      const params = new URLSearchParams({ mode: "sources", q: SEED_PRESETS[0], duration: "long" });
      const d = await (await fetch(`/api/shorts/discover?${params}`)).json();
      setVideos(d.videos ?? []);
      setSrcSources(d.sources ?? []);
      setListNote(d.note ?? "");
      if (d.error) setError(d.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingTrend(false);
    }
  }, []);

  /**
   * 가공 가능한 소재 검색.
   *
   * CC 라이선스로 좁힌다. 롱폼을 잘라 쇼츠로 만드는 흐름이라, 가공해도 되는 것만
   * 보여야 목록이 곧 후보가 된다. 표준 라이선스를 섞으면 쓸 수 없는 줄만 늘어난다.
   */
  async function searchSources() {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try {
      const params = new URLSearchParams({
        mode: "sources",
        q: query.trim(),
        duration,
      });
      const d = await (await fetch(`/api/shorts/discover?${params}`)).json();
      setVideos(d.videos ?? []);
      setSrcSources(d.sources ?? []);
      setListNote(d.note ?? "");
      if (d.error) setError(d.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }



  async function loadComments(videoId: string, videoTitle: string) {
    setLoadingComments(true);
    setCommentsFor(videoTitle);
    try {
      const d = await (
        await fetch(`/api/shorts/discover?mode=comments&videoId=${encodeURIComponent(videoId)}`)
      ).json();
      setComments(d.comments ?? []);
      if (d.error) setError(d.error);
    } finally {
      setLoadingComments(false);
    }
  }

  /**
   * 댓글 타임스탬프로 하이라이트 구간을 찾는다.
   *
   * 분석이라 어느 영상에든 돌린다. 나오는 건 "몇 초가 반응이 좋았나"이지 그 영상을
   * 쓸 권리가 아니다 — 컷 실행은 소재 탭에서 고른 파일에만 붙는다.
   */
  async function loadHighlights(videoId: string, videoTitle: string) {
    setLoadingHighlights(true);
    setHighlightsFor(videoTitle);
    setHighlights([]);
    setHistogram([]);
    setError("");
    try {
      const params = new URLSearchParams({
        mode: "highlights",
        videoId,
        leadIn: String(leadInSec),
        cut: String(cutLenSec),
      });
      const d = await (await fetch(`/api/shorts/discover?${params}`)).json();
      setHighlights(d.highlights ?? []);
      setHistogram(d.histogram ?? []);
      setHighlightNote(
        d.ok
          ? `댓글 ${d.commentCount ?? 0}개 중 타임스탬프 ${d.mentionCount ?? 0}건`
          : "",
      );
      if (d.error) setError(d.error);
      else if (d.ok && !(d.highlights ?? []).length) {
        setError(
          "타임스탬프가 달린 댓글이 없어 하이라이트를 찾지 못했습니다. 게임·음악·스포츠 영상에서 잘 나옵니다.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingHighlights(false);
    }
  }

  async function render() {
    if (!input.trim()) {
      setError("원본 영상 주소를 넣으세요. 소재 목록에서 고르면 자동으로 채워집니다.");
      return;
    }
    setRendering(true);
    setError("");
    try {
      /*
       * 여기서 직접 렌더하지 않는다. ffmpeg 는 서버리스에서 못 돌아 배포본에서는
       * 버튼이 죽는다. 작업만 등록하고 로컬 워커가 가져가 처리한다.
       */
      const res = await fetch("/api/shorts/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: input.trim(),
          startSec,
          durationSec,
          cutSec: cutSec > 0 ? cutSec : undefined,
          sceneDetect: cutSec > 0 && sceneDetect,
          script,
          title,
          caption,
          comment: picked ? { author: picked.author, text: picked.text } : undefined,
        }),
      });
      const d = await res.json();
      if (!d.ok) {
        setError(d.error ?? "작업 등록에 실패했습니다.");
        return;
      }
      loadJobs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRendering(false);
    }
  }



  return (
    <>
      <h1 className="page-title">쇼츠</h1>
      <p className="page-desc">
        <strong>CC 라이선스 롱폼</strong>을 찾아 댓글이 몰린 지점을 보고, 그 구간을 잘라
        쇼츠로 만듭니다. 한 편에서 여러 컷이 나옵니다.
      </p>

      {error && <div className="alert warn">{error}</div>}

      <div className="alert ok">
        <strong>목록은 CC 라이선스만 보여줍니다.</strong> 표준 라이선스는 잘라 쓸 수 없어
        아예 빼두었으니, 여기 나오는 건 전부 가공해도 되는 것입니다. 다만{" "}
        <strong>출처 표기는 여전히 필요합니다</strong> — 발행할 때 원작자와 채널을 설명란에
        적으세요. CC BY 는 표기가 이용 조건입니다.
      </div>

      <div className="card">
        <h2>
          영상 찾기
          <Help text="게임 이름이나 상황을 한국어로 넣으세요. 예: 롤 하드캐리, 배그 1인칭 클러치.&#10;댓글 타임스탬프는 게임·음악·스포츠에서 가장 많이 달립니다.&#10;아래 프리셋으로 바로 넣을 수 있습니다." />
        </h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>검색어</label>
            <input
              placeholder="리그오브레전드, 마인크래프트, 공포게임 …"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchSources()}
            />
          </div>
          <div className="field">
            <label>
              길이
              <Help text="롱폼 한 편에서 여러 컷을 뽑아 쇼츠 여러 편을 만드는 흐름입니다.&#10;20분 초과가 소재 효율이 가장 좋고, 4분 미만은 뽑을 구간이 몇 개 안 나옵니다." />
            </label>
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value as "long" | "medium" | "any")}
            >
              <option value="long">20분 초과 (권장)</option>
              <option value="medium">4~20분</option>
              <option value="any">길이 무관</option>
            </select>
          </div>
          <button className="primary" onClick={searchSources} disabled={searching || !query.trim()}>
            {searching && <span className="spinner" />}
            검색
          </button>
          <button className="ghost" onClick={loadDefault} disabled={loadingTrend}>
            {loadingTrend && <span className="spinner" />}
            처음 목록
          </button>
          {srcSources.map((s) => (
            <span key={s.id} className={`badge ${s.ok ? "on" : "off"}`}>
              {s.label} · {s.message}
            </span>
          ))}
        </div>

        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
            자주 쓰는 검색어:
          </span>
          {SEED_PRESETS.map((p) => (
            <button
              key={p}
              className="small ghost"
              onClick={() => {
                setQuery(p);
                // 프리셋을 누르면 바로 찾아본다. 한 번 더 누르게 할 이유가 없다
                setTimeout(searchSources, 0);
              }}
            >
              {p}
            </button>
          ))}
        </div>

        {videos.length > 0 && (
          <>
            <p className="hint">
              {listNote} · <strong>행을 누르면</strong> 그 영상의 댓글 타임스탬프를 집계해
              하이라이트 구간을 찾습니다.
            </p>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 70 }} />
                    <th>제목</th>
                    <th style={{ width: 90 }} className="num" title="유튜브 조회수">
                      조회수
                    </th>
                    <th
                      style={{ width: 80 }}
                      className="num"
                      title="댓글이 많을수록 타임스탬프가 달릴 확률이 높습니다. 댓글이 잠긴 영상은 하이라이트를 찾을 수 없습니다"
                    >
                      댓글
                    </th>
                    <th style={{ width: 60 }} className="num">
                      길이
                    </th>
                    <th
                      style={{ width: 150 }}
                      title="가공(라이선스)과 재공유(임베드)는 다른 권한입니다. 표준 라이선스여도 어느 구간이 먹혔는지 분석하는 것은 문제없습니다"
                    >
                      재사용
                    </th>
                    <th style={{ width: 130 }} />
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr
                      key={v.id}
                      onClick={() => loadHighlights(v.id, v.title)}
                      style={{ cursor: v.commentsEnabled ? "pointer" : "default" }}
                      className={highlightsFor === v.title ? "picked-row" : ""}
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
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {v.title}
                        </a>
                        <div className="dim" style={{ fontSize: 12 }}>
                          {v.channel}
                        </div>
                      </td>
                      <td className="num">{num(v.views)}</td>
                      <td className="num">{num(v.comments)}</td>
                      <td className="num dim">{mmss(v.durationSec)}</td>
                      <td>
                        <LicenseBadge video={v} />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          className="small"
                          onClick={() => loadHighlights(v.id, v.title)}
                          disabled={!v.commentsEnabled}
                        >
                          하이라이트
                        </button>{" "}
                        <button className="small ghost" onClick={() => loadComments(v.id, v.title)}>
                          댓글
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


      {(loadingComments || comments.length > 0) && (
        <div className="card">
          <h2>
            인기 댓글 {loadingComments && <span className="spinner" />}
            <span className="dim" style={{ fontSize: 12 }}> {commentsFor}</span>
          </h2>
          <div className="comment-list">
            {comments.slice(0, 12).map((c) => (
              <button
                key={c.id}
                className={`comment-item ${picked?.id === c.id ? "picked" : ""}`}
                onClick={() => setPicked(picked?.id === c.id ? null : c)}
              >
                <span className="dim">♥ {num(c.likes)} · @{c.author}</span>
                <span>{c.text}</span>
              </button>
            ))}
          </div>
          <p className="hint">
            누르면 아래 렌더에 얹힙니다. 다시 누르면 해제됩니다.
          </p>
        </div>
      )}

      {(loadingHighlights || highlights.length > 0) && (
        <div className="card">
          <h2>
            하이라이트 {loadingHighlights && <span className="spinner" />}
            <span className="dim" style={{ fontSize: 12 }}> {highlightsFor}</span>
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {highlightNote} · 댓글이 몰린 지점입니다. <strong>구간을 어디에 쓸지는 소재
            라이선스가 정합니다</strong> — 남의 영상은 기획 참고용이고, 컷은 CC·아카이브·
            직접 올린 파일에만 적용하세요.
          </p>

          <div className="row" style={{ marginBottom: 14 }}>
            <div className="field">
              <label>
                리드인 (초)
                <Help text="댓글이 가리킨 지점보다 몇 초 앞에서 컷을 시작할지.&#10;사람은 좋은 장면이 시작될 때가 아니라 반응한 뒤에 댓글을 씁니다. 0 으로 두면 클라이맥스가 지나간 자리에서 시작합니다.&#10;바꾸면 '하이라이트' 를 다시 눌러야 반영됩니다." />
              </label>
              <input
                type="number"
                min={0}
                max={20}
                value={leadInSec}
                style={{ width: 80 }}
                onChange={(e) => setLeadInSec(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label>
                컷 길이 (초)
                <Help text="하이라이트 구간 하나를 몇 초로 뜰지. 쇼츠 한 편이 이 길이로 만들어집니다.&#10;15~30초가 무난합니다." />
              </label>
              <input
                type="number"
                min={3}
                max={60}
                value={cutLenSec}
                style={{ width: 80 }}
                onChange={(e) => setCutLenSec(Number(e.target.value))}
              />
            </div>
            <p className="hint" style={{ margin: 0, alignSelf: "center", maxWidth: 320 }}>
              사람은 좋은 장면이 시작될 때가 아니라 반응한 뒤에 댓글을 씁니다. 그래서 몇 초
              앞에서 시작해야 클라이맥스를 놓치지 않습니다.
            </p>
          </div>

          {histogram.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 1,
                height: 70,
                marginBottom: 14,
                overflowX: "auto",
              }}
            >
              {(() => {
                const max = Math.max(...histogram.map((b) => b.score), 1);
                return histogram.map((b) => (
                  <div
                    key={b.start}
                    title={`${mmss(b.start)} · 언급 ${b.mentions}건`}
                    style={{
                      flex: "1 0 3px",
                      height: `${Math.max((b.score / max) * 100, b.score > 0 ? 6 : 1)}%`,
                      background: b.score > 0 ? "var(--accent)" : "var(--border)",
                      opacity: b.score > 0 ? 0.35 + (b.score / max) * 0.65 : 1,
                      borderRadius: 1,
                    }}
                  />
                ));
              })()}
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>지점</th>
                <th style={{ width: 90 }}>컷 구간</th>
                <th style={{ width: 60 }} className="num">언급</th>
                <th>대표 반응</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {highlights.map((h) => (
                <tr key={h.peakAt}>
                  <td className="mono">{mmss(h.peakAt)}</td>
                  <td className="mono dim">
                    {mmss(h.cutStart)} +{h.cutDuration}s
                  </td>
                  <td className="num">{h.mentions}</td>
                  <td style={{ fontSize: 12 }}>
                    {h.samples[0] ? (
                      <>
                        <span className="dim">♥ {num(h.samples[0].likes)} </span>
                        {h.samples[0].text.slice(0, 60)}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <button
                      className="small"
                      onClick={() => {
                        setStartSec(h.cutStart);
                        setDurationSec(h.cutDuration);
                      }}
                    >
                      구간 적용
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>3. 렌더</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 300 }}>
            <label>
              내 녹화 파일 경로
              <Help text="**내가 직접 플레이해 녹화한 파일**을 넣습니다. 남의 영상 주소를 넣는 자리가 아닙니다.&#10;위에서 찾은 하이라이트 구간을 참고해 그 장면을 직접 플레이·녹화하면 온전히 내 소재가 됩니다.&#10;파일 탐색기에서 파일을 끌어다 놓거나, 경로를 복사해 붙여넣으세요." />
            </label>
            <input
              className="mono"
              placeholder="/Users/mac/Movies/게임녹화.mp4"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              시작(초)
              <Help text="원본에서 잘라낼 시작 지점. 하이라이트 표의 '구간 적용' 을 누르면 자동으로 채워집니다." />
            </label>
            <input
              type="number" min={0} style={{ width: 90 }}
              value={startSec}
              onChange={(e) => setStartSec(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>
              길이(초)
              <Help text="결과 영상 전체 길이. 쇼츠는 60초를 넘기지 않는 편이 낫습니다." />
            </label>
            <input
              type="number" min={1} max={180} style={{ width: 90 }}
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>
              컷 길이(초)
              <Help text="0 이면 한 지점에서 통째로 뜹니다. 값을 주면 원본 여러 지점에서 이 길이만큼 떠서 이어붙입니다.&#10;한 장면이 30초 내내 이어지면 끝까지 안 보므로, 4초 정도로 두면 컷이 계속 바뀝니다." />
            </label>
            <input
              type="number" min={0} max={30} style={{ width: 90 }}
              value={cutSec}
              onChange={(e) => setCutSec(Number(e.target.value))}
            />
          </div>
        </div>
        {cutSec > 0 && (
          <label
            className="hint"
            style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={sceneDetect}
              onChange={(e) => setSceneDetect(e.target.checked)}
            />
            장면 전환 감지 — 샷이 바뀌는 지점에서 컷을 뜹니다. 소재를 처음 쓸 때
            한 번 전체를 훑어 몇 분 걸리고, 그다음부터는 캐시라 바로 됩니다.
            끄면 시간만 균등 분할해 샷 한가운데에서 잘릴 수 있습니다.
          </label>
        )}
        <p className="hint" style={{ marginTop: 6 }}>
          컷 길이만큼씩 원본 여러 지점에서 떠서 이어 붙입니다
          {cutSec > 0 && durationSec > 0 && (
            <> — {Math.max(1, Math.round(durationSec / cutSec))}컷</>
          )}
          . 0 으로 두면 시작 지점부터 한 번에 자릅니다.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>제목 (위 여백)</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>자막 — 한 줄 고정 (대본이 있으면 무시)</label>
            <input value={caption} onChange={(e) => setCaption(e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>자막 대본 (한 줄이 자막 하나)</label>
          <textarea
            rows={5}
            value={script}
            placeholder={"1951년 겨울, 전선은 멈춰 있었다\n미군 촬영반이 남긴 기록\n이 땅에서 실제로 있었던 일"}
            onChange={(e) => setScript(e.target.value)}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            {script.split("\n").filter((l) => l.trim()).length > 0 ? (
              <>
                {script.split("\n").filter((l) => l.trim()).length}줄 · 줄당 약{" "}
                {(durationSec / Math.max(1, script.split("\n").filter((l) => l.trim()).length)).toFixed(1)}초
              </>
            ) : (
              <>비워두면 위의 고정 자막이 처음부터 끝까지 그대로 남습니다.</>
            )}
          </p>
        </div>
        {picked && (
          <p className="hint">
            얹을 댓글: <strong>@{picked.author}</strong> — {picked.text.slice(0, 60)}
          </p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={render} disabled={rendering}>
            {rendering && <span className="spinner" />}
            {rendering ? "등록 중" : "쇼츠 만들기"}
          </button>
          <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
            작업을 큐에 넣으면 로컬 워커(<span className="mono">npm run worker</span>)가
            렌더합니다.
          </span>
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2 style={{ margin: 0 }}>
              작업 {jobs.length}건
              {pending.length > 0 && (
                <span className="badge" style={{ marginLeft: 8 }}>
                  <span className="spinner" />
                  처리 중 {pending.length}
                </span>
              )}
            </h2>
            <button className="small ghost" onClick={loadJobs}>새로고침</button>
          </div>

          {stalled && (
            <div className="alert warn">
              작업이 대기 상태에서 움직이지 않습니다. 로컬에서{" "}
              <span className="mono">npm run worker</span> 가 떠 있는지 확인하세요.
              워커를 켜면 쌓인 작업부터 순서대로 처리합니다.
            </div>
          )}

          <div className="short-grid">
            {jobs.map((j) => (
              <div key={j.id} className="short-item">
                {j.status === "done" && j.result_url ? (
                  <video src={j.result_url} controls preload="metadata" />
                ) : (
                  <div className={`job-placeholder ${j.status}`}>
                    {j.status === "failed" ? "실패" : j.status === "running" ? "렌더 중" : "대기 중"}
                  </div>
                )}
                <div className="dim" style={{ fontSize: 11, marginTop: 5 }}>
                  #{j.id} {j.options?.title || "(제목 없음)"}
                </div>
                {j.error && (
                  <div className="dim" style={{ fontSize: 11, color: "var(--danger)" }}>
                    {j.error.slice(0, 80)}
                  </div>
                )}
                {j.status === "done" && j.result_url && (
                  <div className="row" style={{ gap: 4, marginTop: 5 }}>
                    <a href={j.result_url} download target="_blank" rel="noreferrer">
                      <button className="small">저장</button>
                    </a>
                    <span className="dim" style={{ fontSize: 11, alignSelf: "center" }}>
                      {Math.round((j.size_bytes ?? 0) / 1024)}KB
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
