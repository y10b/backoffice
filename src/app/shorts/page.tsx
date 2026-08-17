"use client";

import { useCallback, useEffect, useState } from "react";
import Help from "@/components/Help";

/**
 * 쇼츠 만들기.
 *
 * 흐름은 세 단계다.
 *   1. 무엇을 만들지 정한다 (인기 급상승 = 지금 뭐가 뜨는지)
 *   2. 실제로 가공해도 되는 소재를 고른다 (CC / 공개 도메인)
 *   3. 댓글·문구를 얹어 렌더한다
 *
 * 1단계의 영상은 대부분 표준 라이선스라 **그대로 가공하면 안 된다.** 기획 근거로만 쓰고,
 * 소재는 2단계에서 따로 고른다. 화면에서 이 구분이 보이도록 라이선스를 항상 함께 띄운다.
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

type ArchiveRow = {
  identifier: string;
  title: string;
  creator: string;
  year: string;
  license: string;
  /** 재사용해도 되는지 확인됐는가. 표기 없음은 확인 안 된 것이지 공개 도메인이 아니다 */
  licenseConfirmed: boolean;
  detailUrl: string;
  thumbnail: string;
};

type ArchiveFile = {
  name: string;
  format: string;
  sizeBytes: number | null;
  durationSec: number | null;
  downloadUrl: string;
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
type SourceFile = {
  name: string; originalName: string; origin: string; license: string;
  sizeBytes: number; path: string;
};
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
const SEED_PRESETS = [
  // 컬렉션으로 좁히지 않으면 무단 업로드가 섞인다. `seoul korea` 만 넣었을 때는
  // SBS 뉴스 클립이 여럿 나왔다. 미국 정부 제작물은 저작권 자체가 없어 가장 안전하다.
  {
    label: "한국전쟁 (미 정부)",
    q: 'korea AND collection:(FedFlix OR usgovfilms OR nationalarchives)',
  },
  {
    label: "미군 촬영 기록",
    q: 'korea AND (creator:"U.S. Army" OR creator:"United States. Department of Defense")',
  },
  {
    label: "전투 기록영상",
    q: '"combat bulletin" OR "big picture" AND korea',
  },
  {
    label: "1950년대 한국",
    q: 'korea AND date:[1950-01-01 TO 1959-12-31] AND collection:(FedFlix OR usgovfilms)',
  },
  // 아래는 범위가 넓어 무단 업로드가 섞일 수 있다. 라이선스 배지를 꼭 확인할 것
  { label: "한국 일반 (확인 필요)", q: "korea OR korean" },
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
 * 재사용 가능 여부를 한눈에. 이 구분이 이 화면의 핵심이다.
 *
 * 가공(라이선스)과 재공유(임베드)는 다른 권한이라 배지를 따로 낸다. 하나로 합치면
 * "퍼가기 되니까 잘라 써도 되겠지"로 읽힌다.
 */
function LicenseBadge({ video }: { video: YtVideo }) {
  const reusable = video.license === "creativeCommon";
  const notes: string[] = [];
  if (video.embeddable === false) notes.push("퍼가기 금지");
  if (video.blockedInKR) notes.push("국내 차단");
  if (!video.commentsEnabled) notes.push("댓글 잠김");

  return (
    <>
      <span className={`badge ${reusable ? "on" : "off"}`}>
        {reusable ? "CC · 가공 가능" : "표준 · 가공 불가"}
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
  const [tab, setTab] = useState<"trend" | "source">("trend");

  const [trending, setTrending] = useState<YtVideo[]>([]);
  const [trendSources, setTrendSources] = useState<Source[]>([]);
  const [loadingTrend, setLoadingTrend] = useState(false);

  const [query, setQuery] = useState("");
  const [ytCc, setYtCc] = useState<YtVideo[]>([]);
  const [archive, setArchive] = useState<ArchiveRow[]>([]);
  const [srcSources, setSrcSources] = useState<Source[]>([]);
  const [searching, setSearching] = useState(false);

  const [files, setFiles] = useState<ArchiveFile[]>([]);
  const [filesFor, setFilesFor] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);

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

  // 직접 받아온 소재 (국내 공공 아카이브는 API 가 없어 수동으로 받아 넣는다)
  const [myFiles, setMyFiles] = useState<SourceFile[]>([]);
  const [upOrigin, setUpOrigin] = useState("");
  const [upLicense, setUpLicense] = useState("공공누리 제1유형");
  const [uploading, setUploading] = useState(false);

  const loadMyFiles = useCallback(() => {
    fetch("/api/shorts/sources")
      .then((r) => r.json())
      .then((d) => setMyFiles(d.sources ?? []))
      .catch(() => {});
  }, []);

  async function uploadSource(file: File | undefined) {
    if (!file) return;
    if (!upOrigin.trim()) {
      setError("출처를 적어주세요. 공공누리는 출처 표시가 이용 조건입니다.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("origin", upOrigin);
      form.append("license", upLicense);
      const d = await (await fetch("/api/shorts/sources", { method: "POST", body: form })).json();
      if (!d.ok) setError(d.error ?? "업로드에 실패했습니다.");
      else loadMyFiles();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const loadJobs = useCallback(() => {
    fetch("/api/shorts/jobs")
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadJobs();
    loadMyFiles();
    loadTrending();
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

  async function loadTrending() {
    setLoadingTrend(true);
    setError("");
    try {
      const d = await (await fetch("/api/shorts/discover?mode=trending")).json();
      setTrending(d.videos ?? []);
      setTrendSources(d.sources ?? []);
      if (d.error) setError(d.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingTrend(false);
    }
  }

  async function searchSources() {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    setFiles([]);
    try {
      const d = await (
        await fetch(`/api/shorts/discover?mode=sources&q=${encodeURIComponent(query.trim())}`)
      ).json();
      setYtCc(d.youtube ?? []);
      setArchive(d.archive ?? []);
      setSrcSources(d.sources ?? []);
      if (d.error) setError(d.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function loadFiles(identifier: string) {
    setLoadingFiles(true);
    setFilesFor(identifier);
    try {
      const d = await (
        await fetch(`/api/shorts/discover?mode=files&identifier=${encodeURIComponent(identifier)}`)
      ).json();
      setFiles(d.files ?? []);
      if (d.error) setError(d.error);
    } finally {
      setLoadingFiles(false);
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
        지금 뜨는 주제를 찾고, <strong>가공해도 되는 소재</strong>를 골라, 인기 댓글과 자막을
        얹어 9:16 세로 영상으로 만듭니다.
      </p>

      {error && <div className="alert warn">{error}</div>}

      <div className="alert ok">
        <strong>남의 영상을 그대로 가공하지 않습니다.</strong> 인기 급상승은 무엇이 뜨는지
        보는 용도이고, 실제 소재는 CC 라이선스나 공개 도메인에서만 가져옵니다. 표준 라이선스
        영상을 내려받아 재업로드하면 저작권과 유튜브 약관 양쪽에 걸립니다.
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <button
            className={tab === "trend" ? "primary" : "ghost"}
            onClick={() => setTab("trend")}
          >
            1. 지금 뜨는 것
          </button>
          <button
            className={tab === "source" ? "primary" : "ghost"}
            onClick={() => setTab("source")}
          >
            2. 가공 가능한 소재
          </button>
        </div>

        {tab === "trend" ? (
          <>
            <div className="row">
              <button className="small" onClick={loadTrending} disabled={loadingTrend}>
                {loadingTrend && <span className="spinner" />}
                새로고침
              </button>
              {trendSources.map((s) => (
                <span key={s.id} className={`badge ${s.ok ? "on" : "off"}`}>
                  {s.label} · {s.message}
                </span>
              ))}
            </div>
            <p className="hint">
              여기 영상은 <strong>기획 근거</strong>입니다. 댓글은 가져다 쓸 수 있지만 영상
              자체는 대부분 가공할 수 없습니다.
            </p>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 70 }} />
                    <th>제목</th>
                    <th style={{ width: 90 }} className="num">조회수</th>
                    <th style={{ width: 60 }} className="num">길이</th>
                    <th style={{ width: 130 }}>라이선스</th>
                    <th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {trending.map((v) => (
                    <tr key={v.id}>
                      <td>
                        {/* 원격 썸네일이라 next/image 최적화 대상이 아니다 */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={v.thumbnail} alt="" style={{ width: 60, borderRadius: 4 }} />
                      </td>
                      <td>
                        <a href={v.url} target="_blank" rel="noreferrer">
                          {v.title}
                        </a>
                        <div className="dim" style={{ fontSize: 12 }}>{v.channel}</div>
                      </td>
                      <td className="num">{num(v.views)}</td>
                      <td className="num dim">{mmss(v.durationSec)}</td>
                      <td><LicenseBadge video={v} /></td>
                      <td>
                        <button className="small" onClick={() => loadComments(v.id, v.title)}>댓글
                        </button>{" "}<button className="small" onClick={() => loadHighlights(v.id, v.title)}>하이라이트</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="row">
              <div className="field" style={{ flex: 1, minWidth: 240 }}>
                <label>
                  소재 검색어
                  <Help text="가공해도 되는 소재만 찾습니다(CC 라이선스 · 공개 도메인).&#10;검색어는 영어로 넣으세요 — Internet Archive 와 유튜브 CC 자료는 대부분 영문 메타데이터입니다.&#10;아래 프리셋 버튼이 검증된 검색어를 넣어줍니다." />
                </label>
                <input
                  placeholder="nature, seoul, retro …"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && searchSources()}
                />
              </div>
              <button className="primary" onClick={searchSources} disabled={searching || !query.trim()}>
                {searching && <span className="spinner" />}
                검색
              </button>
              {srcSources.map((s) => (
                <span key={s.id} className={`badge ${s.ok ? "on" : "off"}`}>
                  {s.label} · {s.message}
                </span>
              ))}
            </div>

            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
                채널 방향:
              </span>
              {SEED_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="small ghost"
                  onClick={() => {
                    setQuery(p.q);
                    // 프리셋을 누르면 바로 찾아본다. 한 번 더 누르게 할 이유가 없다
                    setTimeout(searchSources, 0);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {ytCc.length > 0 && (
              <>
                <h2 style={{ marginTop: 16 }}>유튜브 CC 라이선스</h2>
                <p className="hint" style={{ marginTop: 0 }}>
                  재사용은 허용되지만 <strong>유튜브 약관상 다운로드는 별개</strong>입니다.
                  기획·참고용으로 보고, 실제 편집 소재는 아래 Archive 쪽을 쓰세요.
                </p>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {ytCc.map((v) => (
                        <tr key={v.id}>
                          <td style={{ width: 70 }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={v.thumbnail} alt="" style={{ width: 60, borderRadius: 4 }} />
                          </td>
                          <td>
                            <a href={v.url} target="_blank" rel="noreferrer">{v.title}</a>
                            <div className="dim" style={{ fontSize: 12 }}>
                              {v.channel} · {mmss(v.durationSec)}
                            </div>
                          </td>
                          <td style={{ width: 130 }}><LicenseBadge video={v} /></td>
                          <td style={{ width: 90 }}>
                            <button className="small" onClick={() => loadComments(v.id, v.title)}>댓글
                            </button>{" "}<button className="small" onClick={() => loadHighlights(v.id, v.title)}>하이라이트</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {archive.length > 0 && (
              <>
                <h2 style={{ marginTop: 16 }}>Internet Archive</h2>
                <p className="hint" style={{ marginTop: 0 }}>
                  <strong>표기 없음은 공개 도메인이 아닙니다.</strong> archive.org 는 누구나
                  올릴 수 있어서, 업로더가 라이선스를 안 적었을 뿐입니다. 실제로 방송사 뉴스
                  클립이 표기 없이 올라와 있습니다. 초록 배지(확인된 것)만 그대로 쓰고, 나머지는
                  항목 페이지에서 출처를 직접 확인하세요.
                </p>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {archive.map((a) => (
                        <tr key={a.identifier}>
                          <td style={{ width: 70 }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={a.thumbnail} alt="" style={{ width: 60, borderRadius: 4 }} />
                          </td>
                          <td>
                            <a href={a.detailUrl} target="_blank" rel="noreferrer">{a.title}</a>
                            <div className="dim" style={{ fontSize: 12 }}>
                              {a.creator} {a.year}
                            </div>
                          </td>
                          <td style={{ width: 200 }}>
                            <span className={`badge ${a.licenseConfirmed ? "on" : "off"}`}>
                              {a.license}
                            </span>
                          </td>
                          <td style={{ width: 100 }}>
                            <button className="small" onClick={() => loadFiles(a.identifier)}>
                              파일
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {(loadingFiles || files.length > 0) && (
              <div className="card" style={{ marginTop: 12 }}>
                <h2>
                  파일 선택 {loadingFiles && <span className="spinner" />}
                  <span className="dim" style={{ fontSize: 12 }}> {filesFor}</span>
                </h2>
                <p className="hint" style={{ marginTop: 0 }}>
                  쇼츠로 자를 거라 최고 화질이 필요하지 않습니다. 용량이 작은 쪽이 받는 시간이
                  짧아 먼저 나옵니다.
                </p>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {files.map((f) => (
                        <tr key={f.name}>
                          <td>{f.name}</td>
                          <td style={{ width: 120 }} className="dim">{f.format}</td>
                          <td style={{ width: 80 }} className="num dim">
                            {f.sizeBytes ? `${Math.round(f.sizeBytes / 1024 / 1024)}MB` : "—"}
                          </td>
                          <td style={{ width: 70 }} className="num dim">{mmss(f.durationSec)}</td>
                          <td style={{ width: 80 }}>
                            <button className="small primary" onClick={() => setInput(f.downloadUrl)}>
                              쓰기
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>내 소재 {myFiles.length > 0 && <span className="badge on">{myFiles.length}</span>}</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          국내 공공 아카이브는 API 가 없어 직접 받아 넣습니다. <strong>e영상역사관</strong>
          (대한뉴스)은 <strong>공공누리 제1유형</strong>이라 상업적 편집이 허용되지만,
          다운로드가 KTV 나누리 회원가입 + 영상 요청이라 자동화가 안 됩니다. 한 번 받아두면
          계속 씁니다.
        </p>

        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>
              출처 (발행 설명란에 그대로 쓸 문구)
              <Help text="영상 설명란에 그대로 붙여넣을 문구를 적으세요. 예: 국가기록원, 공공누리 제1유형.&#10;공공누리와 CC BY 는 출처 표시가 이용 조건이라, 적어두지 않으면 나중에 어디서 받았는지 알 수 없습니다." />
            </label>
            <input
              placeholder="e영상역사관 대한뉴스 제1234호 (국가기록원)"
              value={upOrigin}
              onChange={(e) => setUpOrigin(e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              라이선스
              <Help text="받아온 자료에 표기된 이용 조건을 고르세요. 확실하지 않으면 원본 페이지에서 먼저 확인하세요 — 표기가 없는 것은 공개 도메인이 아니라 '확인되지 않음' 입니다." />
            </label>
            <select value={upLicense} onChange={(e) => setUpLicense(e.target.value)}>
              <option>공공누리 제1유형</option>
              <option>공개 도메인 (CC0)</option>
              <option>CC BY</option>
              <option>직접 촬영</option>
            </select>
          </div>
          <label
            className="small ghost"
            style={{ cursor: "pointer", padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 8, alignSelf: "flex-end" }}
          >
            {uploading && <span className="spinner" />}
            {uploading ? "올리는 중" : "영상 올리기"}
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska"
              style={{ display: "none" }}
              onChange={(e) => {
                uploadSource(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>

        {myFiles.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <tbody>
                {myFiles.map((f) => (
                  <tr key={f.name}>
                    <td>
                      {f.originalName}
                      <div className="dim" style={{ fontSize: 12 }}>
                        {f.origin || "출처 미기재"}
                      </div>
                    </td>
                    <td style={{ width: 150 }}>
                      <span className={`badge ${f.license ? "on" : "off"}`}>
                        {f.license || "미기재"}
                      </span>
                    </td>
                    <td style={{ width: 80 }} className="num dim">
                      {Math.round(f.sizeBytes / 1024 / 1024)}MB
                    </td>
                    <td style={{ width: 130 }}>
                      <button className="small primary" onClick={() => setInput(f.path)}>
                        쓰기
                      </button>{" "}
                      <button
                        className="small ghost"
                        onClick={async () => {
                          if (!confirm(`${f.originalName} 을 삭제할까요?`)) return;
                          await fetch(`/api/shorts/sources?name=${encodeURIComponent(f.name)}`, {
                            method: "DELETE",
                          });
                          loadMyFiles();
                        }}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
              원본 주소 (Archive 파일에서 &lsquo;쓰기&rsquo; 를 누르면 채워집니다)
              <Help text="로컬 파일 경로나 http(s) 주소를 넣습니다. Archive 직링크를 그대로 써도 됩니다.&#10;위 소재 목록에서 '쓰기' 를 누르면 자동으로 채워집니다." />
            </label>
            <input
              className="mono"
              placeholder="https://archive.org/download/... 또는 로컬 파일 경로"
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
