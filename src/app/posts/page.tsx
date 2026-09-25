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
  /** 들어갈 카테고리 추정. 마이그레이션 전 행·수동 저장분은 빈 문자열 */
  category?: string;
  /** 기존 글 보강 초안이면 그 글 URL */
  rewrite_of?: string;
};

/** 재편 기준 카테고리 → 배지 색. 여기 없는 이름(옛 카테고리·미분류)은 기본 회색 */
const CATEGORY_CLASS: Record<string, string> = {
  "세금·신고": "cat-tax",
  "보험·연금": "cat-insurance",
  "지원금·수당": "cat-support",
  기타: "cat-etc",
};
const FIXED_CATEGORIES = Object.keys(CATEGORY_CLASS);

function CategoryBadge({ name }: { name?: string }) {
  const label = name?.trim() || "미분류";
  return <span className={`badge ${CATEGORY_CLASS[label] ?? ""}`}>{label}</span>;
}

/** 퍼센트 인코딩된 글 주소 → 사람이 읽는 제목 대용 (제목이 비었을 때) */
function readableUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/entry\//, ""));
  } catch {
    return url;
  }
}

type TistoryPost = {
  url: string;
  title: string;
  category: string;
  published_at: string | null;
  views: number;
  sessions: number;
  impressions: number;
  clicks: number;
  position: number | null;
};

const fmt = (n: number) => n.toLocaleString("ko-KR");

/** 2행 보조 줄 — 값이 없는(0·null) 항목은 뺀다 */
function statLine(p: TistoryPost): string {
  const parts: string[] = [];
  if (p.published_at) parts.push(p.published_at.slice(0, 10));
  if (p.views) parts.push(`조회 ${fmt(p.views)}`);
  if (p.impressions) parts.push(`노출 ${fmt(p.impressions)}`);
  if (p.position !== null && p.position !== undefined && p.impressions) parts.push(`평균 ${p.position}위`);
  return parts.join(" · ");
}

/** 실제로 올라간 티스토리 글. 사이트맵에서 읽은 것이라 초안(아래 목록)과 별개다 */
function PublishedCard() {
  const [posts, setPosts] = useState<TistoryPost[]>([]);
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    return fetch("/api/tistory")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok === false) throw new Error(d.error ?? "불러오지 못했습니다.");
        setPosts(Array.isArray(d.posts) ? d.posts : []);
        setCategories(Array.isArray(d.categories) ? d.categories : []);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const d = await fetch("/api/tistory/sync", { method: "POST" }).then((r) => r.json());
      if (!d.ok) throw new Error(d.error ?? "동기화하지 못했습니다.");
      setSyncNote({
        ok: !d.failed,
        text: `글 ${d.total}개 · 새로 읽음 ${d.updated}${d.failed ? ` · 못 읽음 ${d.failed}` : ""}`,
      });
      await load();
    } catch (e) {
      setSyncNote({ ok: false, text: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  }

  // 고정 넷은 늘 보이고(0 이어도), 그 외 실제로 있는 카테고리(옛 이름·미분류)를 뒤에 붙인다
  const countOf = (name: string) => categories.find((c) => c.name === name)?.count ?? 0;
  // key null = 전체. 빈 문자열은 카테고리를 못 읽은 글(미분류)이라 전체와 구분한다
  const tabs: { key: string | null; label: string; count: number }[] = [
    { key: null, label: "전체", count: posts.length },
    ...FIXED_CATEGORIES.map((name) => ({ key: name, label: name, count: countOf(name) })),
    ...categories
      .filter((c) => !FIXED_CATEGORIES.includes(c.name))
      .map((c) => ({ key: c.name, label: c.name || "미분류", count: c.count })),
  ];
  const shown = filter === null ? posts : posts.filter((p) => p.category === filter);

  return (
    <div className="card">
      <h2>
        올라간 글
        {posts.length > 0 && <span className="badge accent">{posts.length}</span>}
        <Help text="매일 아침 9시 30분 유입 데이터와 함께 티스토리 사이트맵에서 새로 읽습니다. 비공개 글은 보이지 않습니다. 조회·노출은 최근 90일 합계입니다." />
        <button className="small" onClick={syncNow} disabled={syncing} style={{ marginLeft: "auto" }}>
          {syncing && <span className="spinner" />}
          {syncing ? "읽는 중…" : "동기화"}
        </button>
      </h2>

      {syncNote && <div className={`alert ${syncNote.ok ? "ok" : "error"}`}>{syncNote.text}</div>}
      {error && <div className="alert error">{error}</div>}

      {posts.length > 0 && (
        <div className="segment scroll" role="tablist" aria-label="카테고리" style={{ marginBottom: 8 }}>
          {tabs.map((t) => {
            const on = filter === t.key;
            return (
              <button
                key={t.key === null ? "all" : `cat-${t.key}`}
                role="tab"
                aria-selected={on}
                className={on ? "on" : ""}
                onClick={() => setFilter(t.key)}
              >
                {t.label} {t.count}
              </button>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="empty">
          <span className="spinner" />
          불러오는 중…
        </div>
      ) : posts.length === 0 ? (
        <div className="empty">아직 읽어 온 글이 없습니다. 동기화를 눌러 사이트맵에서 가져오세요.</div>
      ) : shown.length === 0 ? (
        <div className="empty">이 카테고리에 글이 없습니다.</div>
      ) : (
        shown.map((p) => {
          const sub = statLine(p);
          return (
            <div key={p.url} className="list-item">
              <div className="entry-line">
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="entry-title">
                  {p.title || readableUrl(p.url)}
                </a>
                <CategoryBadge name={p.category} />
              </div>
              {sub && <div className="entry-sub">{sub}</div>}
            </div>
          );
        })
      )}
    </div>
  );
}

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

      <PublishedCard />

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
                  <div className="visit-line" style={{ marginTop: 4 }}>
                    <CategoryBadge name={p.category} />
                    {p.rewrite_of && (
                      <>
                        <span className="badge accent">기존 글 보강</span>
                        <a
                          href={p.rewrite_of}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="entry-sub"
                          style={{ marginTop: 0 }}
                        >
                          {readableUrl(p.rewrite_of)}
                        </a>
                        <Help text="같은 주제의 글이 이미 있습니다. 새 글로 올리지 말고 기존 글을 열어 수정 → 본문을 이 초안으로 교체하세요. 주소가 그대로라 쌓인 순위가 유지됩니다." />
                      </>
                    )}
                  </div>
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
