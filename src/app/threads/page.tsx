"use client";

import { useCallback, useEffect, useState } from "react";
import Help from "@/components/Help";
import { copyText } from "@/lib/clipboard";

/**
 * 쓰레드 — 제휴 게시물 후보.
 *
 * 글 목록과 따로 둔다. 블로그 글은 2,000자짜리 한 편을 오래 다듬어 발행하고,
 * 여기는 500자짜리를 여러 개 만들어 그날 올릴 것만 고른다. 한 목록에 두면 긴 글이
 * 짧은 글에 묻히고, 상태(초안·올림)도 서로 다른 뜻이 된다.
 *
 * 후보를 만드는 건 깃액션이다. 매일 아침 네이버 검색광고에서 상품 키워드를 뽑고
 * Gemini 로 초안을 써서 여기에 넣는다. 이 화면은 고르고 손질하고 올림 표시만 한다.
 */

type ThreadsPost = {
  id: number;
  keyword: string;
  searches: number | null;
  bid: number | null;
  angle: string;
  hooks: string[];
  draft: string;
  checklist: string[];
  affiliate_url: string;
  status: string;
  posted_at: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "초안",
  ready: "올릴 준비",
  posted: "올림",
  dropped: "보류",
};

function num(n: number | null): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

/** 공정위 고지 문구. 제휴 링크를 붙이는 이상 빠뜨릴 수 없다 */
const DISCLOSURE =
  "이 게시물은 제휴 마케팅 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.";

/** 초안에 남겨둔 소감 자리. 이게 남아 있으면 아직 올릴 준비가 안 된 것이다 */
const SOAM_PLACEHOLDER = "[여기에 직접 써본 소감";

export default function ThreadsPage() {
  const [posts, setPosts] = useState<ThreadsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<"open" | "all">("open");
  /* 펼쳐서 손질 중인 후보. 한 번에 하나만 연다 */
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [link, setLink] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await (await fetch("/api/threads")).json();
      setPosts(d.posts ?? []);
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

  async function patch(id: number, body: Record<string, unknown>) {
    setError("");
    try {
      const res = await fetch("/api/threads", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setPosts((prev) => prev.map((p) => (p.id === id ? d.post : p)));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function remove(id: number) {
    setError("");
    try {
      const res = await fetch(`/api/threads?id=${id}`, { method: "DELETE" });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setPosts((prev) => prev.filter((p) => p.id !== id));
      if (openId === id) setOpenId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggle(p: ThreadsPost) {
    if (openId === p.id) {
      setOpenId(null);
      return;
    }
    setOpenId(p.id);
    setDraft(p.draft);
    setLink(p.affiliate_url);
  }

  /* 첫 줄 후보를 누르면 본문 맨 앞 줄을 그것으로 바꾼다 */
  function applyHook(hook: string) {
    setDraft((d) => {
      const rest = d.split("\n").slice(1).join("\n").replace(/^\n+/, "");
      return `${hook}\n\n${rest}`;
    });
  }

  const shown = posts.filter((p) =>
    filter === "open" ? p.status === "draft" || p.status === "ready" : true,
  );

  return (
    <>
      <h1 className="page-title">쓰레드</h1>
      <p className="page-desc">
        제휴 게시물 후보입니다. 매일 아침 깃액션이 네이버 검색광고에서 상품 키워드를 뽑아
        초안을 채웁니다. 여기서는 고르고 손질해서 올림 표시만 하세요.
      </p>

      <div className="alert warn">
        <strong>써보지 않은 제품의 후기를 지어내지 마세요.</strong> 초안에{" "}
        <span className="mono">[여기에 직접 써본 소감 한 줄]</span> 자리가 비어 있습니다.
        실제로 써본 뒤 채우세요 — 안 써본 제품의 1인칭 후기는 표시광고법상 기만적
        표시·광고입니다. 제휴 링크를 넣으면 공정위 고지 문구도 반드시 함께 가야 합니다
        (복사 버튼이 자동으로 붙여줍니다).
      </div>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>
            후보 {shown.length}건
            <Help text="검색량이 큰 키워드부터 나옵니다. 광고 단가는 광고주가 그 키워드에 실제로 거는 돈이라, 높을수록 구매 의도가 높다고 봅니다.&#10;이미 올린 후보는 기본 목록에서 빠집니다." />
          </h2>
          <div className="row" style={{ gap: 6 }}>
            <button
              className={filter === "open" ? "small" : "small ghost"}
              onClick={() => setFilter("open")}
            >
              안 올린 것
            </button>
            <button
              className={filter === "all" ? "small" : "small ghost"}
              onClick={() => setFilter("all")}
            >
              전체
            </button>
            <button className="small ghost" onClick={load} disabled={loading}>
              {loading && <span className="spinner" />}
              새로고침
            </button>
          </div>
        </div>

        {!loading && !shown.length && (
          <div className="empty" style={{ marginTop: 12 }}>
            후보가 없습니다. 깃허브 Actions 에서 <strong>제휴 상품 후보 뽑기</strong> 를
            실행하면 채워집니다.
          </div>
        )}

        {shown.map((p) => (
          <div key={p.id} className="visual-item">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{p.keyword}</strong>{" "}
                <span className={`badge ${p.status === "posted" ? "on" : ""}`}>
                  {STATUS_LABEL[p.status] ?? p.status}
                </span>{" "}
                <span className="hint" style={{ margin: 0 }}>
                  검색 {num(p.searches)} · 단가 {num(p.bid)}원
                </span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="small ghost" onClick={() => toggle(p)}>
                  {openId === p.id ? "접기" : "손질"}
                </button>
                <button
                  className="small"
                  onClick={() =>
                    copyText(`${p.draft}\n\n${DISCLOSURE}`).then(() =>
                      flash("본문 + 고지 문구를 복사했습니다."),
                    )
                  }
                >
                  복사
                </button>
                <button className="small ghost" onClick={() => remove(p.id)}>
                  삭제
                </button>
              </div>
            </div>

            {p.angle && (
              <p className="hint" style={{ marginTop: 6 }}>
                {p.angle}
              </p>
            )}

            {openId === p.id && (
              <div style={{ marginTop: 10 }}>
                {p.hooks?.length > 0 && (
                  <div className="field">
                    <label>
                      첫 줄 후보
                      <Help text="쓰레드는 첫 줄이 전부입니다. 누르면 본문 첫 줄이 그것으로 바뀝니다." />
                    </label>
                    {p.hooks.map((h, i) => (
                      <button
                        key={i}
                        className="small ghost"
                        style={{
                          display: "block",
                          textAlign: "left",
                          marginBottom: 4,
                          whiteSpace: "normal",
                        }}
                        onClick={() => applyHook(h)}
                      >
                        {h}
                      </button>
                    ))}
                  </div>
                )}

                <div className="field" style={{ marginTop: 8 }}>
                  <label>본문</label>
                  <textarea rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <p className="hint" style={{ marginTop: 4 }}>
                    {draft.length}자 · 쓰레드는 500자까지
                    {draft.includes(SOAM_PLACEHOLDER) && (
                      <>
                        {" · "}
                        <strong>소감 자리가 아직 비어 있습니다</strong>
                      </>
                    )}
                  </p>
                </div>

                <div className="field">
                  <label>
                    제휴 링크
                    <Help text="쿠팡 파트너스나 토스 쉐어링크 주소를 넣습니다.&#10;쓰레드 본문에 제휴 링크를 직접 걸면 노출이 줄 수 있어, 프로필 링크(리틀리 등)에 모아두고 본문에서는 그쪽으로 유도하는 편이 안전합니다." />
                  </label>
                  <input
                    className="mono"
                    placeholder="쿠팡 파트너스 또는 토스 쉐어링크 주소"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                  />
                </div>

                {p.checklist?.length > 0 && (
                  <div className="field">
                    <label>올리기 전 확인</label>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {p.checklist.map((c, i) => (
                        <li key={i} style={{ fontSize: 13 }}>
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="primary"
                    onClick={async () => {
                      if (await patch(p.id, { draft, affiliate_url: link }))
                        flash("저장했습니다.");
                    }}
                  >
                    저장
                  </button>
                  <button
                    className="small"
                    onClick={async () => {
                      if (await patch(p.id, { draft, affiliate_url: link, status: "posted" }))
                        flash("올림으로 표시했습니다.");
                    }}
                  >
                    올림으로 표시
                  </button>
                  <button
                    className="small ghost"
                    onClick={async () => {
                      if (await patch(p.id, { status: "dropped" })) flash("보류했습니다.");
                    }}
                  >
                    보류
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
