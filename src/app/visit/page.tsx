"use client";

import { useCallback, useEffect, useState } from "react";
import Help from "@/components/Help";
import { copyRichHtml, copyText } from "@/lib/clipboard";

/**
 * 방문 후기 — 사진에서 글로.
 *
 * `/write` 와 방향이 반대다. 저쪽은 키워드를 고르고 글을 쓰지만, 여기는 이미 다녀온
 * 가게의 사진을 올리는 것으로 시작한다. 그래서 화면도 표가 아니라 단계다.
 *
 *   사진 + 장소 + 날짜  →  분석  →  인터뷰 4문항  →  본문  →  복사
 *
 * 휴대폰에서 쓰는 것을 전제로 만들었다. 출퇴근길에 사진 올리고 네 문항 답하면
 * 끝나야 한다. 발행은 네이버 앱에서 직접 한다 — 자동 발행은 하지 않는다.
 */

type VisitPost = {
  id: number;
  place_query: string;
  visited_on: string;
  place: { name?: string; address?: string; category?: string; url?: string } | null;
  situation: string;
  titles: string[];
  title: string;
  body_markdown?: string;
  body_html?: string;
  tags: string[];
  photo_order?: { index: number; note: string }[];
  warnings: string[];
  needs_check: string[];
  status: string;
  created_at: string;
};

type Analysis = {
  photos: { index: number; kind: string; caption: string }[];
  menu: { name: string; price: number | null }[];
  receipt: { items: string[]; total: number | null; people: number | null } | null;
  observations: string[];
  uncertain: string[];
};

const STATUS_LABEL: Record<string, string> = {
  analyzed: "분석됨",
  drafted: "초안",
  ready: "올릴 준비",
  posted: "올림",
  dropped: "보류",
};

/** 사진 긴 변을 이 크기로 줄여 보낸다 */
const MAX_EDGE = 1024;
const MAX_PHOTOS = 15;

/**
 * 사진을 줄여 base64 로 만든다.
 *
 * 아이폰 원본은 장당 3~5MB 라 15장이면 요청이 통째로 거절된다. 비전 모델도 그만한
 * 해상도를 쓰지 않으므로 긴 변 1024px, JPEG 0.8 로 줄인다 — 메뉴판 글씨는 이 크기로도
 * 읽힌다. 브라우저에 렌더 엔진이 이미 있으니 서버로 원본을 보낼 이유가 없다.
 */
async function shrink(file: File): Promise<{ mimeType: string; data: string }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(
      `${file.name} 을(를) 읽지 못했습니다. HEIC 라면 아이폰 설정 → 카메라 → 포맷을 "높은 호환성"으로 두거나, 사진 앱에서 JPEG 로 내보내주세요.`,
    );
  });

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const url = canvas.toDataURL("image/jpeg", 0.8);
  return { mimeType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

export default function VisitPage() {
  const [posts, setPosts] = useState<VisitPost[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  /* 1단계 입력 */
  const [files, setFiles] = useState<File[]>([]);
  const [placeQuery, setPlaceQuery] = useState("");
  const [visitedOn, setVisitedOn] = useState("");
  const [situation, setSituation] = useState("");

  /* 2단계 — 분석 결과 */
  const [id, setId] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [place, setPlace] = useState<VisitPost["place"]>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  /* 3단계 — 인터뷰 */
  const [company, setCompany] = useState("혼자");
  const [mealTime, setMealTime] = useState("점심");
  const [memorable, setMemorable] = useState("");
  const [revisit, setRevisit] = useState("근처 오면");
  const [downside, setDownside] = useState("");

  /* 4단계 — 결과 */
  const [draft, setDraft] = useState<VisitPost | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await (await fetch("/api/visit")).json();
      setPosts(d.posts ?? []);
      if (d.error) setError(d.error);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  }

  function reset() {
    setId(null);
    setAnalysis(null);
    setPlace(null);
    setWarnings([]);
    setDraft(null);
    setFiles([]);
    setPlaceQuery("");
    setVisitedOn("");
    setSituation("");
    setMemorable("");
    setDownside("");
  }

  async function analyze() {
    setError("");
    setBusy("사진을 읽는 중… 장수에 따라 20~40초 걸립니다");
    try {
      const photos = [];
      for (let i = 0; i < files.length; i++) {
        const { mimeType, data } = await shrink(files[i]);
        photos.push({ index: i + 1, mimeType, data });
      }

      const res = await fetch("/api/visit/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ placeQuery, visitedOn, situation, photos }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? "분석에 실패했습니다.");

      setId(d.id);
      setAnalysis(d.analysis);
      setPlace(d.place);
      setWarnings(d.warnings ?? []);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    if (!id) return;
    setError("");
    setBusy("본문을 쓰는 중…");
    try {
      const res = await fetch("/api/visit/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          situation,
          interview: { company, mealTime, memorable, revisit, downside },
        }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? "생성에 실패했습니다.");
      setDraft(d.post);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function patch(postId: number, body: Record<string, unknown>) {
    try {
      const res = await fetch("/api/visit", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: postId, ...body }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      if (draft?.id === postId) setDraft(d.post);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="main">
      <h1 className="page-title">방문 후기</h1>
      <p className="page-desc">
        이미 다녀온 가게의 사진에서 시작합니다. 사진이 사실을 채우고, 네 문항이 감상을
        채웁니다. 발행은 네이버 앱에서 직접 하세요.
      </p>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="badge">{notice}</div>}
      {busy && (
        <div className="alert">
          <span className="spinner" /> {busy}
        </div>
      )}

      {/* ---------------- 1단계 ---------------- */}
      <div className="card">
        <h2>
          1. 사진과 장소
          <Help text="메뉴판과 영수증 사진이 있으면 꼭 함께 올리세요. 본문에 가격을 쓸 수 있는 유일한 근거입니다. 없으면 가격은 아예 쓰지 않습니다." />
        </h2>

        <div className="field">
          <label>사진 (최대 {MAX_PHOTOS}장)</label>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_PHOTOS))}
          />
          {files.length > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {files.length}장 선택됨. 올릴 때 긴 변 {MAX_EDGE}px 로 줄여 보냅니다 — 원본은
              서버에 저장하지 않습니다.
            </p>
          )}
        </div>

        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>장소명 또는 주소</label>
            <input
              placeholder="신림동 OO국밥"
              value={placeQuery}
              onChange={(e) => setPlaceQuery(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label>
              방문 날짜
              <Help text="대략이어도 됩니다. '2024년 가을쯤' 처럼 쓰세요. 오래된 방문이면 본문에서 시점을 밝힙니다." />
            </label>
            <input
              placeholder="2024년 가을쯤"
              value={visitedOn}
              onChange={(e) => setVisitedOn(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label>
            이 글의 상황 (선택)
            <Help text="글마다 바뀌는 한 줄입니다. 페르소나는 고정이고 이것만 바뀝니다." />
          </label>
          <input
            placeholder="이 블로그 첫 글 / 여수 여행 2일차 / 퇴근길 혼밥"
            value={situation}
            onChange={(e) => setSituation(e.target.value)}
          />
        </div>

        <button
          className="primary"
          onClick={analyze}
          disabled={Boolean(busy) || !files.length || !placeQuery.trim() || !visitedOn.trim()}
        >
          사진 분석
        </button>
      </div>

      {/* ---------------- 2단계 ---------------- */}
      {analysis && (
        <div className="card">
          <h2>2. 사진에서 읽은 것</h2>

          {warnings.map((w, i) => (
            <div className="alert" key={i}>
              {w}
            </div>
          ))}

          {place && (
            <p className="hint">
              <strong>{place.name}</strong> · {place.address} · {place.category}
            </p>
          )}

          <div className="split">
            <div>
              <h3>사진</h3>
              <ul>
                {analysis.photos.map((p) => (
                  <li key={p.index}>
                    <span className="tag">{p.kind}</span> {p.caption}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>메뉴 {analysis.menu.length === 0 && <span className="dim">(근거 없음)</span>}</h3>
              <ul>
                {analysis.menu.map((m, i) => (
                  <li key={i}>
                    {m.name} —{" "}
                    {m.price ? (
                      <span className="num">{m.price.toLocaleString()}원</span>
                    ) : (
                      <span className="dim">가격 못 읽음</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {analysis.observations.length > 0 && (
            <>
              <h3>확인된 사실</h3>
              <ul>
                {analysis.observations.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </>
          )}

          {analysis.uncertain.length > 0 && (
            <>
              <h3>
                확신 못 한 것
                <Help text="본문에 쓰지 않습니다. 사실이 아닐 수 있어서입니다." />
              </h3>
              <ul className="dim">
                {analysis.uncertain.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* ---------------- 3단계 ---------------- */}
      {analysis && (
        <div className="card">
          <h2>
            3. 30초 인터뷰
            <Help text="사실은 사진이 다 채웠습니다. 여기서 더해지는 건 사람만 아는 것 — 이게 없으면 사실 나열이 되고, 그게 AI 글의 전형입니다." />
          </h2>

          <div className="row">
            <div className="field">
              <label>누구랑 갔어요?</label>
              <div className="row">
                {["혼자", "친구", "가족", "연인", "회식"].map((v) => (
                  <button
                    key={v}
                    className={company === v ? "primary" : ""}
                    onClick={() => setCompany(v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>언제요?</label>
              <div className="row">
                {["점심", "저녁", "그 외"].map((v) => (
                  <button
                    key={v}
                    className={mealTime === v ? "primary" : ""}
                    onClick={() => setMealTime(v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="field">
            <label>제일 기억나는 것 한 줄 *</label>
            <input
              placeholder="국물이 생각보다 안 짜서 끝까지 먹었음"
              value={memorable}
              onChange={(e) => setMemorable(e.target.value)}
            />
          </div>

          <div className="row">
            <div className="field">
              <label>또 갈 거예요?</label>
              <div className="row">
                {["응", "아니", "근처 오면"].map((v) => (
                  <button
                    key={v}
                    className={revisit === v ? "primary" : ""}
                    onClick={() => setRevisit(v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>아쉬웠던 점 (선택)</label>
              <input value={downside} onChange={(e) => setDownside(e.target.value)} />
            </div>
          </div>

          <button className="primary" onClick={generate} disabled={Boolean(busy) || !memorable.trim()}>
            본문 생성
          </button>
        </div>
      )}

      {/* ---------------- 4단계 ---------------- */}
      {draft && (
        <div className="card">
          <h2>4. 초안</h2>

          {draft.needs_check?.length > 0 && (
            <div className="alert">
              <strong>확인 필요</strong>
              <ul>
                {draft.needs_check.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          <h3>제목 3안</h3>
          {draft.titles?.map((t, i) => (
            <div className="row" key={i}>
              <button
                className={draft.title === t ? "primary" : ""}
                onClick={() => patch(draft.id, { title: t })}
              >
                {i === 0 ? "추천" : `${i + 1}안`}
              </button>
              <span style={{ flex: 1 }}>{t}</span>
              <button onClick={() => copyText(t).then(() => flash("제목 복사됨"))}>복사</button>
            </div>
          ))}

          <h3>본문</h3>
          <div
            className="preview"
            dangerouslySetInnerHTML={{ __html: draft.body_html ?? "" }}
          />

          <div className="row">
            <button
              className="primary"
              onClick={() =>
                copyRichHtml(draft.body_html ?? "").then((mode) =>
                  flash(mode === "rich" ? "서식 유지로 복사됨" : "평문으로 복사됨"),
                )
              }
            >
              네이버 본문 (서식 유지)
            </button>
            <button
              onClick={() =>
                copyText((draft.tags ?? []).map((t) => `#${t}`).join(" ")).then(() =>
                  flash("태그 복사됨"),
                )
              }
            >
              태그 {draft.tags?.length ?? 0}개 복사
            </button>
          </div>

          {draft.photo_order && draft.photo_order.length > 0 && (
            <>
              <h3>
                사진 업로드 순서
                <Help text="본문의 [사진 N] 자리와 같은 번호입니다. 이 순서대로 올리세요." />
              </h3>
              <ol>
                {draft.photo_order.map((p) => (
                  <li key={p.index}>
                    {p.index}번 — {p.note}
                  </li>
                ))}
              </ol>
            </>
          )}

          <h3>발행 체크리스트</h3>
          <ul className="check">
            <li>사진을 위 순서대로 올렸는가</li>
            <li>장소(지도)를 첨부했는가</li>
            <li>태그 10개를 넣었는가</li>
            <li>가격에 &quot;방문 당시&quot; 를 밝혔는가</li>
            <li>가게가 아직 영업 중인지 확인했는가</li>
          </ul>

          <div className="row">
            <button className="primary" onClick={() => patch(draft.id, { status: "posted" })}>
              올림 표시
            </button>
            <button onClick={reset}>새 글 쓰기</button>
          </div>
        </div>
      )}

      {/* ---------------- 목록 ---------------- */}
      <div className="card">
        <h2>지난 초안</h2>
        {posts.length === 0 ? (
          <p className="empty">아직 없습니다.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>가게</th>
                  <th>방문</th>
                  <th>제목</th>
                  <th>상태</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.place?.name || p.place_query}</td>
                    <td className="dim">{p.visited_on}</td>
                    <td>{p.title || <span className="dim">—</span>}</td>
                    <td>
                      <span className="badge">{STATUS_LABEL[p.status] ?? p.status}</span>
                      {p.warnings?.length > 0 && (
                        <span className="tag" title={p.warnings.join("\n")}>
                          확인 {p.warnings.length}
                        </span>
                      )}
                    </td>
                    <td className="cell-actions">
                      <button
                        onClick={async () => {
                          const d = await (await fetch(`/api/visit?id=${p.id}`)).json();
                          if (d.post) {
                            setDraft(d.post);
                            setId(p.id);
                          }
                        }}
                      >
                        열기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
