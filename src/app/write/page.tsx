"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { markdownToHtml, countChars } from "@/lib/markdown";
import { copyRichHtml, copyText } from "@/lib/clipboard";

type Suggestion = { subKeyword: string; title: string; reason: string };

function occurrences(haystack: string, needle: string): number {
  if (!needle.trim()) return 0;
  return haystack.split(needle).length - 1;
}

function WritePageInner() {
  const params = useSearchParams();

  const [mainKeyword, setMainKeyword] = useState("");
  const [subKeyword, setSubKeyword] = useState("");
  const [context, setContext] = useState<string[]>([]);
  const [tone, setTone] = useState("친근하지만 정보 밀도가 높은 정보성 블로그 문체");
  const [targetChars, setTargetChars] = useState(2000);
  const [outline, setOutline] = useState("");

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [postId, setPostId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState("");

  useEffect(() => {
    const main = params.get("main");
    if (main) setMainKeyword(main);
    const ctx = params.get("context");
    if (ctx) setContext(ctx.split("|").filter(Boolean));
    const id = params.get("post");
    if (id) {
      fetch(`/api/posts/${id}`)
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) return;
          const p = d.post;
          setPostId(p.id);
          setMainKeyword(p.main_keyword);
          setSubKeyword(p.sub_keyword);
          setTitle(p.title);
          setMetaDesc(p.meta_desc);
          setMarkdown(p.body_markdown);
          try {
            setTags(JSON.parse(p.tags));
          } catch {
            setTags([]);
          }
        });
    }
  }, [params]);

  const html = useMemo(() => markdownToHtml(markdown), [markdown]);
  const charCount = useMemo(() => countChars(html), [html]);
  const mainInTitle = mainKeyword.trim() ? title.includes(mainKeyword.trim()) : false;
  const subInTitle = subKeyword.trim() ? title.includes(subKeyword.trim()) : false;
  const mainInBody = occurrences(markdown, mainKeyword.trim());
  const subInBody = occurrences(markdown, subKeyword.trim());

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2200);
  }

  async function suggest() {
    setError("");
    setSuggesting(true);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mainKeyword, context }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setSuggestions(d.suggestions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function generate() {
    setError("");
    setGenerating(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mainKeyword, subKeyword, tone, targetChars, outline }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setTitle(d.draft.title);
      setMetaDesc(d.draft.metaDescription);
      setTags(d.draft.tags);
      setMarkdown(d.draft.bodyMarkdown);
      setPostId(d.postId ?? null);
      flash("초안을 생성하고 글 목록에 저장했습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    const payload = {
      main_keyword: mainKeyword,
      sub_keyword: subKeyword,
      title,
      meta_desc: metaDesc,
      tags,
      body_markdown: markdown,
      body_html: html,
    };
    if (postId) {
      await fetch(`/api/posts/${postId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      flash("저장했습니다.");
    } else {
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      setPostId(d.id);
      flash("새 글로 저장했습니다.");
    }
  }

  const hasDraft = Boolean(markdown.trim());

  return (
    <>
      <h1 className="page-title">글 작성</h1>
      <p className="page-desc">
        메인 키워드 + 서브 키워드로 초안을 만들고, 네이버·티스토리에 각각 맞는 형식으로
        복사합니다.
      </p>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="card">
        <h2>주제</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>메인 키워드</label>
            <input
              value={mainKeyword}
              onChange={(e) => setMainKeyword(e.target.value)}
              placeholder="예: 제주도 여행"
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>서브 키워드</label>
            <input
              value={subKeyword}
              onChange={(e) => setSubKeyword(e.target.value)}
              placeholder="예: 3박4일 코스"
            />
          </div>
          <button onClick={suggest} disabled={suggesting || !mainKeyword.trim()}>
            {suggesting && <span className="spinner" />}
            서브 키워드 제안
          </button>
        </div>

        {context.length > 0 && (
          <p className="hint">
            같은 조회에서 가져온 인기 키워드 {context.length}개를 제안 근거로 함께
            넘깁니다.
          </p>
        )}

        {suggestions.length > 0 && (
          <table style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th style={{ width: 140 }}>서브 키워드</th>
                <th>제목안</th>
                <th>이유</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s, i) => (
                <tr key={i}>
                  <td className="kw-cell">{s.subKeyword}</td>
                  <td>{s.title}</td>
                  <td style={{ color: "var(--text-dim)" }}>{s.reason}</td>
                  <td>
                    <button
                      className="small"
                      onClick={() => {
                        setSubKeyword(s.subKeyword);
                        setTitle(s.title);
                      }}
                    >
                      선택
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>생성 옵션</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>문체</label>
            <input value={tone} onChange={(e) => setTone(e.target.value)} />
          </div>
          <div className="field">
            <label>분량 (공백 제외)</label>
            <input
              type="number"
              step={200}
              min={600}
              max={5000}
              value={targetChars}
              style={{ width: 110 }}
              onChange={(e) => setTargetChars(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>반드시 다룰 내용 (선택)</label>
          <textarea
            rows={3}
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
            placeholder="꼭 포함할 소제목, 개인 경험, 강조하고 싶은 포인트 등"
          />
        </div>
        <button
          className="primary"
          style={{ marginTop: 12 }}
          onClick={generate}
          disabled={generating || !mainKeyword.trim()}
        >
          {generating && <span className="spinner" />}
          {generating ? "생성 중… (30초 내외)" : "초안 생성"}
        </button>
      </div>

      {hasDraft && (
        <>
          <div className="card">
            <h2>제목 · 태그 · 메타</h2>
            <div className="field">
              <label>
                제목{" "}
                <span className={`badge ${mainInTitle ? "on" : ""}`}>
                  메인 {mainInTitle ? "포함" : "없음"}
                </span>{" "}
                <span className={`badge ${subInTitle ? "on" : ""}`}>
                  서브 {subInTitle ? "포함" : "없음"}
                </span>{" "}
                <span className="badge">{title.length}자</span>
              </label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <label>메타 설명 ({metaDesc.length}자)</label>
              <textarea
                rows={2}
                value={metaDesc}
                onChange={(e) => setMetaDesc(e.target.value)}
              />
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <label>태그 ({tags.length}개, 쉼표 구분)</label>
              <input
                value={tags.join(", ")}
                onChange={(e) =>
                  setTags(
                    e.target.value
                      .split(",")
                      .map((t) => t.trim().replace(/^#/, ""))
                      .filter(Boolean),
                  )
                }
              />
            </div>

            <div style={{ marginTop: 12 }}>
              {tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>복사</h2>
            <div className="row">
              <button onClick={() => copyText(title).then(() => flash("제목 복사됨"))}>
                제목
              </button>
              <button
                className="naver"
                onClick={() =>
                  copyRichHtml(html).then((mode) =>
                    flash(
                      mode === "rich"
                        ? "네이버용 서식 복사됨 — 스마트에디터에 그대로 붙여넣으세요"
                        : "서식 복사를 지원하지 않아 HTML 평문으로 복사했습니다",
                    ),
                  )
                }
              >
                네이버 본문 (서식 유지)
              </button>
              <button
                className="tistory"
                onClick={() => copyText(html).then(() => flash("티스토리용 HTML 복사됨"))}
              >
                티스토리 본문 (HTML)
              </button>
              <button
                onClick={() => copyText(markdown).then(() => flash("마크다운 복사됨"))}
              >
                마크다운
              </button>
              <button
                onClick={() =>
                  copyText(tags.map((t) => `#${t}`).join(" ")).then(() =>
                    flash("태그 복사됨"),
                  )
                }
              >
                태그
              </button>
              <button className="ghost" onClick={save}>
                저장
              </button>
            </div>
            <p className="hint">
              네이버는 스마트에디터 본문에 그대로 붙여넣기(⌘V), 티스토리는 에디터를 HTML
              모드로 바꾼 뒤 붙여넣으세요.
            </p>
          </div>

          <div className="split">
            <div className="card">
              <h2>
                본문 편집 (마크다운) · 공백제외 {charCount.toLocaleString()}자 ·{" "}
                <span className={`badge ${mainInBody >= 3 ? "on" : ""}`}>
                  메인 {mainInBody}회
                </span>{" "}
                <span className={`badge ${subInBody >= 2 ? "on" : ""}`}>
                  서브 {subInBody}회
                </span>
              </h2>
              <textarea
                className="mono"
                rows={26}
                style={{ width: "100%" }}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
              />
            </div>

            <div className="card">
              <h2>미리보기</h2>
              <div className="preview">
                <h1>{title}</h1>
                <div dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function WritePage() {
  return (
    <Suspense fallback={<div className="empty">불러오는 중…</div>}>
      <WritePageInner />
    </Suspense>
  );
}
