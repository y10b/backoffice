"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { copyText } from "@/lib/clipboard";

type PostRow = {
  id: number;
  main_keyword: string;
  sub_keyword: string;
  title: string;
  /** jsonb 컬럼이라 배열로 온다. SQLite 시절의 JSON 문자열이 아니다 */
  tags: string[] | string;
  status: string;
  posted_naver: boolean | number;
  posted_tistory: boolean | number;
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

export default function PostsPage() {
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/posts")
      .then((r) => r.json())
      .then((d) => setPosts(d.posts ?? []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function toggle(post: PostRow, field: "posted_naver" | "posted_tistory") {
    const next = !post[field];
    setPosts((prev) =>
      prev.map((p) => (p.id === post.id ? { ...p, [field]: next } : p)),
    );
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

  return (
    <>
      <h1 className="page-title">글 목록</h1>
      <p className="page-desc">
        생성한 초안과 발행 여부를 관리합니다. 발행 체크는 수동 기록용입니다.
      </p>

      <div className="card">
        {loading ? (
          <div className="empty">
            <span className="spinner" />
            불러오는 중…
          </div>
        ) : posts.length === 0 ? (
          <div className="empty">
            아직 저장된 글이 없습니다. <Link href="/">키워드 탐색</Link>부터 시작하세요.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 45 }} className="num">
                  #
                </th>
                <th>제목</th>
                <th style={{ width: 170 }}>키워드</th>
                <th style={{ width: 60 }}>네이버</th>
                <th style={{ width: 70 }}>티스토리</th>
                <th style={{ width: 96 }}>태그</th>
                <th style={{ width: 100 }}>수정일</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.id}</td>
                  <td>
                    <Link href={`/write?post=${p.id}`}>{p.title || "(제목 없음)"}</Link>
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: 12 }}>
                    {p.main_keyword}
                    {p.sub_keyword ? ` + ${p.sub_keyword}` : ""}
                  </td>
                  <td>
                    <button
                      className={`small ${p.posted_naver ? "naver" : "ghost"}`}
                      onClick={() => toggle(p, "posted_naver")}
                    >
                      {p.posted_naver ? "완료" : "대기"}
                    </button>
                  </td>
                  <td>
                    <button
                      className={`small ${p.posted_tistory ? "tistory" : "ghost"}`}
                      onClick={() => toggle(p, "posted_tistory")}
                    >
                      {p.posted_tistory ? "완료" : "대기"}
                    </button>
                  </td>
                  <td>
                    {(() => {
                      const tags = tagList(p.tags);
                      if (!tags.length) return <span className="dim">—</span>;
                      return (
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
                      );
                    })()}
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: 12 }}>
                    {p.updated_at.slice(0, 10)}
                  </td>
                  <td>
                    <Link href={`/write?post=${p.id}`}>
                      <button className="small">열기</button>
                    </Link>{" "}
                    <button className="small ghost" onClick={() => remove(p.id)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
