"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { copyText } from "@/lib/clipboard";
import type { Channel } from "@/lib/seeds";

type PostRow = {
  id: number;
  channel?: Channel;
  main_keyword: string;
  sub_keyword: string;
  title: string;
  meta_desc?: string;
  /** jsonb 컬럼이라 배열로 온다. SQLite 시절의 JSON 문자열이 아니다 */
  tags: string[] | string;
  status: string;
  posted_naver: boolean | number;
  posted_tistory: boolean | number;
  created_at?: string;
  updated_at: string;
};

const CHANNELS: { id: Channel; label: string }[] = [
  { id: "naver", label: "네이버" },
  { id: "tistory", label: "티스토리" },
];

function toChannel(v: string | null): Channel {
  return v === "naver" ? "naver" : "tistory";
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

function PostsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const channel = toChannel(params.get("channel"));
  const field = channel === "naver" ? "posted_naver" : "posted_tistory";

  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch(`/api/posts?channel=${channel}`)
      .then((r) => r.json())
      .then((d) => {
        setPosts(d.posts ?? []);
        if (d.ok === false && d.error) setError(d.error);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [channel]);

  useEffect(load, [load]);

  function pick(next: Channel) {
    if (next === channel) return;
    router.replace(`${pathname}?channel=${next}`, { scroll: false });
  }

  async function toggle(post: PostRow) {
    const next = !post[field];
    setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, [field]: next } : p)));
    await fetch(`/api/posts/${post.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: next }),
    });
  }

  async function remove(id: number) {
    if (!confirm("이 글을 삭제할까요? 되돌릴 수 없습니다.")) return;
    await fetch(`/api/posts/${id}`, { method: "DELETE" });
    load();
  }

  const label = channel === "naver" ? "네이버" : "티스토리";

  return (
    <>
      <h1 className="page-title">글 목록</h1>
      <p className="page-desc">채널별 초안과 발행 여부. 발행 체크는 수동 기록용.</p>

      <div className="segment full" role="tablist" aria-label="채널" style={{ marginBottom: 16 }}>
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={channel === c.id}
            className={channel === c.id ? "on" : ""}
            onClick={() => pick(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="empty">
            <span className="spinner" />
            불러오는 중…
          </div>
        ) : posts.length === 0 ? (
          <div className="empty">
            아직 글이 없습니다. 지금은 키워드를 모으는 중입니다 —{" "}
            <Link href="/keywords">키워드 탐색</Link>에서 모은 키워드를 보세요.
          </div>
        ) : (
          posts.map((p) => {
            const tags = tagList(p.tags);
            const posted = Boolean(p[field]);
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
                    className={`small ${posted ? channel : ""}`}
                    onClick={() => toggle(p)}
                    title={`${label}에 올렸는지 직접 체크하는 칸입니다. 붙여넣고 발행한 뒤 눌러 기록하세요`}
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

export default function PostsPage() {
  // useSearchParams 는 Suspense 경계가 필요하다
  return (
    <Suspense fallback={<div className="empty">불러오는 중…</div>}>
      <PostsInner />
    </Suspense>
  );
}
