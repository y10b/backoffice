"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Help from "@/components/Help";
import PublishSteps from "@/components/PublishSteps";
import ActionBar from "@/components/ActionBar";
import StatusBadge, { type StatusTone } from "@/components/StatusBadge";
import { copyForNaver, copyText, toNaverHtml, withPhotos } from "@/lib/clipboard";

/**
 * 네이버 방문 후기 — 사진에서 글로.
 *
 * `/write` 와 방향이 반대다. 저쪽은 키워드를 고르고 글을 쓰지만, 여기는 이미 다녀온
 * 가게의 사진을 올리는 것으로 시작한다. 그래서 화면도 표가 아니라 단계다.
 *
 *   사진 + 장소 + 날짜  →  분석  →  인터뷰 4문항  →  본문  →  복사
 *
 * 휴대폰에서 쓰는 것을 전제로 만들었다. 출퇴근길에 사진 올리고 네 문항 답하면
 * 끝나야 한다. 발행은 네이버 앱에서 직접 한다 — 자동 발행은 하지 않는다.
 */

/**
 * 네이버 블로그 글쓰기 (PC 스마트에디터). 네이버 앱 에디터는 서식을 버려서, 폰에서도
 * 사파리로 이 주소를 열고 "데스크탑 웹사이트 요청"을 켜야 한다. 블로그 아이디가 바뀌면 여기만 고친다.
 */
const NAVER_EDITOR_URL = "https://blog.naver.com/PostWriteForm.naver?blogId=k-jun03";

/**
 * 글 종류. 서버 visit.ts 의 PostKind 와 같은 값이다(그쪽은 서버 전용 모듈이라 여기서 import 하지 않는다).
 * 화면 문구만 종류마다 다르고 흐름은 같다.
 */
type Kind = "restaurant" | "product" | "daily";
const KIND_UI: Record<Kind, { label: string; what: string; whatHint: string; when: string; whenHint: string; photoHelp: string; price: string; memorable: string; memorableHint: string; sponsor: string }> = {
  restaurant: {
    label: "맛집",
    what: "장소명 또는 주소",
    whatHint: "신림동 OO국밥",
    when: "방문 날짜",
    whenHint: "2024년 가을쯤",
    photoHelp: "메뉴판과 영수증 사진이 있으면 꼭 함께 올리세요. 본문에 가격을 쓸 수 있는 유일한 근거입니다. 없으면 가격은 아예 쓰지 않습니다.",
    price: "메뉴",
    memorable: "제일 기억나는 것 한 줄 *",
    memorableHint: "국물이 생각보다 안 짜서 끝까지 먹었음",
    sponsor: "체험단·협찬으로 간 곳이에요",
  },
  product: {
    label: "제품 후기",
    what: "제품명 (모델명까지)",
    whatHint: "OO 무선청소기 V8",
    when: "산 시기",
    whenHint: "2026년 6월",
    photoHelp: "패키지·구성품·라벨(모델명·스펙)·가격표나 주문 내역 사진이 있으면 함께 올리세요. 모델명과 가격의 근거가 됩니다. 실제로 쓰는 장면 사진이 글을 살립니다.",
    price: "가격",
    memorable: "가장 좋았던 점 한 줄 *",
    memorableHint: "원룸에서 한 손으로 들고 선반 위까지 청소됨",
    sponsor: "협찬·제공받은 제품이에요",
  },
  daily: {
    label: "일상",
    what: "장소나 주제",
    whatHint: "관악산 둘레길 / 퇴근 후 샤로수길",
    when: "날짜",
    whenHint: "2026년 9월 마지막 주말",
    photoHelp: "시간 순서대로 올리면 글도 그 순서로 이어집니다. 간판·안내판 사진이 있으면 장소 이름을 정확히 씁니다.",
    price: "가격",
    memorable: "제일 기억나는 장면 한 줄 *",
    memorableHint: "해 질 때 벤치에서 한참 앉아 있었음",
    sponsor: "협찬·초대받은 일정이에요",
  },
};
const asKind = (v: unknown): Kind => (v === "product" || v === "daily" ? v : "restaurant");

type VisitPost = {
  id: number;
  kind?: string;
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
  posted_at?: string | null;
  created_at: string;
  updated_at?: string;
  /* 단건 조회에만 온다. 지난 초안을 다시 쓸 때 2·3단계를 되살리는 데 쓴다 */
  analysis?: Analysis | null;
  interview?:
    | (Partial<
        Record<
          | "company" | "mealTime" | "memorable" | "revisit" | "downside" | "waiting" | "seat"
          | "usagePeriod" | "usageEnv" | "recommendFor" | "rebuy" | "priceNote" | "mood" | "reason" | "shopLink",
          string
        >
      > & {
        sponsored?: boolean;
      })
    | null;
};

type Analysis = {
  photos: { index: number; kind: string; caption: string }[];
  menu: { name: string; price: number | null }[];
  receipt: { items: string[]; total: number | null; people: number | null } | null;
  observations: string[];
  uncertain: string[];
  /** 제품 후기에서 상세페이지 캡처를 올렸을 때만 */
  detail?: { productName: string; facts: { label: string; value: string }[] };
};

/** 상세페이지 캡처는 세로로 길고 글자가 작다. 사진보다 크게 줄여 보내야 스펙 글씨가 읽힌다 */
const DETAIL_EDGE = 2000;
const MAX_DETAIL_SHOTS = 4;

const STATUS_LABEL: Record<string, string> = {
  analyzed: "분석됨",
  drafted: "초안",
  ready: "올릴 준비",
  posted: "올림",
  dropped: "보류",
};

const STATUS_TONE: Record<string, StatusTone> = {
  analyzed: "draft",
  drafted: "draft",
  ready: "ready",
  posted: "done",
  dropped: "hold",
};

/** 사진 긴 변을 이 크기로 줄여 보낸다 */
const MAX_EDGE = 1024;
const MAX_PHOTOS = 15;
/**
 * 본문에 넣을 사진의 긴 변. 네이버 본문 폭(약 900px)보다 조금 크게 둔다.
 * 15장이 한 번에 클립보드로 가므로 원본 크기로는 못 넣는다.
 */
const BLOG_EDGE = 1280;

/**
 * 사진을 줄여 base64 로 만든다.
 *
 * 아이폰 원본은 장당 3~5MB 라 15장이면 요청이 통째로 거절된다. 비전 모델도 그만한
 * 해상도를 쓰지 않으므로 긴 변 1024px, JPEG 0.8 로 줄인다 — 메뉴판 글씨는 이 크기로도
 * 읽힌다. 브라우저에 렌더 엔진이 이미 있으니 서버로 원본을 보낼 이유가 없다.
 */
async function shrink(file: File, edge = MAX_EDGE): Promise<{ mimeType: string; data: string }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(
      `${file.name} 을(를) 읽지 못했습니다. HEIC 라면 아이폰 설정 → 카메라 → 포맷을 "높은 호환성"으로 두거나, 사진 앱에서 JPEG 로 내보내주세요.`,
    );
  });

  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
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

function VisitInner() {
  const params = useSearchParams();
  const [posts, setPosts] = useState<VisitPost[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /*
   * 돌고 있는 작업. key 로 그 버튼에만 원을 돌리고, msg 는 버튼 옆에 적는다.
   * 화면 맨 위 띠로 알리면 스크롤한 자리에서 안 보인다.
   */
  const [busy, setBusy] = useState<{ key: string; msg: string } | null>(null);

  /* 1단계 입력 */
  const [kind, setKind] = useState<Kind>("restaurant");
  const ui = KIND_UI[kind];
  const [files, setFiles] = useState<File[]>([]);
  /* 제품 후기: 상세페이지 캡처. 분석에만 쓰고 블로그 사진으로는 쓰지 않는다 */
  const [detailFiles, setDetailFiles] = useState<File[]>([]);
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
  /* 상위 맛집 후기가 꼭 적는 것. 사진으로는 알 수 없어 묻는다 */
  const [waiting, setWaiting] = useState("모름");
  const [seat, setSeat] = useState("모름");
  const [sponsored, setSponsored] = useState(false);
  /* 제품 후기 */
  const [usagePeriod, setUsagePeriod] = useState("1개월");
  const [usageEnv, setUsageEnv] = useState("");
  const [recommendFor, setRecommendFor] = useState("");
  const [rebuy, setRebuy] = useState("응");
  const [priceNote, setPriceNote] = useState("");
  const [reason, setReason] = useState("");
  /* 네이버 쇼핑 커넥트 링크. API 가 없어 브랜드 커넥트에서 발급해 붙여 넣는다 */
  const [shopLink, setShopLink] = useState("");
  /* 일상 */
  const [mood, setMood] = useState("");

  /* 4단계 — 결과 */
  const [draft, setDraft] = useState<VisitPost | null>(null);
  /*
   * 본문 [사진 N] 자리에 넣을 사진(data URL). 서버에 저장하지 않으므로 이 화면에서 분석한
   * 글에만 있다. 지난 초안을 열면 비어 있고, 그때는 자리 표시가 그대로 복사된다.
   */
  const [photos, setPhotos] = useState<{ postId: number; urls: string[] } | null>(null);
  /* 본문을 쓰기 전에 Gemini 가 검색으로 찾은 것. 저장하지 않아 방금 생성한 글에만 있다 */
  const [research, setResearch] = useState<{
    postId: number;
    text: string;
    sources: { title: string; uri: string }[];
  } | null>(null);
  const [researchFailed, setResearchFailed] = useState(false);
  /* 제목에 넣으라고 넘긴 검색 키워드. 조사와 같은 이유로 방금 생성한 글에만 있다 */
  const [keywords, setKeywords] = useState<{ postId: number; list: { keyword: string; searches: number }[] } | null>(null);
  /* 초안 고쳐 쓰기 — 어느 자리를 어떻게 */
  const [reviseTarget, setReviseTarget] = useState("전체");
  const [reviseRequest, setReviseRequest] = useState("");

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

  /**
   * 지난 초안 하나를 띄운다. 목록의 "열기"와 ?post=ID 진입이 같이 쓴다.
   *
   * 4단계만 띄우면 다시 쓸 길이 없다. 사진 분석과 인터뷰 답은 DB 에 남아 있으니 2·3단계도
   * 되살려서, 답을 고치거나 그대로 "다시 쓰기"를 누를 수 있게 한다. 사진 원본은 저장하지
   * 않으므로 1단계와 본문 속 사진만은 돌아오지 않는다.
   */
  const openPost = useCallback(async (postId: number) => {
    try {
      const d = await (await fetch(`/api/visit?id=${postId}`)).json();
      if (d.post) {
        const p = d.post as VisitPost;
        setDraft(p);
        setId(postId);
        setAnalysis(p.analysis ?? null);
        setPlace(p.place);
        setWarnings(p.warnings ?? []);
        setPlaceQuery(p.place_query ?? "");
        setVisitedOn(p.visited_on ?? "");
        setSituation(p.situation ?? "");
        const iv = p.interview ?? {};
        if (iv.company) setCompany(iv.company);
        if (iv.mealTime) setMealTime(iv.mealTime);
        setMemorable(iv.memorable ?? "");
        if (iv.revisit) setRevisit(iv.revisit);
        setDownside(iv.downside ?? "");
        setWaiting(iv.waiting ?? "모름");
        setSeat(iv.seat ?? "모름");
        setSponsored(Boolean(iv.sponsored));
        setKind(asKind(p.kind));
        setUsagePeriod(iv.usagePeriod || "1개월");
        setUsageEnv(iv.usageEnv ?? "");
        setRecommendFor(iv.recommendFor ?? "");
        setRebuy(iv.rebuy || "응");
        setPriceNote(iv.priceNote ?? "");
        setReason(iv.reason ?? "");
        setShopLink(iv.shopLink ?? "");
        setMood(iv.mood ?? "");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (d.error) {
        setError(d.error);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // 홈 등에서 /visit?post=ID 로 들어오면 그 초안을 바로 연다. 같은 ID 는 한 번만
  const openedFromQuery = useRef<string | null>(null);
  const postParam = params.get("post");
  useEffect(() => {
    if (!postParam || openedFromQuery.current === postParam) return;
    const n = Number(postParam);
    if (!Number.isInteger(n) || n <= 0) return;
    openedFromQuery.current = postParam;
    openPost(n);
  }, [postParam, openPost]);

  // 제철 트렌드에서 "다녀왔어요" 로 오면 가게 이름을 채워 둔다
  const placeParam = params.get("place");
  useEffect(() => {
    if (placeParam) setPlaceQuery(placeParam);
  }, [placeParam]);

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
    setDetailFiles([]);
    setPhotos(null);
    setResearch(null);
    setResearchFailed(false);
    setKeywords(null);
    setPlaceQuery("");
    setVisitedOn("");
    setSituation("");
    setMemorable("");
    setDownside("");
    setWaiting("모름");
    setSeat("모름");
    setSponsored(false);
    setUsageEnv("");
    setRecommendFor("");
    setPriceNote("");
    setReason("");
    setShopLink("");
    setMood("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function analyze() {
    setError("");
    setBusy({ key: "analyze", msg: "사진을 읽는 중… 장수에 따라 20~40초" });
    try {
      const photos = [];
      const urls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const { mimeType, data } = await shrink(files[i]);
        photos.push({ index: i + 1, mimeType, data });
        const blog = await shrink(files[i], BLOG_EDGE);
        urls.push(`data:${blog.mimeType};base64,${blog.data}`);
      }

      const res = await fetch("/api/visit/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, placeQuery, visitedOn, situation, photos }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? "분석에 실패했습니다.");

      setId(d.id);
      setPhotos({ postId: d.id, urls });
      setAnalysis(d.analysis);
      setPlace(d.place);
      setWarnings(d.warnings ?? []);
      // 분석 단계에서 이미 행이 생긴다. 목록을 바로 갱신해야 "지난 초안"에 보인다
      load();

      // 상세페이지 캡처는 따로 보낸다. 사진과 한 요청에 넣으면 요청 크기 한도에 걸린다
      if (kind === "product" && detailFiles.length) {
        setBusy({ key: "analyze", msg: "상세페이지 캡처에서 스펙을 읽는 중…" });
        const images = [];
        for (let i = 0; i < detailFiles.length; i++) {
          const { mimeType, data } = await shrink(detailFiles[i], DETAIL_EDGE);
          images.push({ index: i + 1, mimeType, data });
        }
        const r = await (
          await fetch("/api/visit/detail", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: d.id, images }),
          })
        ).json();
        // 캡처 분석이 실패해도 사진 분석은 살아 있다. 알리기만 한다
        if (r.ok) setAnalysis(r.analysis);
        else setError(`상세페이지 캡처를 읽지 못했습니다 — ${r.error ?? "알 수 없는 오류"}. 사진만으로 계속할 수 있어요.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** revision 을 주면 지금 초안을 그 요청대로 고쳐 쓴다. 없으면 검색부터 새로 쓴다 */
  async function generate(revision?: { target: string; request: string }) {
    if (!id) return;
    setError("");
    setBusy(
      revision
        ? { key: "revise", msg: "요청한 부분을 고쳐 쓰는 중…" }
        : { key: "generate", msg: "가게·메뉴·키워드를 찾고 본문을 쓰는 중… 30초쯤" },
    );
    try {
      const res = await fetch("/api/visit/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          situation,
          interview: {
            company, mealTime, memorable, revisit, downside, waiting, seat, sponsored,
            usagePeriod, usageEnv, recommendFor, rebuy, priceNote, mood, reason, shopLink,
          },
          revision,
        }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? "생성에 실패했습니다.");
      setDraft(d.post);
      // 고쳐 쓰기는 조사·키워드를 다시 하지 않는다. 앞서 받은 결과를 그대로 둔다
      if (!d.revised) {
        setResearch(d.research ? { postId: d.post.id, ...d.research } : null);
        setResearchFailed(!d.research);
        setKeywords(d.keywords?.length ? { postId: d.post.id, list: d.keywords } : null);
        flash("초안을 썼습니다");
      } else {
        setReviseRequest("");
        // 소제목이 바뀌었을 수 있다. 없어진 이름이 선택된 채 남지 않게 되돌린다
        setReviseTarget("전체");
        flash("요청대로 고쳐 썼습니다");
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function patch(postId: number, body: Record<string, unknown>, key = "") {
    if (key) setBusy({ key, msg: "" });
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
    } finally {
      if (key) setBusy(null);
    }
  }

  async function removeDraft(postId: number) {
    if (!confirm("이 초안을 삭제할까요? 되돌릴 수 없습니다.")) return;
    setError("");
    try {
      const d = await (await fetch(`/api/visit?id=${postId}`, { method: "DELETE" })).json();
      if (!d.ok) throw new Error(d.error);
      reset();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function copyBody() {
    if (!draft) return;
    copyForNaver(draft.body_html ?? "", undefined, draftPhotos).then((mode) =>
      flash(
        mode === "rich"
          ? "본문 복사됨 — 네이버 에디터 본문에 붙여넣으세요"
          : "이 브라우저는 서식 복사를 막아 평문으로 복사됐습니다. 아래 '아이폰에서 안 붙으면' 을 써보세요",
      ),
    );
  }

  // 이 화면에서 분석한 글일 때만 사진이 있다. 다른 초안에 엉뚱한 사진이 붙으면 안 된다
  const draftPhotos = draft && photos?.postId === draft.id ? photos.urls : undefined;
  const draftResearch = draft && research?.postId === draft.id ? research : null;
  const draftKeywords = draft && keywords?.postId === draft.id ? keywords.list : [];
  const draftTitle = draft ? draft.title || draft.titles?.[0] || "" : "";
  // 고칠 자리 후보 — 본문의 소제목들. 모델이 준 마크다운 그대로라 # 을 떼기만 한다
  const sections = (draft?.body_markdown ?? "")
    .split("\n")
    .filter((l) => /^#{1,4}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean);

  const isBusy = Boolean(busy);
  /** 이 버튼이 도는 중이면 원을 돌린다 */
  const spin = (key: string) => busy?.key === key && <span className="spinner" />;
  /** 이 버튼이 도는 중이면 옆에 무슨 일인지 적는다 */
  const busyNote = (key: string) =>
    busy?.key === key && busy.msg ? <span className="hint">{busy.msg}</span> : null;

  return (
    <div className="main">
      <h1 className="page-title">네이버 블로그</h1>
      <p className="page-desc">
        직접 다녀온 곳, 써 본 물건, 보낸 하루의 사진에서 시작합니다. 사진이 사실을 채우고,
        몇 문항이 감상을 채웁니다. 어디 갈지 고민이면 <Link href="/eat">제철 트렌드</Link>에서 찾아보세요.
      </p>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="toast">{notice}</div>}

      {/* ---------------- 1단계 ---------------- */}
      <div className="card">
        <h2>
          1. 무엇을 쓸까요
          <Help text={ui.photoHelp} />
        </h2>

        {/* 분석을 마친 뒤 종류를 바꾸면 이미 읽은 사진과 맞지 않는다. 새 글에서만 고른다 */}
        <div className="seg" style={{ marginBottom: 12 }}>
          {(Object.keys(KIND_UI) as Kind[]).map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)} disabled={Boolean(analysis) && kind !== k}>
              {KIND_UI[k].label}
            </button>
          ))}
        </div>

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
              {files.length}장 선택됨. 원본은 서버에 저장하지 않습니다.
            </p>
          )}
        </div>

        {kind === "product" && (
          <div className="field">
            <label>
              상세페이지 캡처 (선택, 최대 {MAX_DETAIL_SHOTS}장)
              <Help text="쇼핑몰 상세페이지에서 스펙·구성품·특징 부분을 캡처해 올리세요. 판매처가 밝힌 사실만 뽑아 '판매처 설명에 따르면' 으로 씁니다. 캡처는 분석에만 쓰고 블로그 사진으로는 넣지 않습니다." />
            </label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setDetailFiles(Array.from(e.target.files ?? []).slice(0, MAX_DETAIL_SHOTS))}
            />
            {detailFiles.length > 0 && (
              <p className="hint" style={{ marginTop: 6 }}>
                캡처 {detailFiles.length}장. 사진 분석이 끝난 뒤 따로 읽습니다.
              </p>
            )}
          </div>
        )}

        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>{ui.what}</label>
            <input
              placeholder={ui.whatHint}
              value={placeQuery}
              onChange={(e) => setPlaceQuery(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label>
              {ui.when}
              <Help text="대략이어도 됩니다. '2024년 가을쯤' 처럼 쓰세요. 오래된 일이면 본문에서 시점을 밝힙니다." />
            </label>
            <input
              placeholder={ui.whenHint}
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

        <div className="row" style={{ alignItems: "center" }}>
          <button
            className="primary"
            onClick={analyze}
            disabled={isBusy || !files.length || !placeQuery.trim() || !visitedOn.trim()}
          >
            {spin("analyze")}
            {analysis ? "사진 다시 분석" : "사진 분석"}
          </button>
          {busyNote("analyze")}
        </div>
      </div>

      {/* ---------------- 2·3단계 — 분석 요약 + 인터뷰 ---------------- */}
      {analysis && (
        <div className="card">
          <h2>
            2. 인터뷰
            <Help text="사실은 사진이 채웠습니다. 여기서 더해지는 건 사람만 아는 것 — 이게 없으면 사실 나열이 되고, 그게 AI 글의 전형입니다." />
          </h2>

          {warnings.map((w, i) => (
            <div className="alert warn" key={i}>
              {w}
            </div>
          ))}

          {/* 사진에서 읽은 것은 한 줄로 요약하고 자세한 건 접어 둔다. 확인만 하면 되는 정보다 */}
          <p className="hint">
            {place ? (
              <>
                <strong>{place.name}</strong> · {place.category?.split(">").pop()?.trim()} ·{" "}
              </>
            ) : null}
            사진 {analysis.photos.length}장 · {ui.price}{" "}
            {analysis.menu.length
              ? analysis.menu
                  .slice(0, 4)
                  .map((m) => (m.price ? `${m.name} ${m.price.toLocaleString()}원` : m.name))
                  .join(", ") + (analysis.menu.length > 4 ? " 외" : "")
              : kind === "restaurant"
                ? "근거 없음(가격을 쓰지 않습니다)"
                : "사진에서 못 읽음"}
          </p>
          <details style={{ marginBottom: 12 }}>
            <summary>
              사진에서 읽은 것 자세히{analysis.detail?.facts.length ? ` · 상세페이지 사실 ${analysis.detail.facts.length}개` : ""}
            </summary>
            {analysis.detail && analysis.detail.facts.length > 0 && (
              <>
                <p className="hint">
                  상세페이지에서 읽은 것{analysis.detail.productName ? ` — ${analysis.detail.productName}` : ""} (본문에는 &quot;판매처 설명에 따르면&quot; 으로 들어갑니다)
                </p>
                <ul>
                  {analysis.detail.facts.map((f, i) => (
                    <li key={i}>
                      {f.label}: {f.value}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <ul>
              {analysis.photos.map((p) => (
                <li key={p.index}>
                  <span className="tag">{p.kind}</span> {p.caption}
                </li>
              ))}
            </ul>
            {analysis.uncertain.length > 0 && (
              <>
                <p className="hint">확신 못 한 것 — 본문에 쓰지 않습니다</p>
                <ul className="dim">
                  {analysis.uncertain.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </>
            )}
          </details>

          {kind === "restaurant" && (
            <>
              <div className="row">
                <Choice label="누구랑 갔어요?" options={["혼자", "친구", "가족", "연인", "회식"]} value={company} onChange={setCompany} />
                <Choice label="언제요?" options={["점심", "저녁", "그 외"]} value={mealTime} onChange={setMealTime} />
              </div>
              <div className="row">
                <Choice label="웨이팅은요?" options={["없음", "10분 내외", "30분 이상", "모름"]} value={waiting} onChange={setWaiting} />
                <Choice label="앉은 자리는요?" options={["1인석·바", "테이블", "좌식", "모름"]} value={seat} onChange={setSeat} />
              </div>
            </>
          )}

          {kind === "product" && (
            <>
              <div className="row">
                <Choice label="얼마나 썼어요?" options={["1주 미만", "1개월", "3개월", "6개월 이상"]} value={usagePeriod} onChange={setUsagePeriod} />
                <Choice label="또 살 거예요?" options={["응", "아니", "글쎄"]} value={rebuy} onChange={setRebuy} />
              </div>
              <div className="row">
                <div className="field" style={{ flex: 2, minWidth: 220 }}>
                  <label>
                    어디서 어떻게 써요?
                    <Help text="제목 공식(제품명 + 사용 환경 + 핵심 특징)의 재료입니다. 예: 원룸 자취방, 퇴근 후 매일 / 회사 책상, 오후마다" />
                  </label>
                  <input placeholder="원룸 자취방, 퇴근 후 매일" value={usageEnv} onChange={(e) => setUsageEnv(e.target.value)} />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 160 }}>
                  <label>산 곳·가격 (선택)</label>
                  <input placeholder="쿠팡 39,000원" value={priceNote} onChange={(e) => setPriceNote(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>
                  왜 샀어요? 전에 쓰던 건? (선택)
                  <Help text="상위 제품 후기 대부분이 '산 계기' 장면으로 시작합니다. 예: 유선청소기 꺼내기 귀찮아서 한 달에 한 번 청소함" />
                </label>
                <input placeholder="유선청소기 꺼내기 귀찮아서 한 달에 한 번 청소함" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="field">
                <label>
                  네이버 쇼핑 커넥트 링크 (선택)
                  <Help text="브랜드 커넥트(creator.naver.com) → 쇼핑 커넥트에서 이 상품 링크를 발급해 붙여 넣으세요. 넣으면 본문 첫 줄에 대가성 문구가, 정보 박스 아래와 추천 대상 아래에 링크가 한 번씩 들어갑니다. 네이버 에디터에 붙인 뒤 링크 줄을 링크 카드로 바꾸면 상위 제휴 글과 같은 모양이 됩니다." />
                </label>
                <input
                  className="mono"
                  placeholder="https://naver.me/..."
                  value={shopLink}
                  onChange={(e) => setShopLink(e.target.value.trim())}
                />
                {shopLink && !/^https:\/\/\S+$/.test(shopLink) && <p className="hint warn-text">https 로 시작하는 주소여야 합니다</p>}
              </div>
            </>
          )}

          {kind === "daily" && (
            <div className="row">
              <Choice label="누구랑요?" options={["혼자", "친구", "가족", "연인", "회식"]} value={company} onChange={setCompany} />
              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <label>그날 기분 한 줄 (선택)</label>
                <input placeholder="일주일 치 피로가 좀 풀림" value={mood} onChange={(e) => setMood(e.target.value)} />
              </div>
            </div>
          )}

          <div className="field">
            <label>{ui.memorable}</label>
            <input placeholder={ui.memorableHint} value={memorable} onChange={(e) => setMemorable(e.target.value)} />
          </div>

          <div className="row">
            {kind === "product" ? (
              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <label>이런 분께 맞아요 (선택)</label>
                <input placeholder="좁은 집, 청소기 무거워서 안 쓰게 되는 사람" value={recommendFor} onChange={(e) => setRecommendFor(e.target.value)} />
              </div>
            ) : (
              <Choice label="또 갈 거예요?" options={["응", "아니", "근처 오면"]} value={revisit} onChange={setRevisit} />
            )}
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>{kind === "daily" ? "작은 실패·아쉬웠던 점 (선택)" : "아쉬웠던 점 (선택)"}</label>
              <input value={downside} onChange={(e) => setDownside(e.target.value)} />
            </div>
          </div>

          <label className="check-inline" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={sponsored} onChange={(e) => setSponsored(e.target.checked)} />
            {ui.sponsor}
            <Help text="켜면 본문 첫 줄에 '제공받아 작성했다' 는 대가성 문구가 들어갑니다(표시광고법). 끄면 태그에 내돈내산을 넣습니다." />
          </label>

          {/* 처음 쓰기와 다시 쓰기는 같은 일이다. 버튼 하나로 둔다 */}
          <div className="row" style={{ alignItems: "center" }}>
            <button className="primary" onClick={() => generate()} disabled={isBusy || !memorable.trim()}>
              {spin("generate")}
              {draft ? "처음부터 다시 쓰기" : "본문 쓰기"}
            </button>
            {busyNote("generate") ??
              (draft && <span className="hint">답을 고쳤으면 이걸로. 검색부터 새로 하고 지금 본문을 덮어씁니다.</span>)}
          </div>
        </div>
      )}

      {/* ---------------- 3단계 — 초안 ---------------- */}
      {draft && (
        <div className="card">
          <h2>
            3. 초안
            <StatusBadge tone={STATUS_TONE[draft.status] ?? "draft"} label={STATUS_LABEL[draft.status] ?? draft.status} />
          </h2>

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
          {researchFailed && (
            <div className="alert warn">
              검색 조사에 실패해 사진과 답변만으로 썼습니다. Gemini 키·쿼터를 확인하고 다시 쓰면
              가게·메뉴 정보가 채워집니다.
            </div>
          )}

          {draftKeywords.length > 0 && (
            <p className="hint">
              검색 키워드{" "}
              {draftKeywords.map((k, i) => (
                <span key={k.keyword} className={`tag${i === 0 ? " seed" : ""}`} title={`월 ${k.searches.toLocaleString()}회`}>
                  {k.keyword} {k.searches.toLocaleString()}
                </span>
              ))}
            </p>
          )}

          <h3>제목</h3>
          {/* 누르면 그 제목으로 고른다. 복사는 아래 버튼 하나로 */}
          <div className="title-picks">
            {draft.titles?.map((t, i) => (
              <button
                key={i}
                className={`title-pick${draftTitle === t ? " on" : ""}`}
                onClick={() => draftTitle !== t && patch(draft.id, { title: t })}
              >
                <span className="dim">{i === 0 ? "추천" : `${i + 1}안`}</span> {t}
              </button>
            ))}
          </div>

          <h3>본문</h3>
          <div
            className="preview"
            dangerouslySetInnerHTML={{ __html: withPhotos(draft.body_html ?? "", draftPhotos) }}
          />

          <h3>
            네이버에 올리기
            <Help text="네이버 블로그 앱 에디터는 붙여넣기에서 서식을 버립니다. 폰에서도 사파리로 PC 스마트에디터를 열어 붙이세요." />
          </h3>
          <PublishSteps
            channel="naver"
            editorUrl={NAVER_EDITOR_URL}
            copyButtons={
              <>
                <button className="primary" onClick={copyBody}>
                  본문 복사
                </button>
                <button onClick={() => copyText(draftTitle).then(() => flash("제목 복사됨"))}>제목 복사</button>
                <button onClick={() => copyText((draft.tags ?? []).map((t) => `#${t}`).join(" ")).then(() => flash("태그 복사됨"))}>
                  태그 {draft.tags?.length ?? 0}개 복사
                </button>
              </>
            }
          />
          {!draftPhotos && (
            <p className="hint">
              지난 초안이라 사진이 없습니다. 본문의 [사진 N] 자리에 아래 순서대로 직접 넣으세요.
            </p>
          )}

          {/* 보조 수단. 버튼 복사가 평문으로만 붙을 때만 펼친다 */}
          <details style={{ marginTop: 10 }}>
            <summary>아이폰에서 안 붙으면 — 직접 선택해서 복사</summary>
            <div className="field" style={{ marginTop: 10 }}>
              <label>
                직접 선택해서 복사
                <Help text="버튼 복사가 평문으로만 붙는 기기용입니다. 전체 선택을 누르면 아래 글이 선택되니, 뜨는 메뉴에서 복사를 누르세요. iOS 가 서식 있는 텍스트로 넣어 줍니다." />
              </label>
              <div className="row" style={{ marginBottom: 6 }}>
                <button
                  className="small"
                  onClick={() => {
                    const el = document.getElementById("naver-manual-copy");
                    if (!el) return;
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const sel = window.getSelection();
                    sel?.removeAllRanges();
                    sel?.addRange(range);
                  }}
                >
                  전체 선택
                </button>
              </div>
              <div
                id="naver-manual-copy"
                className="preview"
                style={{ maxHeight: 360 }}
                dangerouslySetInnerHTML={{ __html: toNaverHtml(draft.body_html ?? "", draftTitle, draftPhotos) }}
              />
            </div>
          </details>

          {draft.body_markdown && analysis && (
            <div className="field" style={{ marginTop: 16 }}>
              <label>
                고쳐 쓰기
                <Help text="고칠 자리를 고르고 어떻게 바꿀지 적으면 그 부분만 고쳐 씁니다. 다른 소제목은 그대로 둡니다. 사진·답변에 없는 사실은 요청해도 지어내지 않습니다." />
              </label>
              <div className="row">
                <select value={reviseTarget} onChange={(e) => setReviseTarget(e.target.value)}>
                  <option value="전체">글 전체</option>
                  <option value="제목">제목</option>
                  {sections.map((sec) => (
                    <option key={sec} value={sec}>
                      {sec}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                rows={2}
                placeholder="어느 부분을 어떻게 고칠까요? 예) 도입을 더 짧고 궁금하게 / 국물 얘기를 더 자세히 / 아쉬운 점도 넣어줘"
                value={reviseRequest}
                onChange={(e) => setReviseRequest(e.target.value)}
              />
              <div className="row" style={{ alignItems: "center" }}>
                <button
                  onClick={() => generate({ target: reviseTarget, request: reviseRequest.trim() })}
                  disabled={isBusy || !reviseRequest.trim() || !memorable.trim()}
                >
                  {spin("revise")}
                  이대로 고쳐 쓰기
                </button>
                {busyNote("revise")}
              </div>
            </div>
          )}

          {/* 발행 전에 한 번 보면 되는 것들. 늘 펼쳐 둘 이유가 없다 */}
          <details style={{ marginTop: 16 }}>
            <summary>발행 전 확인</summary>
            {draft.photo_order && draft.photo_order.length > 0 && (
              <>
                <p className="hint">사진 순서 — 본문의 [사진 N] 번호와 같습니다</p>
                <ol>
                  {draft.photo_order.map((p) => (
                    <li key={p.index}>
                      {p.index}번 — {p.note}
                    </li>
                  ))}
                </ol>
              </>
            )}
            <ul className="check">
              <li>사진이 순서대로 들어갔는가</li>
              <li>장소(지도)를 첨부했는가</li>
              <li>태그를 넣었는가</li>
              <li>가격에 &quot;방문 당시&quot; 를 밝혔는가</li>
              <li>가게가 아직 영업 중인지 확인했는가</li>
              <li>체험단·협찬이면 대가성 문구를 넣었는가</li>
              <li>쇼핑 커넥트 링크 줄을 에디터에서 링크 카드로 바꿨는가 (링크는 두 곳만)</li>
            </ul>
          </details>

          {draftResearch && (
            <details>
              <summary>검색 조사 (Gemini) — 출처 {draftResearch.sources.length}건</summary>
              <pre className="hint" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
                {draftResearch.text}
              </pre>
              {draftResearch.sources.length > 0 && (
                <ul className="hint" style={{ paddingLeft: 18 }}>
                  {draftResearch.sources.map((src, i) => (
                    <li key={`${src.uri}-${i}`}>
                      <a href={src.uri} target="_blank" rel="noreferrer">
                        {src.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}

          <ActionBar
            danger={
              <button className="ghost danger" onClick={() => removeDraft(draft.id)} disabled={isBusy}>
                삭제
              </button>
            }
          >
            <button className="ghost" onClick={reset}>
              새 글
            </button>
            {draft.status !== "posted" && draft.status !== "dropped" && (
              <button onClick={() => patch(draft.id, { status: "dropped" }, "dropped")} disabled={isBusy}>
                {spin("dropped")}
                보류
              </button>
            )}
            {draft.status === "posted" ? (
              <StatusBadge tone="done" label="올림" />
            ) : (
              <button className="primary" onClick={() => patch(draft.id, { status: "posted" }, "posted")} disabled={isBusy}>
                {spin("posted")}
                올림으로 표시
              </button>
            )}
          </ActionBar>
        </div>
      )}

      {/* ---------------- 목록 ---------------- */}
      <div className="card">
        <h2>지난 초안</h2>
        {posts.length === 0 ? (
          <p className="empty">아직 없습니다.</p>
        ) : (
          posts.map((p) => (
            <button
              key={p.id}
              className={`list-item entry nowrap entry-button${draft?.id === p.id ? " current" : ""}`}
              onClick={() => openPost(p.id)}
            >
              <div className="entry-main">
                <div className="entry-title">
                  {asKind(p.kind) !== "restaurant" && <span className="tag">{KIND_UI[asKind(p.kind)].label}</span>}{" "}
                  {p.place?.name || p.place_query}
                </div>
                <div className="entry-sub">
                  {[
                    p.warnings?.length ? `확인 ${p.warnings.length}` : "",
                    p.visited_on,
                    p.title,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </div>
              </div>
              <StatusBadge tone={STATUS_TONE[p.status] ?? "draft"} label={STATUS_LABEL[p.status] ?? p.status} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** 객관식 한 문항. 인터뷰의 세 문항이 모양이 같아 하나로 뺐다 */
function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={value === v}
            className={value === v ? "on" : ""}
            onClick={() => onChange(v)}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function VisitPage() {
  // useSearchParams(?post=ID) 는 Suspense 경계가 필요하다
  return (
    <Suspense fallback={<div className="empty">불러오는 중…</div>}>
      <VisitInner />
    </Suspense>
  );
}
