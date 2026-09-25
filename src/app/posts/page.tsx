"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { copyText } from "@/lib/clipboard";
import Help from "@/components/Help";

/** 전부 티스토리 글이다. 행에 channel·posted_naver 가 남아 있어도 보지 않는다 */
type PostRow = {
  id: number;
  main_keyword: string;
  sub_keyword: string;
  title: string;
  meta_desc?: string;
  /** jsonb 컬럼이라 배열로 온다. SQLite 시절의 JSON 문자열이 아니다 */
  tags: string[] | string;
  status: string;
  posted_tistory: boolean | number;
  created_at?: string;
  updated_at: string;
};

/** 저장 시점에 따라 배열이거나 JSON 문자열이라 양쪽을 받아준다 */
function tagList(tags: PostRow["tags"]): string[] {
  if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(tags || "[]");
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 글감 큐 한 줄. 매일 아침 초안이 위에서부터 하나씩 나온다 */
type QueueItem = {
  keyword: string;
  note?: string;
  /** 초안이 이미 만들어졌으면 true. postId 가 그 글이다 */
  done?: boolean;
  postId?: number;
};

/** 다음에 쓸 키워드 순서. 바꿀 때마다 통째로 POST 한다 */
function QueueCard() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");

  useEffect(() => {
    fetch("/api/queue")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok === false) throw new Error(d.error ?? "불러오지 못했습니다.");
        setQueue(Array.isArray(d.queue) ? d.queue : []);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  /** 화면을 먼저 바꾸고 저장한다. 실패하면 되돌린다 */
  async function commit(next: QueueItem[]) {
    const prev = queue;
    setQueue(next);
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queue: next }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? "저장하지 못했습니다.");
      if (Array.isArray(d.queue)) setQueue(d.queue);
    } catch (e) {
      setQueue(prev);
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= queue.length) return;
    const next = [...queue];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  }

  function add() {
    const keyword = input.trim();
    if (!keyword) return;
    if (queue.some((q) => q.keyword === keyword && !q.done)) {
      setError(`"${keyword}" 는 이미 큐에 있습니다.`);
      return;
    }
    setInput("");
    commit([...queue, { keyword }]);
  }

  const waiting = queue.filter((q) => !q.done).length;

  return (
    <div className="card">
      <h2>
        글감 큐
        {waiting > 0 && <span className="badge accent">대기 {waiting}</span>}
        {saving && <span className="spinner" />}
        <Help text="매일 아침 초안이 이 순서대로 하나씩 나옵니다. 큐가 비면 기회 검색어 → 모은 키워드 순으로 고릅니다." />
      </h2>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="empty">
          <span className="spinner" />
          불러오는 중…
        </div>
      ) : queue.length === 0 ? (
        <div className="empty">
          큐가 비어 있습니다. 아래에 키워드를 넣거나 <Link href="/analytics">성과</Link>의
          기회 검색어에서 추가하세요.
        </div>
      ) : (
        queue.map((q, i) => (
          <div key={`${q.keyword}-${i}`} className="list-item entry">
            <div className="entry-main">
              <div className="visit-line">
                <span className="entry-num dim">{i + 1}</span>
                <span className="entry-title" style={q.done ? { color: "var(--text-dim)" } : undefined}>
                  {q.keyword}
                </span>
                {q.done &&
                  (q.postId ? (
                    <Link href={`/write?post=${q.postId}`} className="badge on">
                      작성됨 #{q.postId}
                    </Link>
                  ) : (
                    <span className="badge on">작성됨</span>
                  ))}
              </div>
              {q.note && <div className="entry-sub">{q.note}</div>}
            </div>
            <div className="entry-side">
              <button
                className="small ghost"
                onClick={() => move(i, -1)}
                disabled={saving || i === 0}
                aria-label="위로"
                title="위로"
              >
                ▲
              </button>
              <button
                className="small ghost"
                onClick={() => move(i, 1)}
                disabled={saving || i === queue.length - 1}
                aria-label="아래로"
                title="아래로"
              >
                ▼
              </button>
              <button
                className="small ghost danger"
                onClick={() => commit(queue.filter((_, k) => k !== i))}
                disabled={saving}
              >
                삭제
              </button>
            </div>
          </div>
        ))
      )}

      <form
        className="row queue-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          placeholder="다음에 쓸 키워드"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          enterKeyHint="done"
        />
        <button type="submit" className="primary" disabled={saving || !input.trim()}>
          추가
        </button>
      </form>
    </div>
  );
}

export default function PostsPage() {
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch("/api/posts")
      .then((r) => r.json())
      .then((d) => {
        setPosts(d.posts ?? []);
        if (d.ok === false && d.error) setError(d.error);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function toggle(post: PostRow) {
    const next = !post.posted_tistory;
    setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, posted_tistory: next } : p)));
    await fetch(`/api/posts/${post.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ posted_tistory: next }),
    });
  }

  async function remove(id: number) {
    if (!confirm("이 글을 삭제할까요? 되돌릴 수 없습니다.")) return;
    await fetch(`/api/posts/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <>
      <h1 className="page-title">티스토리</h1>
      <p className="page-desc">키워드에서 만든 초안과 발행 여부. 발행 체크는 수동 기록용.</p>

      <QueueCard />

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="empty">
            <span className="spinner" />
            불러오는 중…
          </div>
        ) : posts.length === 0 ? (
          <div className="empty">
            아직 글이 없습니다. 지금은 키워드를 모으는 중입니다.{" "}
            <Link href="/keywords">키워드 탐색</Link>에서 모은 키워드를 보세요.
          </div>
        ) : (
          posts.map((p) => {
            const tags = tagList(p.tags);
            const posted = Boolean(p.posted_tistory);
            return (
              <div key={p.id} className="list-item entry">
                <div className="entry-main">
                  <Link href={`/write?post=${p.id}`} className="entry-title">
                    {p.title || "(제목 없음)"}
                  </Link>
                  <div className="entry-sub">
                    {p.main_keyword}
                    {p.sub_keyword ? ` + ${p.sub_keyword}` : ""}
                    {p.updated_at ? ` · ${p.updated_at.slice(0, 10)}` : ""}
                  </div>
                </div>
                <div className="entry-side">
                  <button
                    className={`small ${posted ? "tistory" : ""}`}
                    onClick={() => toggle(p)}
                    title={`티스토리에 올렸는지 직접 체크하는 칸입니다. 붙여넣고 발행한 뒤 눌러 기록하세요`}
                  >
                    {posted ? "발행함" : "안 올림"}
                  </button>
                  {tags.length > 0 && (
                    <button
                      className="small ghost"
                      title={tags.map((t) => `#${t}`).join(" ")}
                      onClick={() =>
                        copyText(tags.map((t) => `#${t}`).join(" ")).then(() => {
                          // 복사는 눈에 보이는 변화가 없어서, 눌린 행만 잠깐 표시한다
                          setCopied(p.id);
                          setTimeout(() => setCopied((c) => (c === p.id ? null : c)), 1600);
                        })
                      }
                    >
                      {copied === p.id ? "복사됨" : `태그 ${tags.length}`}
                    </button>
                  )}
                  <button className="small ghost danger" onClick={() => remove(p.id)}>
                    삭제
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
