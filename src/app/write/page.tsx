"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { markdownToHtml, countChars } from "@/lib/markdown";
import Help from "@/components/Help";
import { copyRichHtml, copyText } from "@/lib/clipboard";
import type { StoredImage } from "@/lib/images";
import { applyVisuals, type Visual } from "@/lib/visuals";
import { downloadHtmlAsPng } from "@/lib/htmlImage";

type Suggestion = { subKeyword: string; title: string; reason: string };

/** 자동 작성 진행 표시용. 0=대기, 1=서브 키워드 제안, 2=본문 생성, 3=완료 */
type AutoPhase = 0 | 1 | 2 | 3;

/**
 * 자동 작성은 한 번의 요청 안에서 두 단계가 이어 돌아 서버 진행률을 받아올 수 없다.
 * 그래서 첫 단계가 대략 끝날 시점을 경과 시간으로 잡아 라벨만 넘긴다.
 * (제안 호출은 보통 10~20초, 본문 생성이 나머지를 먹는다)
 */
const SUGGEST_ESTIMATE_SEC = 18;

/**
 * 저장된 시각 자료를 배열로 되돌린다.
 * jsonb 컬럼이라 배열로 오지만, 예전 저장분은 문자열일 수 있어 양쪽을 받는다.
 */
function parseStoredVisuals(raw: unknown): Visual[] {
  const arr =
    Array.isArray(raw)
      ? raw
      : (() => {
          try {
            const parsed = JSON.parse(String(raw || "[]"));
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })();
  return arr.filter(
    (v: unknown): v is Visual =>
      typeof v === "object" && v !== null && typeof (v as Visual).html === "string",
  );
}

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
  const [warning, setWarning] = useState("");
  const [notice, setNotice] = useState("");

  const [autoRunning, setAutoRunning] = useState(false);
  const [autoPhase, setAutoPhase] = useState<AutoPhase>(0);
  const [autoElapsed, setAutoElapsed] = useState(0);
  /** ?auto=1 로 들어왔을 때 딱 한 번만 자동 실행 (개발 모드의 이펙트 2회 실행 방어) */
  const autoStarted = useRef(false);

  const [postId, setPostId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState("");
  const [jsonLd, setJsonLd] = useState("");
  const [sources, setSources] = useState<{ title: string; uri: string }[]>([]);
  /*
   * 시각 자료는 본문 마크다운에 {{visual:N}} 자리로만 들어 있고 실체는 따로 온다.
   * 그동안 이 값을 화면에서 아예 안 들고 있어서, 미리보기에는 자리표시자가 그대로
   * 보이고 저장하면 자료가 통째로 사라졌다.
   */
  const [visuals, setVisuals] = useState<Visual[]>([]);
  const [visualBusy, setVisualBusy] = useState("");
  const [visualError, setVisualError] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [images, setImages] = useState<StoredImage[]>([]);
  const [showImages, setShowImages] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState("");

  /** 커서 자리에 끼워 넣는다. 맨 뒤에 붙이면 원하는 위치가 아니라 매번 옮겨야 한다 */
  function insertAtCursor(text: string) {
    const el = bodyRef.current;
    if (!el) {
      setMarkdown((m) => m + text);
      return;
    }
    const start = el.selectionStart ?? markdown.length;
    const end = el.selectionEnd ?? start;
    const next = markdown.slice(0, start) + text + markdown.slice(end);
    setMarkdown(next);
    // setState 반영 뒤에 커서를 삽입한 텍스트 끝으로 돌려놓는다
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const loadImages = useCallback(() => {
    fetch("/api/images")
      .then((r) => r.json())
      .then((d) => setImages(d.images ?? []))
      .catch(() => setImages([]));
  }, []);

  async function uploadImages(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    setUploading(true);
    setImageError("");
    try {
      const form = new FormData();
      for (const f of list) form.append("file", f);
      const res = await fetch("/api/images", { method: "POST", body: form });
      const d = await res.json();
      if (d.error) setImageError(d.error);
      for (const s of d.saved ?? []) insertAtCursor(`\n![](${s.url})\n`);
      if ((d.saved ?? []).length) loadImages();
    } catch (e) {
      setImageError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  /** 스크린샷을 그대로 붙여넣는 경로. 파일 고르기보다 이쪽을 훨씬 자주 쓴다 */
  function onPasteImage(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (!files.length) return;
    e.preventDefault();
    uploadImages(files);
  }

  async function removeImage(name: string) {
    if (!confirm(`${name} 을 삭제할까요?`)) return;
    await fetch(`/api/images/${encodeURIComponent(name)}`, { method: "DELETE" });
    loadImages();
  }

  useEffect(() => {
    const main = params.get("main");
    if (main) setMainKeyword(main);
    const ctx = params.get("context");
    const ctxList = ctx ? ctx.split("|").filter(Boolean) : [];
    if (ctx) setContext(ctxList);

    // 키워드 탐색에서 "자동 작성"으로 넘어온 경우 도착 즉시 파이프라인을 돌린다.
    // 상태 반영을 기다리면 첫 렌더에서는 아직 비어 있으므로 쿼리에서 읽은 값을 그대로 넘긴다.
    if (main && params.get("auto") === "1" && !autoStarted.current) {
      autoStarted.current = true;
      runAuto(main, ctxList);
    }

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
          setVisuals(parseStoredVisuals(p.visuals));
          // jsonb 라 배열로 온다. 예전 저장분이 문자열일 수 있어 양쪽을 받는다
          setTags(
            Array.isArray(p.tags)
              ? p.tags
              : (() => {
                  try {
                    const parsed = JSON.parse(p.tags || "[]");
                    return Array.isArray(parsed) ? parsed : [];
                  } catch {
                    return [];
                  }
                })(),
          );
        });
    }
  }, [params]);

  // 자리표시자를 실제 자료로 바꿔야 미리보기가 발행본과 같아진다
  const html = useMemo(
    () => applyVisuals(markdownToHtml(markdown), visuals),
    [markdown, visuals],
  );
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

  /** 후보 표에서 곧바로 재생성할 때는 setState 반영을 기다리지 않게 서브 키워드를 인자로 받는다 */
  async function generate(sub?: string) {
    const useSub = sub ?? subKeyword;
    setError("");
    setGenerating(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mainKeyword,
          subKeyword: useSub,
          tone,
          targetChars,
          outline,
        }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      applyDraft(d.draft, d.postId ?? null);
      flash("초안을 생성하고 글 목록에 저장했습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  /**
   * 시각 자료 하나를 PNG 로 받는다.
   *
   * 티스토리는 HTML 을 그대로 붙이면 되지만 네이버 스마트에디터는 태그와 스타일을
   * 지워버려서, 네이버에 올리려면 결국 그림이어야 한다.
   */
  async function saveVisualPng(v: Visual, index: number) {
    setVisualError("");
    setVisualBusy(`${index}`);
    try {
      await downloadHtmlAsPng(v.html, v.title || `${title || "visual"}-${index + 1}`, {
        width: 800,
        scale: 2,
      });
    } catch (e) {
      setVisualError((e as Error).message);
    } finally {
      setVisualBusy("");
    }
  }

  /** 서버가 준 초안을 편집·미리보기 상태로 옮긴다. 수동·자동 경로가 같은 결과를 갖게 하는 지점 */
  function applyDraft(
    draft: {
      title: string;
      metaDescription: string;
      tags: string[];
      bodyMarkdown: string;
      jsonLd?: string;
      sources?: { title: string; uri: string }[];
      visuals?: Visual[];
    },
    id: number | null,
  ) {
    setTitle(draft.title);
    setMetaDesc(draft.metaDescription);
    setTags(draft.tags);
    setMarkdown(draft.bodyMarkdown);
    // 본문은 마크다운을 다시 변환해 쓰지만, 구조화 데이터와 출처는 생성 시점 값이라 따로 보관한다
    setJsonLd(draft.jsonLd ?? "");
    setSources(draft.sources ?? []);
    setVisuals(draft.visuals ?? []);
    setPostId(id);
  }

  /**
   * 서브 키워드 제안 → 본문 생성 → 저장을 서버에서 한 번에 돌린다.
   * 키워드만 있으면 되므로 탐색 화면에서 넘어온 값도 인자로 바로 받는다.
   */
  async function runAuto(main?: string, ctx?: string[]) {
    const mk = (main ?? mainKeyword).trim();
    if (!mk || autoRunning) return;

    setError("");
    setWarning("");
    setAutoRunning(true);
    setAutoPhase(1);
    setAutoElapsed(0);

    // 응답이 한 번에 오므로 진행률을 알 수 없다. 멈춘 것처럼 보이지 않게
    // 경과 시간을 계속 갱신하고, 첫 단계의 예상 소요를 넘기면 라벨만 다음 단계로 넘긴다.
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const sec = Math.round((Date.now() - startedAt) / 1000);
      setAutoElapsed(sec);
      setAutoPhase(sec < SUGGEST_ESTIMATE_SEC ? 1 : 2);
    }, 1000);

    try {
      const res = await fetch("/api/autowrite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mainKeyword: mk,
          context: ctx ?? context,
          tone,
          targetChars,
          outline,
        }),
      });
      const d = await res.json();
      // 서버가 실패 단계를 메시지 앞에 붙여 주므로 그대로 보여주면 어디서 끊겼는지 드러난다
      if (!d.ok) throw new Error(d.error ?? "자동 작성에 실패했습니다.");

      setMainKeyword(mk);
      setSubKeyword(d.subKeyword ?? "");
      setSuggestions(d.suggestions ?? []);
      applyDraft(d.draft, d.postId ?? null);
      setAutoPhase(3);
      if (d.warning) setWarning(d.warning);
      flash(
        d.subKeyword
          ? `서브 키워드 "${d.subKeyword}" 로 초안까지 만들었습니다.`
          : "서브 키워드 후보가 없어 메인 키워드만으로 초안을 만들었습니다.",
      );
    } catch (e) {
      setError((e as Error).message);
      setAutoPhase(0);
    } finally {
      clearInterval(ticker);
      setAutoRunning(false);
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
      visuals,
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
        복사합니다. <strong>자동 작성</strong> 은 서브 키워드 제안부터 본문까지 한 번에
        돌리고, 아래 수동 버튼은 자동이 실패했을 때 단계별로 다시 밟는 용도입니다.
      </p>

      {error && <div className="alert error">{error}</div>}
      {warning && <div className="alert warn">{warning}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="card">
        <h2>
          주제
          <Help text="제목에 메인·서브 키워드가 원형 그대로 들어가게 만듭니다. 조사가 끼어 키워드가 끊기면 검색에 안 걸립니다.&#10;'서브 키워드 제안' 을 누르면 조합 후보 5개와 제목안을 함께 받습니다." />
        </h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>
              메인 키워드
              <Help text="글의 중심 검색어입니다. 제목 앞쪽에 배치되고 본문에 5~8회 등장합니다.&#10;키워드 탐색 화면에서 '작성' 을 누르면 자동으로 채워집니다." />
            </label>
            <input
              value={mainKeyword}
              onChange={(e) => setMainKeyword(e.target.value)}
              placeholder="예: 제주도 여행"
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>
              서브 키워드
              <Help text="메인 키워드와 조합해 검색 의도를 좁히는 말입니다. 예: '제주도 여행' + '3박4일 코스'.&#10;비워두면 제목이 넓어져 경쟁이 심한 검색어와 부딪칩니다." />
            </label>
            <input
              value={subKeyword}
              onChange={(e) => setSubKeyword(e.target.value)}
              placeholder="예: 3박4일 코스"
            />
          </div>
          <button
            className="primary"
            onClick={() => runAuto()}
            disabled={autoRunning || generating || suggesting || !mainKeyword.trim()}
            title="서브 키워드 제안부터 본문 생성·저장까지 한 번에 실행합니다"
          >
            {autoRunning && <span className="spinner" />}
            자동 작성
          </button>
          <button
            onClick={suggest}
            disabled={suggesting || autoRunning || !mainKeyword.trim()}
          >
            {suggesting && <span className="spinner" />}
            서브 키워드 제안
          </button>
        </div>

        {(autoRunning || autoPhase === 3) && (
          <div className="steps">
            <span className={`step ${autoPhase > 1 ? "done" : "now"}`}>
              1. 서브 키워드 제안
            </span>
            <span
              className={`step ${autoPhase === 2 ? "now" : autoPhase === 3 ? "done" : ""}`}
            >
              2. 본문 생성
            </span>
            <span className={`step ${autoPhase === 3 ? "done" : ""}`}>3. 완료</span>
            {autoRunning && <span className="dim">{autoElapsed}초 경과</span>}
          </div>
        )}

        {autoRunning && (
          <p className="hint">
            Gemini 를 두 번 연달아 부르기 때문에 1~2분까지 걸릴 수 있습니다. 창을 닫지
            마세요. 단계 표시는 응답이 한 번에 오는 구조라 경과 시간 기준 추정값입니다.
          </p>
        )}

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
                <th style={{ width: 160 }}>서브 키워드</th>
                <th>제목안</th>
                <th>이유</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s, i) => (
                <tr key={i}>
                  <td className="kw-cell">
                    {s.subKeyword}
                    {s.subKeyword === subKeyword && (
                      <span className="tag seed">선택됨</span>
                    )}
                  </td>
                  <td>{s.title}</td>
                  <td style={{ color: "var(--text-dim)" }}>{s.reason}</td>
                  <td>
                    <span className="cell-actions">
                      <button
                        className="small"
                        onClick={() => {
                          setSubKeyword(s.subKeyword);
                          setTitle(s.title);
                        }}
                      >
                        선택
                      </button>
                      {/* 자동 선택이 마음에 안 들 때의 갈아타기. 제안은 이미 받았으니
                          제안 단계를 건너뛰고 본문만 다시 뽑는다 */}
                      <button
                        className="small ghost"
                        disabled={generating || autoRunning}
                        onClick={() => {
                          setSubKeyword(s.subKeyword);
                          generate(s.subKeyword);
                        }}
                      >
                        이걸로 재생성
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>
          생성 옵션
          <Help text="Gemini 가 제목·본문·태그·메타 설명·FAQ 를 한 번에 만들고 글 목록에 자동 저장합니다.&#10;검색 그라운딩이 켜져 있으면 본문 작성 전에 최신 수치를 먼저 조사합니다(2패스라 시간과 쿼터가 2배)." />
        </h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>
              문체
              <Help text="말투와 밀도를 정합니다. 그대로 프롬프트에 들어가니 자유롭게 쓰세요.&#10;예: 20대 여성 대상 친근한 말투, 전문가가 설명하는 담백한 문체." />
            </label>
            <input value={tone} onChange={(e) => setTone(e.target.value)} />
          </div>
          <div className="field">
            <label>
              분량 (공백 제외)
              <Help text="네이버 블로그는 1,500자 이상에서 체류시간이 붙습니다. 2,000자 내외가 무난하고, 3,000자를 넘기면 모델이 내용을 늘리려 반복하기 시작합니다." />
            </label>
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
          <label>
            반드시 다룰 내용 (선택)
            <Help text="꼭 포함할 소제목, 내 경험, 강조할 포인트를 적으세요.&#10;여기에 적은 내용이 다른 블로그와 차별점이 됩니다 — 비워두면 어디서 본 듯한 글이 나옵니다." />
          </label>
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
          onClick={() => generate()}
          disabled={generating || autoRunning || !mainKeyword.trim()}
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
            <h2>
            복사
            <Help text="네이버와 티스토리는 붙여넣기 방식이 다릅니다.&#10;· 네이버 — 스마트에디터 본문에 그대로 ⌘V (소제목·굵게가 살아납니다)&#10;· 티스토리 — 에디터를 HTML 모드로 바꾼 뒤 ⌘V" />
          </h2>
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
                onClick={() =>
                  // 구조화 데이터가 있으면 본문 뒤에 붙여 한 번에 넣게 한다.
                  // 따로 복사시키면 붙여넣기를 빠뜨려 스키마가 통째로 사라진다.
                  copyText(jsonLd ? `${html}\n\n${jsonLd}` : html).then(() =>
                    flash(
                      jsonLd
                        ? "티스토리용 HTML + 구조화 데이터 복사됨"
                        : "티스토리용 HTML 복사됨",
                    ),
                  )
                }
                title={
                  jsonLd
                    ? "본문 HTML 뒤에 JSON-LD(Article·FAQPage)가 함께 복사됩니다"
                    : "구조화 데이터가 없어 본문만 복사됩니다"
                }
              >
                티스토리 본문 (HTML{jsonLd ? " + 스키마" : ""})
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
              모드로 바꾼 뒤 붙여넣으세요. 구조화 데이터는 티스토리에서만 동작합니다 —
              네이버 블로그는 스크립트 태그를 지웁니다.
            </p>

            {sources.length > 0 ? (
              <details style={{ marginTop: 12 }}>
                <summary>
                  최신 정보 출처 {sources.length}건 — 본문의 수치를 검증하세요
                </summary>
                <ul className="hint" style={{ paddingLeft: 18, marginTop: 8 }}>
                  {sources.map((s, i) => (
                    <li key={`${s.uri}-${i}`}>
                      <a href={s.uri} target="_blank" rel="noreferrer">
                        {s.title || s.uri}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className="hint">
                이 초안은 <strong>검색 그라운딩 없이</strong> 만들어졌습니다. 수치·날짜·
                금액이 최신인지 직접 확인하세요.
              </p>
            )}
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
                ref={bodyRef}
                className="mono"
                rows={26}
                style={{ width: "100%" }}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                onPaste={onPasteImage}
              />

              <div className="row" style={{ marginTop: 10 }}>
                <label className="small ghost" style={{ cursor: "pointer", padding: "4px 9px", border: "1px solid var(--border)", borderRadius: 8 }}>
                  {uploading ? <span className="spinner" /> : null}
                  {uploading ? "올리는 중" : "이미지 올리기"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      uploadImages(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  className="small ghost"
                  onClick={() => {
                    setShowImages((v) => !v);
                    if (!showImages) loadImages();
                  }}
                >
                  보관함 {showImages ? "닫기" : "열기"}
                </button>
              </div>
              <p className="hint">
                파일을 고르거나 본문에 <strong>붙여넣기(⌘V)</strong> 하면 커서 위치에
                이미지가 들어갑니다. 로컬 <span className="mono">data/images/</span> 에만
                저장되며, 실제 발행 때는 티스토리 에디터가 자기 서버로 다시 올립니다.
              </p>
              {imageError && <div className="alert warn">{imageError}</div>}

              {showImages && (
                <div style={{ marginTop: 10 }}>
                  {images.length === 0 ? (
                    <div className="empty">보관된 이미지가 없습니다.</div>
                  ) : (
                    <div className="img-grid">
                      {images.map((img) => (
                        <div key={img.name} className="img-item">
                          {/* 로컬 보관소 파일이라 next/image 최적화 대상이 아니다 */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={img.url} alt={img.name} />
                          <div className="row" style={{ gap: 4, marginTop: 4 }}>
                            <button
                              className="small"
                              onClick={() => insertAtCursor(`\n![](${img.url})\n`)}
                            >
                              넣기
                            </button>
                            <button
                              className="small ghost"
                              onClick={() => removeImage(img.name)}
                            >
                              삭제
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {visuals.length > 0 && (
              <div className="card">
                <h2>시각 자료 {visuals.length}개</h2>
                <p className="hint">
                  티스토리는 아래 HTML 이 본문에 그대로 들어가 글자로 읽힙니다(검색엔진도
                  읽습니다). 네이버 스마트에디터는 태그와 스타일을 지우므로, 네이버에는
                  <strong> PNG로 저장</strong> 해서 이미지로 올리세요.
                </p>
                {visualError && <div className="alert warn">{visualError}</div>}
                {visuals.map((v, i) => (
                  <div key={i} className="visual-item">
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <strong>
                        <span className="badge">{v.type}</span> {v.title}
                      </strong>
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="small"
                          disabled={visualBusy === `${i}`}
                          onClick={() => saveVisualPng(v, i)}
                        >
                          {visualBusy === `${i}` ? "굽는 중" : "PNG로 저장"}
                        </button>
                        <button
                          className="small ghost"
                          onClick={() => copyText(v.html).then(() => flash("HTML 을 복사했습니다."))}
                        >
                          HTML 복사
                        </button>
                      </div>
                    </div>
                    {/* 실제로 발행될 모양 그대로 보여준다. 정제를 거친 HTML 이다 */}
                    <div
                      className="visual-preview"
                      dangerouslySetInnerHTML={{ __html: v.html }}
                    />
                  </div>
                ))}
              </div>
            )}

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
