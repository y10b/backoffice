"use client";

import { useCallback, useEffect, useState } from "react";

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
  url: string;
};

type ArchiveRow = {
  identifier: string;
  title: string;
  creator: string;
  year: string;
  license: string;
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
type Source = { id: string; label: string; ok: boolean; message: string };
type Short = { name: string; url: string; sizeBytes: number; createdAt: string };

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

function mmss(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 재사용 가능 여부를 한눈에. 이 구분이 이 화면의 핵심이다 */
function LicenseBadge({ license }: { license: string | null }) {
  const reusable = license === "creativeCommon";
  return (
    <span className={`badge ${reusable ? "on" : "off"}`}>
      {reusable ? "CC · 가공 가능" : "표준 · 가공 불가"}
    </span>
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

  // 렌더 입력
  const [input, setInput] = useState("");
  const [startSec, setStartSec] = useState(0);
  const [durationSec, setDurationSec] = useState(30);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [picked, setPicked] = useState<Comment | null>(null);

  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [ffmpeg, setFfmpeg] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const [shorts, setShorts] = useState<Short[]>([]);

  const loadShorts = useCallback(() => {
    fetch("/api/shorts/render")
      .then((r) => r.json())
      .then((d) => {
        setFfmpeg(d.ffmpeg ?? null);
        setShorts(d.shorts ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadShorts();
    loadTrending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function render() {
    if (!input.trim()) {
      setError("원본 영상 주소를 넣으세요. 소재 목록에서 고르면 자동으로 채워집니다.");
      return;
    }
    setRendering(true);
    setError("");
    try {
      const res = await fetch("/api/shorts/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: input.trim(),
          startSec,
          durationSec,
          title,
          caption,
          comment: picked ? { author: picked.author, text: picked.text } : undefined,
        }),
      });
      const d = await res.json();
      if (!d.ok) {
        setError(d.error ?? "렌더에 실패했습니다.");
        return;
      }
      loadShorts();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRendering(false);
    }
  }

  async function removeShort(name: string) {
    if (!confirm(`${name} 을 삭제할까요?`)) return;
    await fetch(`/api/shorts/file/${encodeURIComponent(name)}`, { method: "DELETE" });
    loadShorts();
  }

  return (
    <>
      <h1 className="page-title">쇼츠</h1>
      <p className="page-desc">
        지금 뜨는 주제를 찾고, <strong>가공해도 되는 소재</strong>를 골라, 인기 댓글과 자막을
        얹어 9:16 세로 영상으로 만듭니다.
      </p>

      {ffmpeg && !ffmpeg.ok && <div className="alert error">{ffmpeg.error}</div>}
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
                      <td><LicenseBadge license={v.license} /></td>
                      <td>
                        <button className="small" onClick={() => loadComments(v.id, v.title)}>
                          댓글
                        </button>
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
                <label>소재 검색어</label>
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
                          <td style={{ width: 130 }}><LicenseBadge license={v.license} /></td>
                          <td style={{ width: 90 }}>
                            <button className="small" onClick={() => loadComments(v.id, v.title)}>
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

            {archive.length > 0 && (
              <>
                <h2 style={{ marginTop: 16 }}>Internet Archive · 다운로드 허용</h2>
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
                          <td style={{ width: 190 }}>
                            <span className="badge on">{a.license}</span>
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

      <div className="card">
        <h2>3. 렌더</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 300 }}>
            <label>원본 주소 (Archive 파일에서 &lsquo;쓰기&rsquo; 를 누르면 채워집니다)</label>
            <input
              className="mono"
              placeholder="https://archive.org/download/... 또는 로컬 파일 경로"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <div className="field">
            <label>시작(초)</label>
            <input
              type="number" min={0} style={{ width: 90 }}
              value={startSec}
              onChange={(e) => setStartSec(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>길이(초)</label>
            <input
              type="number" min={1} max={180} style={{ width: 90 }}
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>제목 (위 여백)</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>자막 (영상 안쪽 하단)</label>
            <input value={caption} onChange={(e) => setCaption(e.target.value)} />
          </div>
        </div>
        {picked && (
          <p className="hint">
            얹을 댓글: <strong>@{picked.author}</strong> — {picked.text.slice(0, 60)}
          </p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={render} disabled={rendering || !ffmpeg?.ok}>
            {rendering && <span className="spinner" />}
            {rendering ? "렌더 중 (수십 초)" : "쇼츠 만들기"}
          </button>
        </div>
      </div>

      {shorts.length > 0 && (
        <div className="card">
          <h2>만든 쇼츠 {shorts.length}개</h2>
          <div className="short-grid">
            {shorts.map((s) => (
              <div key={s.name} className="short-item">
                <video src={s.url} controls preload="metadata" />
                <div className="row" style={{ gap: 4, marginTop: 6 }}>
                  <a href={s.url} download>
                    <button className="small">저장</button>
                  </a>
                  <button className="small ghost" onClick={() => removeShort(s.name)}>
                    삭제
                  </button>
                  <span className="dim" style={{ fontSize: 11, alignSelf: "center" }}>
                    {Math.round(s.sizeBytes / 1024)}KB
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
