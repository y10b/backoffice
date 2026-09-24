"use client";

import { useCallback, useEffect, useState } from "react";
import Help from "@/components/Help";

/**
 * 개발 로그 — 깃 이력에서 velog 글을 만들고, 승인한 것만 올린다.
 *
 * 원래 별도 레포 + 노션이었다. 검토가 노션에 있으면 나머지 화면과 갈리므로 여기로
 * 합쳤다. 만드는 건 크론이다(수집 → 초안 → 발행 → 동기화). 이 화면은 읽고 고치고
 * 승인하는 자리이고, 크론이 안 돌았을 때 직접 돌리는 버튼이 있다.
 */

type PostRow = {
  id: number;
  title: string;
  tags: string[];
  source: string;
  from_private: boolean;
  auto_generated: boolean;
  status: string;
  url: string;
  error: string;
  likes: number;
  comments: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

type PostFull = PostRow & { body_markdown: string };

type LogRow = {
  id: number;
  date: string;
  repo: string;
  private: boolean;
  commit_count: number;
  messages: string[];
  topics: string[];
  score: number;
  consumed: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "검토 대기",
  approved: "발행 승인",
  published: "발행됨",
  dropped: "보류",
};

const TASKS: { id: "collect" | "draft" | "publish" | "sync"; label: string; help: string }[] = [
  { id: "collect", label: "오늘 커밋 수집", help: "오늘(KST) 내 커밋을 레포별로 모아 아래 개발 로그에 쌓습니다. 회사 레포는 설정의 차단 목록으로 걸러집니다. 매일 21시에 자동으로 돕니다." },
  { id: "draft", label: "초안 만들기", help: "지난 7일 로그 중 글감 점수 3 이상에서 가장 큰 덩어리 하나를 골라 초안을 씁니다. 커밋이 없으면 만들지 않습니다. 일요일 10시에 자동으로 돕니다." },
  { id: "publish", label: "승인된 글 발행", help: "상태가 '발행 승인'인 글을 velog 에 올립니다. 본문에 TODO 가 남아 있거나 200자 미만이면 올리지 않습니다. 매일 7시에 자동으로 돕니다." },
  { id: "sync", label: "velog 동기화", help: "velog 에 올라간 공개 글을 되돌려 채우고 좋아요·댓글 수를 갱신합니다. 손으로 올린 글도 여기 이력에 들어옵니다. 매일 22시에 자동으로 돕니다." },
];

function summarize(task: string, r: any): string {
  if (task === "collect") {
    const found = (r.found ?? []) as { repo: string; commits: number; score: number }[];
    if (!found.length) return `${r.date}: 커밋 없음. 아무것도 만들지 않았습니다.`;
    return `${r.date}: ${found.map((f) => `${f.repo.split("/")[1]} ${f.commits}개(점수 ${f.score})`).join(", ")} — 새로 ${r.inserted}건`;
  }
  if (task === "draft") return r.made ? `초안 생성: ${r.title} (${r.repo} · 커밋 ${r.commits}개 · ${r.ai ? "모델 작성" : "뼈대만"})` : r.reason;
  if (task === "publish") {
    const p = r.published?.length ?? 0;
    const f = r.failed?.length ?? 0;
    if (!p && !f) return "발행 승인된 글이 없습니다.";
    return `발행 ${p}건${f ? ` · 실패 ${f}건 (글에 사유를 남겼습니다)` : ""}`;
  }
  if (task === "sync") return `velog 공개글 ${r.total}건 · 새로 ${r.created} · 연결 ${r.linked} · 반응 갱신 ${r.refreshed}`;
  return JSON.stringify(r);
}

export default function DevlogPage() {
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState("");

  /* 펼쳐서 손질 중인 글. 본문은 목록에 없어서 열 때 따로 받는다 */
  const [openId, setOpenId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [showLog, setShowLog] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await (await fetch("/api/devlog")).json();
      setPosts(d.posts ?? []);
      setLogs(d.logs ?? []);
      if (d.error) setError(d.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  }

  async function run(task: (typeof TASKS)[number]["id"]) {
    setRunning(task);
    setError("");
    try {
      const res = await fetch("/api/devlog/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setLastRun(summarize(task, d.result));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  }

  async function open(p: PostRow) {
    if (openId === p.id) {
      setOpenId(null);
      return;
    }
    setError("");
    try {
      const d = await (await fetch(`/api/devlog?id=${p.id}`)).json();
      if (!d.ok) throw new Error(d.error);
      const full = d.post as PostFull;
      setOpenId(p.id);
      setTitle(full.title);
      setBody(full.body_markdown);
      setTags(full.tags.join(", "));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function patch(id: number, patchBody: Record<string, unknown>) {
    setError("");
    try {
      const res = await fetch("/api/devlog", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...patchBody }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, ...d.post } : p)));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function remove(id: number) {
    if (!confirm("이 글을 삭제할까요? velog 에 올라간 글은 그대로 남습니다.")) return;
    setError("");
    try {
      const res = await fetch(`/api/devlog?id=${id}`, { method: "DELETE" });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setPosts((prev) => prev.filter((p) => p.id !== id));
      if (openId === id) setOpenId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const edited = () => ({
    title,
    body_markdown: body,
    tags: tags.split(/[,\s#]+/).map((t) => t.trim()).filter(Boolean),
  });

  const shown = posts.filter((p) =>
    filter === "open" ? p.status === "draft" || p.status === "approved" : true,
  );
  const todo = body.match(/^>\s*TODO/gm)?.length ?? 0;

  return (
    <>
      <h1 className="page-title">개발 로그</h1>
      <p className="page-desc">
        깃 커밋에서 velog 글 초안을 만듭니다. 발행 전에 여기서 한 번 읽고{" "}
        <strong>발행 승인</strong>으로 바꿔야 다음 아침에 올라갑니다.
      </p>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="card">
        <h2>
          직접 실행
          <Help text="크론이 매일 알아서 돕니다. 지금 당장 보고 싶거나 크론이 실패했을 때만 누르세요." />
        </h2>
        <div className="row">
          {TASKS.map((t) => (
            <button key={t.id} onClick={() => run(t.id)} disabled={running !== null}>
              {running === t.id && <span className="spinner" />}
              {t.label}
              <Help text={t.help} />
            </button>
          ))}
        </div>
        {lastRun && <p className="hint">{lastRun}</p>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>
            글 {shown.length}건
            <Help text="검토 대기 → 발행 승인 → 발행됨 순서로 갑니다. 발행됨은 velog 동기화가 반응(좋아요·댓글)을 채워 줍니다." />
          </h2>
          <div className="row" style={{ gap: 6 }}>
            <button className={filter === "open" ? "small" : "small ghost"} onClick={() => setFilter("open")}>
              검토할 것
            </button>
            <button className={filter === "all" ? "small" : "small ghost"} onClick={() => setFilter("all")}>
              전체
            </button>
            <button className="small ghost" onClick={load} disabled={loading}>
              {loading && <span className="spinner" />}
              새로고침
            </button>
          </div>
        </div>

        {!loading && !shown.length && (
          <div className="empty">
            {filter === "open" ? "검토할 글이 없습니다. 일요일에 초안이 생깁니다." : "아직 글이 없습니다."}
          </div>
        )}

        {shown.map((p) => (
          <div key={p.id} className="list-item">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong>{p.title || "(제목 없음)"}</strong>{" "}
                <span className={`badge ${p.status === "published" ? "on" : p.status === "approved" ? "accent" : ""}`}>
                  {STATUS_LABEL[p.status] ?? p.status}
                </span>
                {p.from_private && <span className="badge off" style={{ marginLeft: 4 }}>비공개 레포</span>}
                <div className="hint" style={{ margin: "2px 0 0" }}>
                  {p.source}
                  {p.status === "published" && ` · 좋아요 ${p.likes} · 댓글 ${p.comments}`}
                </div>
                {p.error && <div className="hint" style={{ color: "var(--danger)" }}>발행 실패: {p.error}</div>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {p.url && (
                  <a href={p.url} target="_blank" rel="noreferrer">
                    <button className="small ghost">velog</button>
                  </a>
                )}
                <button className="small ghost" onClick={() => open(p)}>
                  {openId === p.id ? "접기" : "열기"}
                </button>
              </div>
            </div>

            {openId === p.id && (
              <div style={{ marginTop: 10 }}>
                {p.from_private && (
                  <div className="alert warn">
                    비공개 레포에서 나온 초안입니다. 공개해도 되는 내용인지 확인하세요.
                  </div>
                )}
                <div className="field">
                  <label>제목</label>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <label>
                    본문 (마크다운)
                    {todo > 0 && (
                      <span className="badge off" style={{ marginLeft: 6 }}>
                        TODO {todo}개
                      </span>
                    )}
                  </label>
                  <textarea rows={18} className="mono" value={body} onChange={(e) => setBody(e.target.value)} />
                  <p className="hint" style={{ marginTop: 4 }}>
                    {body.length}자 · 200자 미만이거나 TODO 가 남아 있으면 발행되지 않습니다.
                  </p>
                </div>
                <div className="field">
                  <label>태그 (쉼표로 구분)</label>
                  <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Next.js, 자동화" />
                </div>

                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="primary"
                    onClick={async () => {
                      if (await patch(p.id, edited())) flash("저장했습니다.");
                    }}
                  >
                    저장
                  </button>
                  {p.status !== "published" && p.status !== "approved" && (
                    <button
                      onClick={async () => {
                        if (await patch(p.id, { ...edited(), status: "approved" }))
                          flash("발행 승인. 다음 아침 7시에 올라갑니다.");
                      }}
                      disabled={todo > 0 || body.trim().length < 200}
                      title={todo > 0 ? "TODO 를 먼저 채우세요" : undefined}
                    >
                      발행 승인
                    </button>
                  )}
                  {p.status === "approved" && (
                    <button
                      onClick={async () => {
                        if (await patch(p.id, { ...edited(), status: "draft" })) flash("승인을 취소했습니다.");
                      }}
                    >
                      승인 취소
                    </button>
                  )}
                  {p.status !== "published" && (
                    <button
                      className="ghost"
                      onClick={async () => {
                        if (await patch(p.id, { status: "dropped" })) flash("보류했습니다.");
                      }}
                    >
                      보류
                    </button>
                  )}
                  <button className="ghost danger" onClick={() => remove(p.id)}>
                    삭제
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>
          최근 개발 로그
          <Help text="매일 21시에 그날 커밋을 레포별로 한 줄씩 쌓습니다. 점수는 글이 될 만한지 0~5 — 원인 규명이나 판단 전환이 보이는 날이 높습니다. 초안에 쓰인 줄은 '소비됨'으로 표시됩니다." />
        </h2>
        {!loading && !logs.length && <div className="empty">아직 수집된 커밋이 없습니다.</div>}
        {logs.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 100 }}>날짜</th>
                  <th>레포</th>
                  <th className="num" style={{ width: 60 }}>커밋</th>
                  <th style={{ width: 160 }}>주제</th>
                  <th className="num" style={{ width: 50 }}>점수</th>
                  <th style={{ width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className={showLog === l.id ? "picked-row" : ""} onClick={() => setShowLog(showLog === l.id ? null : l.id)} style={{ cursor: "pointer" }}>
                    <td className="dim">{l.date}</td>
                    <td>
                      {l.repo.split("/")[1]}
                      {l.private && <span className="badge" style={{ marginLeft: 5 }}>비공개</span>}
                    </td>
                    <td className="num">{l.commit_count}</td>
                    <td className="dim">{l.topics.join(" · ") || "—"}</td>
                    <td className="num">{l.score}</td>
                    <td className="dim">{l.consumed ? "소비됨" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showLog !== null && (
          <pre style={{ marginTop: 10 }}>
            {(logs.find((l) => l.id === showLog)?.messages ?? []).map((m) => `- ${m}`).join("\n")}
          </pre>
        )}
      </div>
    </>
  );
}
