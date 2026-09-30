/**
 * 방문 후기 — 사진에서 사실을 복원해 네이버 블로그 초안을 만든다.
 *
 * 기존 파이프라인과 방향이 반대다. 글 작성(`/write`)은 **키워드에서 출발해** 글을
 * 만들지만, 여기는 **이미 다녀온 가게의 사진에서 출발한다.** 키워드는 나중에
 * 따라붙는다. 그래서 `posts` 와 섞지 않고 별도 레인으로 둔다 — 쓰레드를 따로 뺀 것과
 * 같은 이유다.
 *
 * 무엇을 어디서 채우는지가 이 모듈의 전부다.
 *
 *  | 출처        | 채우는 것                                      |
 *  |-------------|-----------------------------------------------|
 *  | 사진        | 메뉴와 가격, 음식 종류, 좌석 형태, 방문 동선    |
 *  | 카카오 로컬 | 정확한 상호·주소·업종                          |
 *  | 검색 조사   | 가게 소개, 대표 메뉴가 어떤 음식인지, 동네·위치 |
 *  | 사람        | 누구랑, 어땠는지, 또 갈 건지 (30초 인터뷰)      |
 *
 * 넷 중 어디에도 없는 것은 **쓰지 않는다.** 안 시킨 메뉴의 맛, 사장님과의 대화,
 * 웨이팅 시간 — AI 가 후기를 쓸 때 반사적으로 지어내는 것들이라 프롬프트에 목록으로
 * 박아뒀다. 지어낸 방문기는 표시광고법 문제이기 전에 그 가게에 실제 피해를 준다.
 *
 * 사진 원본은 저장하지 않는다. 분석 결과만 남긴다 — 발행은 사용자가 휴대폰에서 직접
 * 하므로 서버가 원본을 들고 있을 이유가 없고, 무료 티어 용량도 아낀다.
 *
 * 글은 OpenAI(GPT)가 쓴다. 사용자가 채널별로 모델을 나눴다 — 네이버 후기 갈래는 GPT,
 * 티스토리 본문은 Gemini. 다만 검색 조사는 Gemini 가 한다. 구글 검색 그라운딩이
 * 붙어 있어 가게·메뉴 정보를 실제 웹에서 찾아오고, GPT 는 그 결과를 받아 쓰기만 한다.
 */

import { openaiJson } from "./openai";
import { DEFAULT_MODEL, geminiCall, parseGrounding, type ResearchResult } from "./gemini";
import { markdownToHtml } from "./markdown";
import { searchPlaces, type Place } from "./kakao";
import type { KeywordPick } from "./foodTrend";

/**
 * 글 종류. 사진에서 출발한다는 흐름은 같고, 사진에서 읽을 것·물을 것·쓰는 법이 다르다.
 *
 *  | 종류       | 사진에서 읽는 것          | 사람에게 묻는 것                 |
 *  |------------|--------------------------|----------------------------------|
 *  | restaurant | 메뉴판·가격·음식·좌석      | 동행, 웨이팅, 좌석, 재방문        |
 *  | product    | 패키지·구성품·라벨·가격표   | 사용 기간·환경, 장단점, 추천 대상  |
 *  | daily      | 장소·풍경·먹은 것·산 것    | 동행, 기억나는 장면, 또 갈지       |
 */
export type PostKind = "restaurant" | "product" | "daily";
export const POST_KINDS: PostKind[] = ["restaurant", "product", "daily"];
export const KIND_LABEL: Record<PostKind, string> = { restaurant: "맛집", product: "제품 후기", daily: "일상" };
export function asKind(v: unknown): PostKind {
  return POST_KINDS.includes(v as PostKind) ? (v as PostKind) : "restaurant";
}

/* ------------------------------------------------------------------ *
 * 1단계 — 사진 분석
 * ------------------------------------------------------------------ */

export type InputPhoto = {
  /** 화면에서 붙인 순번. 결과를 사진에 다시 이어 붙일 때 쓴다 */
  index: number;
  mimeType: string;
  /** base64 (data: 접두사 없이) */
  data: string;
};

export type PhotoNote = {
  index: number;
  /** 외관 | 내부 | 메뉴판 | 음식 | 영수증 | 기타 */
  kind: string;
  /** 사진에 실제로 보이는 것. 추측 금지 */
  caption: string;
};

export type MenuItem = { name: string; price: number | null };

export type PhotoAnalysis = {
  photos: PhotoNote[];
  /** 메뉴판·영수증 사진에서 읽은 것만. 가격의 유일한 근거다 */
  menu: MenuItem[];
  /** 영수증이 있을 때만 */
  receipt: { items: string[]; total: number | null; people: number | null } | null;
  /** 사진에서 직접 확인되는 사실 문장들 */
  observations: string[];
  /** 모델이 사진만으로는 확신하지 못한 것 */
  uncertain: string[];
  /** 제품 후기에서 상세페이지 캡처를 따로 올렸을 때만. 판매처가 밝힌 사실 */
  detail?: DetailFacts;
};

export type DetailFacts = {
  productName: string;
  facts: { label: string; value: string }[];
};

/*
 * OpenAI strict 스키마: 객체마다 additionalProperties:false, 키는 전부 required.
 * 없을 수 있는 값(못 읽은 가격, 영수증 없음)은 null 을 허용해 표현한다.
 */
/** 사진 종류. 글 종류마다 찍는 것이 달라 고를 목록도 다르다 */
const PHOTO_KINDS: Record<PostKind, string[]> = {
  restaurant: ["외관", "내부", "메뉴판", "음식", "영수증", "기타"],
  product: ["패키지", "구성품", "제품", "사용 장면", "라벨·스펙", "가격표·영수증", "기타"],
  daily: ["장소", "풍경", "음식", "물건", "사람(뒷모습 등)", "기타"],
};

function analysisSchema(kind: PostKind) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      photos: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "integer" },
            kind: { type: "string", enum: PHOTO_KINDS[kind] },
            caption: { type: "string" },
          },
          required: ["index", "kind", "caption"],
        },
      },
      menu: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, price: { type: ["integer", "null"] } },
          required: ["name", "price"],
        },
      },
      receipt: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          items: { type: "array", items: { type: "string" } },
          total: { type: ["integer", "null"] },
          people: { type: ["integer", "null"] },
        },
        required: ["items", "total", "people"],
      },
      observations: { type: "array", items: { type: "string" } },
      uncertain: { type: "array", items: { type: "string" } },
    },
    required: ["photos", "menu", "receipt", "observations", "uncertain"],
  };
}

const RESTAURANT_ANALYSIS = `너는 음식점 방문 사진을 읽어 **사실만** 뽑아내는 분석기다.

사진 순서대로 번호가 매겨져 있다. 각 사진에 대해:

1. kind 를 고른다 — 외관 / 내부 / 메뉴판 / 음식 / 영수증 / 기타
2. caption 에 **사진에 실제로 보이는 것**을 한 줄로 쓴다

메뉴판 사진이 있으면 menu 에 **적힌 그대로** 메뉴명과 가격을 옮긴다. 이것이 이 글에서
가격의 유일한 근거다. 흐리거나 잘려서 못 읽는 항목은 넣지 말고 uncertain 에 적는다.
가격을 추측해서 채우지 마라. 메뉴명은 읽었는데 가격이 안 보이면 price 는 null 이다.

영수증 사진이 있으면 receipt 에 주문 항목·총액·인원을 옮긴다. 영수증이 없으면 receipt 는
null 이고, 총액·인원을 못 읽으면 그 칸만 null 이다.

observations 에는 **사진에서 직접 확인되는 사실**만 문장으로 적는다. 예:
  좋음: "테이블 6개 규모의 작은 홀이고 좌석은 전부 의자석"
  좋음: "국밥에 깍두기와 부추무침이 함께 나옴"
  나쁨: "정갈하고 깔끔한 분위기라 데이트하기 좋다"  ← 평가이지 관찰이 아니다
  나쁨: "웨이팅이 길다"  ← 사진으로 알 수 없다

확신이 안 서는 것은 observations 가 아니라 uncertain 에 넣는다. 음식 이름을 특정하기
어려우면 "붉은 국물의 탕 요리"처럼 보이는 대로 적고 uncertain 에 남긴다.

**절대 하지 마라**: 맛 평가, 분위기 형용, 가격 추측, 사진에 없는 메뉴 언급,
사장님이나 직원에 대한 서술, 대기 시간 추정.`;

const PRODUCT_ANALYSIS = `너는 제품 후기용 사진을 읽어 **사실만** 뽑아내는 분석기다.

사진 순서대로 번호가 매겨져 있다. 각 사진에 대해:

1. kind 를 고른다 — 패키지 / 구성품 / 제품 / 사용 장면 / 라벨·스펙 / 가격표·영수증 / 기타
2. caption 에 **사진에 실제로 보이는 것**을 한 줄로 쓴다 (모양·색·크기감·재질처럼 눈에 보이는 것)

menu 에는 가격표·영수증·주문 화면에 **적힌 그대로** 제품명과 가격을 옮긴다. 가격의 유일한 근거다.
못 읽으면 넣지 말고 uncertain 에 적는다. 가격을 추측하지 마라.
receipt 는 영수증·주문 내역이 있을 때만 채운다(people 은 null).

observations 에는 사진으로 확인되는 사실만: 제품명·모델명(패키지·라벨에 적힌 그대로), 구성품 목록,
용량·크기 표기, 색상, 사용 장면의 환경(책상 위, 원룸 주방 등).
  나쁨: "성능이 좋아 보인다", "고급스럽다" ← 평가이지 관찰이 아니다

**절대 하지 마라**: 성능·효과 평가, 가격 추측, 사진에 없는 스펙, 브랜드 홍보 문구.`;

const DAILY_ANALYSIS = `너는 일상 기록용 사진을 읽어 **사실만** 뽑아내는 분석기다.

사진 순서대로 번호가 매겨져 있다. 각 사진에 대해:

1. kind 를 고른다 — 장소 / 풍경 / 음식 / 물건 / 사람(뒷모습 등) / 기타
2. caption 에 **사진에 실제로 보이는 것**을 한 줄로 쓴다

menu 에는 메뉴판·영수증·가격표에 **적힌 그대로** 이름과 가격을 옮긴다. 없으면 빈 배열.
receipt 는 영수증이 있을 때만.

observations 에는 사진으로 확인되는 사실만: 장소의 모습, 날씨·계절감(하늘, 옷차림, 단풍 등),
시간대 단서(밝기, 조명), 간판·안내판에 적힌 이름.
  나쁨: "힐링되는 하루였다" ← 감상은 사람이 말한다

**절대 하지 마라**: 감상·평가, 사람 얼굴 묘사, 사진에 없는 장소 언급, 가격 추측.`;

const ANALYSIS_PROMPTS: Record<PostKind, string> = {
  restaurant: RESTAURANT_ANALYSIS,
  product: PRODUCT_ANALYSIS,
  daily: DAILY_ANALYSIS,
};

export async function analyzePhotos(photos: InputPhoto[], kind: PostKind = "restaurant"): Promise<PhotoAnalysis> {
  if (!photos.length) throw new Error("사진이 없습니다.");

  /*
   * 이미지마다 "--- 사진 N ---" 이름표를 바로 앞에 붙인다. 모델이 돌려주는 index 를
   * 화면의 사진에 다시 이어 붙이는 유일한 끈이다.
   *
   * temperature 는 주지 않는다. gpt-5 계열은 받지 않고(400), 날조 억제는 프롬프트와
   * strict 스키마가 맡는다.
   */
  const parsed = await withContext("사진 분석", () =>
    openaiJson<any>({
      user: ANALYSIS_PROMPTS[kind],
      images: photos.map((p) => ({
        mimeType: p.mimeType,
        data: p.data,
        label: `--- 사진 ${p.index} ---`,
      })),
      schema: analysisSchema(kind),
      schemaName: "photo_analysis",
    }),
  );
  return {
    photos: Array.isArray(parsed.photos) ? parsed.photos : [],
    menu: Array.isArray(parsed.menu)
      ? parsed.menu.map((m: any) => ({
          name: String(m?.name ?? "").trim(),
          price: Number.isFinite(m?.price) ? Number(m.price) : null,
        })).filter((m: MenuItem) => m.name)
      : [],
    receipt: parsed.receipt?.items?.length
      ? {
          items: parsed.receipt.items.map((s: unknown) => String(s)),
          total: Number.isFinite(parsed.receipt.total) ? Number(parsed.receipt.total) : null,
          people: Number.isFinite(parsed.receipt.people) ? Number(parsed.receipt.people) : null,
        }
      : null,
    observations: (parsed.observations ?? []).map((s: unknown) => String(s)).filter(Boolean),
    uncertain: (parsed.uncertain ?? []).map((s: unknown) => String(s)).filter(Boolean),
  };
}

/* ------------------------------------------------------------------ *
 * 상세페이지 캡처 — 판매처가 밝힌 제품 사실
 *
 * 쇼핑몰 상세페이지는 자동 수집이 막혀 있고 내용도 대부분 긴 이미지라, 사람이 보면서 스펙
 * 부분을 캡처해 올린다. 여기서는 **사실만**(용량·크기·구성품·기능) 뽑는다. 홍보 문구를 옮기면
 * 네이버 유사문서에 걸리고, 내 경험처럼 읽히면 안 되므로 본문에는 "판매처 설명에 따르면" 으로 쓴다.
 * 캡처는 분석에만 쓰고 블로그 사진 순서에는 넣지 않는다(남의 상세 이미지를 올리지 않게).
 * ------------------------------------------------------------------ */

const DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    productName: { type: "string" },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
    },
  },
  required: ["productName", "facts"],
};

const DETAIL_PROMPT = `쇼핑몰 상품 상세페이지를 사람이 캡처한 이미지들이다. 이 제품에 대해 **판매처가 적어 둔 사실**만 뽑는다.

- productName: 캡처에 적힌 정확한 제품명·모델명. 없으면 빈 문자열
- facts: 항목(label)과 값(value) 쌍. 예) 용량 / 500ml, 무게 / 1.4kg, 구성품 / 본체·충전기·필터 2개,
  소재 / 스테인리스, 연속 사용 시간 / 최대 40분, 세척 / 식기세척기 사용 가능, 인증 / KC 인증
  값은 캡처에 적힌 수치·표현 그대로 짧게. 최대 15개, 구매 판단에 중요한 것부터
- 넣지 않는 것: 홍보 문구·형용사("최고의", "프리미엄", "압도적인"), 할인·이벤트·쿠폰, 배송 안내,
  다른 구매자 후기, 흐리거나 잘려서 확실히 못 읽은 값`;

export async function analyzeDetailShots(images: InputPhoto[]): Promise<DetailFacts> {
  if (!images.length) return { productName: "", facts: [] };
  const d = await withContext("상세페이지 분석", () =>
    openaiJson<DetailFacts>({
      user: DETAIL_PROMPT,
      images: images.map((p) => ({ mimeType: p.mimeType, data: p.data, label: `--- 캡처 ${p.index} ---` })),
      schema: DETAIL_SCHEMA,
      schemaName: "detail_facts",
    }),
  );
  return {
    productName: String(d.productName ?? "").trim(),
    facts: (d.facts ?? [])
      .map((f) => ({ label: String(f.label ?? "").trim(), value: String(f.value ?? "").trim() }))
      .filter((f) => f.label && f.value)
      .slice(0, 15),
  };
}

/* ------------------------------------------------------------------ *
 * 장소 확인 — 카카오에서 못 찾으면 폐업을 의심한다
 * ------------------------------------------------------------------ */

export type PlaceCheck = {
  place: Place | null;
  candidates: Place[];
  /** 사람이 확인해야 할 것. 비어 있어야 생성으로 넘어간다 */
  warnings: string[];
};

export async function checkPlace(query: string): Promise<PlaceCheck> {
  let candidates: Place[] = [];
  const warnings: string[] = [];

  try {
    candidates = await searchPlaces(query);
  } catch (e) {
    // 카카오가 죽어도 글은 쓸 수 있어야 한다. 보강이 없을 뿐이다
    warnings.push(`장소 조회 실패 — ${(e as Error).message}`);
    return { place: null, candidates: [], warnings };
  }

  if (!candidates.length) {
    warnings.push(
      "카카오 지도에서 이 가게를 찾지 못했습니다. **폐업했거나 이전했을 수 있습니다.** " +
        "상호를 다시 확인하거나, 없어진 가게라면 회고 톤으로 쓸지 정하세요.",
    );
    return { place: null, candidates: [], warnings };
  }

  if (candidates.length > 1) {
    warnings.push(`같은 이름의 후보가 ${candidates.length}곳입니다. 맞는 곳을 고르세요.`);
  }
  return { place: candidates[0], candidates, warnings };
}

/* ------------------------------------------------------------------ *
 * 검색 조사 — 기억이 비는 자리를 공개 정보로 채운다
 *
 * 오래전 방문이라 사람은 세부를 기억하지 못한다. 그렇다고 본문에 "기억이 안 나요"
 * 라고 쓰면 읽는 사람에게 무성의해 보인다. 가게 소개, 대표 메뉴가 어떤 음식인지,
 * 어느 역 근처인지는 검색하면 나오는 정보라 사람의 기억이 필요 없다.
 *
 * 조사는 Gemini(구글 검색 그라운딩)가 하고, 결과를 평문 그대로 GPT 프롬프트에 넣는다.
 * 실패해도 글은 나와야 하므로 오류는 삼키고 null 을 돌려준다.
 * ------------------------------------------------------------------ */

export type ResearchInput = {
  placeQuery: string;
  place: Place | null;
  analysis: PhotoAnalysis;
  kind?: PostKind;
};

export function buildVisitResearchPrompt(o: ResearchInput): string {
  if (o.kind === "product") return productResearchPrompt(o);
  if (o.kind === "daily") return dailyResearchPrompt(o);
  const { place, analysis: a } = o;
  const who = place
    ? `${place.name} (${place.address}, ${place.category})`
    : o.placeQuery;
  const menu = a.menu.map((m) => m.name);
  const food = a.photos.filter((p) => p.kind === "음식").map((p) => p.caption);

  return [
    "아래 음식점의 방문 후기를 쓰려 합니다. 구글 검색으로 이 가게와 메뉴에 대한 공개 정보를 조사하세요. 글은 쓰지 마세요.",
    `가게: ${who}`,
    menu.length ? `메뉴판·영수증에서 읽은 메뉴: ${menu.join(", ")}` : null,
    food.length ? `사진에 찍힌 음식: ${food.join(" / ")}` : null,
    "",
    "조사할 것:",
    "- 가게 소개: 어떤 곳으로 알려져 있는지, 대표 메뉴, 매장 특징(좌석·분위기·혼밥 여부 등)",
    "- 메뉴: 위 메뉴와 사진 속 음식이 어떤 음식인지, 보통 어떤 구성·맛으로 소개되는지",
    "- 위치: 가까운 지하철역·동네, 찾아가는 법, 주차",
    "- 최근 알려진 메뉴 가격이 있으면 '몇 년 기준'인지와 함께",
    "",
    "- 이 가게에 대한 정보인지 확실하지 않으면 적지 말 것. 같은 이름의 다른 지점과 섞지 말 것.",
    "- 검색으로 확인되지 않은 항목은 '확인되지 않음'이라고 적을 것. 추정으로 채우지 말 것.",
    "- 영업시간·휴무일은 자주 바뀌므로 조사하지 말 것.",
    "- 출력은 마크다운 불릿만. 서론·결론 없이 한 줄씩.",
  ]
    // 빈 문자열은 문단 구분이라 남기고, 재료가 없는 줄(null)만 뺀다
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * 제품 조사. 스펙·정가·비슷한 제품은 검색으로 나오지만 "써 보니 어땠는지" 는 사람만 안다.
 * 남의 후기 문장은 가져오지 않는다 — 요약해 넣으면 유사문서로 걸리고, 내 경험처럼 읽힌다.
 */
function productResearchPrompt(o: ResearchInput): string {
  const a = o.analysis;
  const seen = a.observations.slice(0, 6);
  return [
    "아래 제품의 사용 후기를 쓰려 합니다. 구글 검색으로 이 제품의 공개 정보를 조사하세요. 글은 쓰지 마세요.",
    `제품: ${o.placeQuery}`,
    seen.length ? `사진에서 확인된 것: ${seen.join(" / ")}` : null,
    "",
    "조사할 것:",
    "- 정확한 제품명·모델명, 제조사, 출시 시기",
    "- 공식 스펙(크기·무게·용량·소재·배터리 등 제품군에 맞는 것)과 구성품",
    "- 공식 정가 또는 최근 판매가 범위 — '몇 년 몇 월 기준'인지와 함께",
    "- 같은 가격대에서 자주 비교되는 제품 1~2개와 비교 포인트(스펙 차이만)",
    "- 공식 사용·관리 방법이나 주의사항이 있으면",
    "",
    "- 다른 사람 후기의 감상·평가 문장은 가져오지 말 것. 사실(스펙·가격·출시)만.",
    "- 이 제품이 맞는지 확실하지 않으면 적지 말 것. 비슷한 이름의 다른 모델과 섞지 말 것.",
    "- 확인되지 않은 항목은 '확인되지 않음'이라고 적을 것.",
    "- 출력은 마크다운 불릿만. 서론·결론 없이 한 줄씩.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** 일상 조사. 장소가 확인됐을 때만 의미가 있다 — 동네 산책 같은 글은 조사할 게 거의 없다 */
function dailyResearchPrompt(o: ResearchInput): string {
  const who = o.place ? `${o.place.name} (${o.place.address}, ${o.place.category})` : o.placeQuery;
  return [
    "아래 장소·주제로 일상 기록 글을 쓰려 합니다. 구글 검색으로 공개 정보만 조사하세요. 글은 쓰지 마세요.",
    `장소·주제: ${who}`,
    "",
    "조사할 것:",
    "- 어떤 곳인지(공원·카페·전시·거리 등), 알려진 특징",
    "- 가까운 지하철역·찾아가는 법, 주차",
    "- 입장료·이용 요금이 있으면 '몇 년 기준'인지와 함께",
    "- 계절마다 볼 만한 것(단풍·벚꽃 명소 여부 등)이 알려져 있으면",
    "",
    "- 영업시간·휴무일은 조사하지 말 것. 확인되지 않은 항목은 '확인되지 않음'.",
    "- 다른 사람의 감상 문장은 가져오지 말 것.",
    "- 출력은 마크다운 불릿만.",
  ].join("\n");
}

export async function researchVisit(o: ResearchInput & { retries?: number }): Promise<ResearchResult | null> {
  try {
    const r = parseGrounding(
      await geminiCall(
        DEFAULT_MODEL,
        {
          contents: [{ role: "user", parts: [{ text: buildVisitResearchPrompt(o) }] }],
          // 그라운딩은 responseSchema 와 같이 못 쓴다. 평문으로 받는다
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2 },
        },
        { retries: o.retries },
      ),
    );
    return r.text ? r : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 2단계 — 인터뷰
 *
 * 사실은 전부 자동으로 채워지므로 사람에게 물을 것은 감상뿐이다. 휴대폰에서
 * 출퇴근길에 답하는 것을 전제로 객관식 위주 네 문항으로 끝낸다.
 * ------------------------------------------------------------------ */

export type Interview = {
  /** 혼자 | 친구 | 가족 | 연인 | 회식 */
  company: string;
  /** 점심 | 저녁 | 그 외 */
  mealTime: string;
  /** 제일 기억나는 것 한 줄. 이 글에서 유일하게 대체 불가능한 정보다 */
  memorable: string;
  /** 응 | 아니 | 근처 오면 */
  revisit: string;
  /** 아쉬웠던 점. 비어도 된다 */
  downside?: string;
  /**
   * 없음 | 10분 내외 | 30분 이상 | 모름.
   * 상위 맛집 후기는 웨이팅을 방문 시간대와 한 세트로 꼭 적는다. 사진으로는 알 수 없어 묻는다
   */
  waiting?: string;
  /** 1인석·바 | 테이블 | 좌식 | 모름. 혼밥 글에서 가장 많이 찾는 정보다 */
  seat?: string;
  /** 체험단·협찬 글이면 첫머리에 대가성 문구를 넣는다(표시광고법) */
  sponsored?: boolean;

  /* ---- 제품 후기 ---- */
  /** 1주 미만 | 1개월 | 3개월 | 6개월 이상. 내구성·익숙해진 뒤 평가의 근거다 */
  usagePeriod?: string;
  /** "원룸 자취방, 퇴근 후 매일" 처럼 어디서 어떻게 쓰는지. 제목 공식(제품명+사용 환경+핵심 특징)의 재료 */
  usageEnv?: string;
  /** 이런 사람에게 맞다 / 안 맞다 */
  recommendFor?: string;
  /** 응 | 아니 | 글쎄 */
  rebuy?: string;
  /** "쿠팡 39,000원" 처럼 산 곳과 값. 비우면 가격은 사진·조사에서만 */
  priceNote?: string;
  /** 산 이유와 전에 쓰던 것. 상위 제품 후기 18편 중 13편이 "산 계기" 장면으로 시작한다 */
  reason?: string;
  /**
   * 네이버 쇼핑 커넥트 링크(브랜드 커넥트에서 발급한 naver.me 등). 쇼핑 커넥트는 API 가 없어
   * 사람이 발급해 붙여 넣는다. 있으면 첫 줄 대가성 문구와 링크 자리를 코드가 넣는다.
   */
  shopLink?: string;

  /* ---- 일상 ---- */
  /** 그날 기분·한 줄 감상 */
  mood?: string;
};

export const INTERVIEW_FIELDS = {
  usagePeriod: ["1주 미만", "1개월", "3개월", "6개월 이상"],
  rebuy: ["응", "아니", "글쎄"],
  company: ["혼자", "친구", "가족", "연인", "회식"],
  mealTime: ["점심", "저녁", "그 외"],
  revisit: ["응", "아니", "근처 오면"],
  waiting: ["없음", "10분 내외", "30분 이상", "모름"],
  seat: ["1인석·바", "테이블", "좌식", "모름"],
} as const;

/* ------------------------------------------------------------------ *
 * 3단계 — 본문 생성
 * ------------------------------------------------------------------ */

export type VisitDraft = {
  /** 3안. 첫 번째가 추천 */
  titles: string[];
  bodyMarkdown: string;
  bodyHtml: string;
  tags: string[];
  /** 업로드 순서와 각 자리 설명 */
  photoOrder: { index: number; note: string }[];
  /** 근거가 약해 사람이 확인해야 하는 문장 */
  needsCheck: string[];
};

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    titles: { type: "array", items: { type: "string" } },
    bodyMarkdown: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    photoOrder: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { index: { type: "integer" }, note: { type: "string" } },
        required: ["index", "note"],
      },
    },
    needsCheck: { type: "array", items: { type: "string" } },
  },
  required: ["titles", "bodyMarkdown", "tags", "photoOrder", "needsCheck"],
};

/**
 * 페르소나.
 *
 * 고정 정체성은 여기 두고, 글마다 바뀌는 상황(`situation`)만 인자로 받는다. 정체성이
 * 고정돼야 글끼리 일관되고, 그래야 C-Rank 의 주제 집중도가 쌓인다.
 *
 * 말투를 바꾸려면 이 문자열만 고치면 된다.
 */
export const PERSONA = `- 20대 중반, 서울 관악구에서 자취하는 회사원. 관악·신림 맛집과 자취 직장인의 일상·살림템을 기록한다
- 혼밥도 자주 하고 웨이팅은 싫어한다. 그래서 "기다릴 만한 집인지"를 꼭 짚어준다
- 원룸 살림이라 물건은 크기·수납·가성비를 따진다
- 말투: 친근한 존댓말 ("~했어요", "~더라구요", "~인 거 있죠")
- 톤: 신나게 소개하되 솔직하다. 좋은 건 확실히 좋다고, 아쉬운 건 아쉽다고 쓴다
- 맛 표현은 뭉뚱그리지 않고 구체적으로 ("겉은 바삭한데 속은 촉촉", "공기밥 하나 더 시킬 뻔")`;

/**
 * 맛집 블로거 작법.
 *
 * 처음엔 "담백하게, 사진에서 확인된 것만" 을 강조했더니 글이 사진 설명문이 됐다 —
 * "~이 보인다", "사진처럼 ~가 있다". 읽는 사람은 관찰 보고서가 아니라 **그 자리에
 * 있었던 사람의 이야기**를 원한다. 사진은 사용자가 직접 찍은 것이니 그 장면은 곧
 * 사용자의 경험이다. 1인칭 경험으로 옮겨 쓰게 한다.
 *
 * 날조 금지 규칙은 그대로다. 바뀐 건 "무엇을 쓰냐" 가 아니라 "어떻게 쓰냐" 다.
 * 체험단 글도 이 작법을 그대로 쓴다.
 */
const BLOGGER_STYLE = `**관찰 보고서가 아니라 다녀온 사람의 이야기로 쓴다.**
사진은 사용자가 그 자리에서 직접 찍은 것이다. 사진 속 장면은 곧 사용자의 경험이다.
  - 금지: "사진에 ~가 보인다", "~이 보입니다", "사진을 보면", "사진처럼", "확인된다"
  - 바꿔 쓰기:
    "메뉴판에 국밥과 수육이 보인다" → "메뉴는 국밥이랑 수육 딱 두 가지라 고민할 게 없었어요"
    "뚝배기에 국물과 고기가 담겨 있다" → "뚝배기가 넘칠 듯이 고기가 들어 있어서 일단 사진부터 찍었어요"
    "내부는 테이블석으로 되어 있다" → "안은 테이블석이라 혼자 가도 부담 없는 분위기예요"

글의 흐름 (상위 노출 맛집 후기 16편을 실제로 열어 본 공통 구조):
  1. 도입 2~4줄 — 가벼운 인사 한마디 + 방문 계기(퇴근길에 눈여겨봤다, 웨이팅 없는 데를 찾다가 등).
     "오늘은 ~를 소개해드릴게요" 로만 끝내지 않는다
  2. 정보 박스 — 도입 바로 다음. 아래 "정보 박스" 형식 그대로. 위아래를 \`---\` 구분선으로 감싼다
  3. 외관·찾아가는 길 → 내부·좌석(1인석·바 테이블 여부)
  4. 메뉴 — 뭘 시켰고 왜 골랐는지. 가격을 아는 메뉴는 \`수육국밥(9,500원)\` 처럼 괄호로,
     여러 개면 \`✔️ 주문 메뉴\` 목록으로 적는다
  5. 음식 — 이 글의 본론. 나왔을 때 첫인상, 비주얼, 양, 한 입 먹었을 때. 가장 길게
  6. 총평 — 한 줄 총평(맛·가격·혼밥 편의), 재방문 의사, 다음에 먹어볼 메뉴,
     "~찾는 분께 추천해요" 로 끝낸다

생동감:
  - 음식은 비주얼(색, 윤기, 양, 토핑, 그릇)을 사진에 맞게 생생하게 묘사한다
  - 주문한 메뉴의 맛·식감은 사진 속 상태와 검색 조사의 메뉴 특징에 어긋나지 않는 선에서
    1인칭으로 표현해도 된다. 단 "맛있다/별로다" 의 강도는 사용자 답변(기억나는 것,
    아쉬운 점, 재방문 의사)을 따른다. 사용자가 아쉽다고 한 걸 좋게 포장하지 않는다
  - 사용자가 "기억나는 것" 에 쓴 한 줄은 글의 하이라이트다. 음식 파트에서 크게 다룬다
  - 읽는 사람에게 말 걸듯 쓴다 ("이거 진짜 사진이 다 못 담아요", "혼밥러분들 여기 체크")
  - 메뉴마다 감각 표현 2개 이상(식감·온도·간·향·소리)과 먹는 방법 1개(소스 조합, 먼저 먹을 것)
  - 웨이팅은 방문 시간대와 한 세트로 쓴다 ("평일 저녁이었는데 대기 없이 바로 앉았어요").
    웨이팅을 싫어하는 페르소나라 이 정보를 꼭 챙긴다. 답변이 "모름" 이면 쓰지 않는다
  - 솔직한 아쉬운 점 1개를 장점과 균형 있게 넣는다. 답변에 없으면 사진·조사로 확인되는
    사소한 것(좌석이 좁다 등)만, 그것도 없으면 억지로 만들지 않는다
  - 쓸모 있는 팁 1~2개(주차, 덜 붐비는 시간, 추천 조합) — 근거가 있는 것만
  - 이모지는 정보 박스 라벨(📍⏰🚘)과 문단 끝 감정에 가끔. 한 문단에 하나 이하
  - 가게명은 입력된 표기 그대로 쓴다. 오타는 신뢰를 깎는다`;

/** AI 티를 생성 단계에서 막는다. humanize-korean 의 A·D·E·G·H·I 카테고리를 옮긴 것 */
const ANTI_AI = `- **문장 길이를 섞는다.** 단락마다 10자 미만 짧은 문장을 최소 1개
- 같은 어미 3연속 금지 ("~했어요. ~했어요. ~했어요.")
- 문두 접속사(그리고/또한/하지만/그래서) 연속 사용 금지
- "~인 것 같아요" 류 헤지는 글 전체 2회 이하
- 이중피동("보여지는", "생각되어지는") 금지
- 금지 표현: 결론적으로, ~를 통해, 시사하는 바가 크다, 단연 최고, 인생 맛집, 인생 ○○,
  강력 추천, 정갈한, 눈과 입이 모두 즐거운, 오늘은 ~를 소개해드리려고 합니다,
  200%, 남녀노소, 장점의 총집합, 맛이 없을 수 없는 맛, 풍미를 살려준다
- "맛있어요" 만 단독으로 반복하지 않는다. 왜 맛있었는지를 쓴다`;

/**
 * 네이버 SEO 규칙.
 *
 * 주의 — `/write` 의 블로그 프롬프트와 다르다. 저쪽은 정보성 글이라 답변엔진(AEO)
 * 최적화가 중심이지만, 방문 후기는 **체류시간**이 전부다. 소제목·이모지·볼드를
 * 걷어내면 오히려 손해라 남긴다.
 */
const SEO_RULES = `- 본문 공백 제외 1,200~2,200자
- 인용구 소제목 4~6개. 소제목은 "산더미처럼 쌓여 나온 수육" 처럼 장면을 묘사하는 문장형으로
- 사진 자리 \`[사진 N]\` 은 가진 사진을 모두 쓴다. 사진 사이 텍스트는 1~4줄,
  음식 구간은 사진 1장에 1~2줄로 더 촘촘하게
- 모바일 줄바꿈: 한 줄 20자 안팎에서 줄을 바꾸고(마크다운 줄바꿈), 2~4줄마다 빈 줄로 문단을 나눈다.
  한 문단은 3문장 이내
- 태그 15~20개: 지역 변형(예: 신림, 신림역, 신림동, 관악구) + 메뉴 + 가게명 + 상황(혼밥, 점심, 퇴근후 등)
- 공감·댓글·이웃추가를 부탁하지 않는다`;

export type GenerateVisitOptions = {
  /** 사용자가 입력한 상호 또는 주소 */
  placeQuery: string;
  /** 사용자가 입력한 방문 날짜. "2024년 가을쯤" 처럼 대략이어도 된다 */
  visitedOn: string;
  analysis: PhotoAnalysis;
  place: Place | null;
  interview: Interview;
  /** 이 글의 상황 한 줄. "이 블로그 첫 글", "여수 여행 2일차" 등 */
  situation?: string;
  /** 글 종류. 없으면 맛집 */
  kind?: PostKind;
  /** Gemini 검색 조사 결과. 없으면 사진·카카오·인터뷰만으로 쓴다 */
  research?: ResearchResult | null;
  /** 이미 쓴 초안을 사용자 요청대로 고쳐 쓸 때 준다 */
  revision?: Revision | null;
  /** 검색광고 월간 검색수로 고른 "지역 + 메뉴" 키워드. 많이 찾는 순 */
  keywords?: KeywordPick[];
  retries?: number;
};

export type Revision = {
  /** 지금 초안 전체(마크다운) */
  previous: string;
  /** 고칠 자리. 소제목 이름, "제목", "전체" 중 하나 */
  target: string;
  /** 어떻게 고칠지 사용자가 쓴 말 */
  request: string;
};

/**
 * 검색 키워드 블록.
 *
 * 없으면 GPT 가 "지역 + 메뉴" 를 감으로 고른다. 실제 검색수를 주면 사람들이 정말 치는
 * 표현("신림동 국밥" 이 아니라 "신림 국밥")을 제목 앞에 둔다.
 */
function keywordBlock(keywords?: KeywordPick[]): string {
  if (!keywords?.length) return "";
  const [main, ...rest] = keywords;
  return `
# 검색 키워드 (네이버 검색광고 — 월간 검색수)
${keywords.map((k) => `  - ${k.keyword}: ${k.searches.toLocaleString()}회`).join("\n")}

메인 키워드는 "${main.keyword}" 다. 제목 3안 모두 이 표현을 앞쪽에 그대로 넣고, 첫 문단에도
자연스럽게 한 번 넣는다.${rest.length ? ` 나머지(${rest.map((k) => k.keyword).join(", ")})는 본문과 태그에 억지스럽지 않게 한두 번씩 녹인다.` : ""}
키워드를 반복해 채우지 않는다. 같은 키워드는 본문에서 세 번을 넘기지 않는다.
`;
}

/**
 * 수정 요청 블록.
 *
 * 처음부터 다시 쓰게 하면 사용자가 마음에 들어 한 부분까지 바뀐다. 이전 초안을 통째로
 * 주고 **요청한 자리만** 고치게 한다. 재료(사진·답변)는 그대로 주므로 고친 부분도
 * 날조 금지 규칙을 따른다.
 */
function revisionBlock(r: Revision): string {
  const whole = r.target === "전체";
  return `

# 수정 요청 — 이번 작업은 새로 쓰기가 아니라 고쳐 쓰기다
아래 "이전 초안" 을 바탕으로 사용자의 요청을 반영해 다시 낸다.
  고칠 자리: ${r.target}
  요청: ${r.request}

${
  whole
    ? "요청이 글 전체에 대한 것이다. 요청의 방향으로 전체를 다듬되, 이전 초안의 사실·사진 배치·흐름은 유지한다."
    : r.target === "제목"
      ? "제목 3안만 요청대로 새로 뽑는다. 본문·태그·사진 순서는 이전 초안 그대로 낸다."
      : `"${r.target}" 소제목 아래 내용만 고친다. 다른 소제목의 문장은 한 글자도 바꾸지 말고 그대로 낸다.`
}
이전 초안에 있던 가게·메뉴·위치 정보(검색 조사에서 온 것)는 근거가 있는 정보이니 지우지 않는다.
요청이 위 "절대 지어내지 마라" 와 부딪히면(예: 안 시킨 메뉴 맛을 넣어 달라) 지어내지 말고
needsCheck 에 이유를 적는다.

## 이전 초안
${r.previous}`;
}

/**
 * 제목 3안 — 검색형 1 + 홈피드형 2.
 *
 * 네이버는 검색 결과와 홈피드(추천) 두 길로 글을 보여주고, 잘 먹히는 제목이 다르다.
 * 검색은 키워드가 앞에 있어야 하고, 홈피드는 숫자·비교·의문·반전처럼 "눌러 보고 싶은"
 * 제목이 올라간다. 한 글에 두 길을 다 열어 두려고 안을 나눠 낸다.
 */
function titleRules(kind: PostKind): string {
  const search: Record<PostKind, string> = {
    restaurant: `\`[지역 맛집]\` 또는 \`지역 | \` 로 시작. 지역 → 상황(혼밥·퇴근길·웨이팅 없이) → 메뉴 → 가게명 → (후기).
    예: "[신림 맛집] 퇴근길 혼밥하기 좋은 순대국밥 OO집 솔직후기"`,
    product: `**제품명 + 사용 환경 + 핵심 특징**. 제품명(모델명까지)을 맨 앞에 두면 검색 의도가 분명해진다.
    사용 기간이 있으면 넣고, 끝에 \`(장단점, 가격)\` 같은 괄호 보조정보를 붙여도 된다.
    예: "OO 무선청소기 V8 원룸 자취방 3개월 사용 후기, 제일 좋았던 건 무게 (장단점)"`,
    daily: `장소·동네 이름을 앞에, 상황과 가게명을 뒤에. 일상 글이 검색에 걸리는 건 사실상 장소 이름뿐이다.
    예: "샤로수길 카페 OO 퇴근 후 혼자 쉬기 좋았던 곳". 장소가 없으면 "관악 자취일기 #3" 처럼 시리즈형`,
  };
  return `# 제목 3안 — 1안 검색형, 2·3안 홈피드형
1안 (검색형, 30~45자): ${search[kind]}
2·3안 (홈피드형): 아래 공식 중 **서로 다른 둘**. 검색 키워드(지역·메뉴·제품명·장소)는 뒤쪽에라도 남긴다.
  - 숫자형: 구체적인 숫자로 시작 ("9,500원에 수육이 이만큼", "3개월 써 보고 남은 장점 2개")
  - 비교형: 무엇이 얼마나 달라졌는지 ("전에 쓰던 것보다 무게가 절반", "본점이랑 뭐가 다를까")
  - 의문형: 읽는 사람이 자기는 어느 쪽인지 궁금하게 ("혼밥러에게 여기 괜찮을까?")
  - 반전형: 예상이 빗나간 지점 ("기대 안 했는데 사이드가 주인공", "싼 데는 이유가 있었다")
  숫자·비교·반전은 **재료(답변·사진·조사)에 있는 사실로만** 만든다. 없는 반전을 지어내면 낚시다.
  제목 이모지는 0~1개. "인생", "역대급", "무조건" 같은 과장은 쓰지 않는다.`;
}

/** 대가성 표시. 체험단·협찬이면 첫 줄 문구, 아니면 내돈내산 태그 */
function sponsorBlock(iv: Interview, kind: PostKind): string {
  if (iv.sponsored) {
    return `# 체험단·협찬 글이다
본문 **맨 첫 줄**에 "이 글은 업체로부터 제품·서비스를 제공받아 솔직하게 작성했습니다." 를 넣는다(표시광고법).
"내돈내산" 은 제목·태그·본문 어디에도 쓰지 않는다. 받은 것이라고 칭찬만 하지 않는다 — 아쉬운 점도 그대로 쓴다.`;
  }
  return kind === "daily"
    ? ""
    : `# 내 돈으로 산·간 것이다
태그에 "내돈내산" 을 하나 넣는다.`;
}

const MEMORY_GAP = `# 기억이 비는 자리
오래전 일이라 사용자는 세부를 다 기억하지 못한다. 그렇다고 **"기억이 안 나요",
"잘 기억나지 않지만", "기억이 가물가물" 같은 말은 쓰지 마라.** 읽는 사람에게 무성의해
보인다. 사용자 답변에 없는 부분은 아래 "검색 조사" 의 공개 정보와 사진에 보이는 것으로
채운다. 그래도 채울 게 없으면 그 이야기를 아예 꺼내지 않는다.`;

/** 사진 메모·가격 블록. 세 종류가 같은 모양이다 */
function photoBlocks(a: PhotoAnalysis, priceLabel: string): string {
  const menuBlock = a.menu.length
    ? a.menu.map((m) => `  - ${m.name}${m.price ? ` ${m.price.toLocaleString()}원` : " (가격 못 읽음)"}`).join("\n")
    : "  (사진에서 읽은 가격 없음 — 가격 근거가 없다)";
  return `# 사진에서 확인된 것 (분석기가 건조하게 적은 메모다. 문장을 그대로 옮기지 말고 1인칭 경험으로 바꿔 써라)
${a.observations.map((s) => `  - ${s}`).join("\n") || "  (없음)"}

# 사진 목록
${a.photos.map((p) => `  ${p.index}. [${p.kind}] ${p.caption}`).join("\n")}

# ${priceLabel} (사진에서 읽은 것)
${menuBlock}
${a.receipt ? `\n# 영수증\n  항목: ${a.receipt.items.join(", ")}${a.receipt.total ? `\n  총액: ${a.receipt.total.toLocaleString()}원` : ""}${a.receipt.people ? `\n  인원: ${a.receipt.people}명` : ""}` : ""}

# 확신하지 못한 것 (본문에 쓰지 마라)
${a.uncertain.map((s) => `  - ${s}`).join("\n") || "  (없음)"}`;
}

function researchText(o: GenerateVisitOptions, usage: string): string {
  if (!o.research?.text) return "  (조사 결과 없음)";
  return `${o.research.text}

이 정보는 **검색으로 찾은 공개 정보**다. ${usage} 다만 사용자가 직접 겪은 일처럼 쓰지 않는다.
"확인되지 않음"으로 적힌 항목은 쓰지 않는다. 검색으로 찾은 가격은 "최근 기준"임을 밝히고,
사진에서 읽은 가격과 다르면 사진 쪽을 산·방문한 당시 가격으로 쓴다.`;
}

const OUTPUT = (tags: string) => `# 출력
titles(3안, 위 제목 규칙 순서대로), bodyMarkdown, tags(${tags}), photoOrder(업로드 순서와 각 자리 설명),
needsCheck 를 JSON 으로 낸다.`;

export function buildVisitPrompt(o: GenerateVisitOptions): string {
  const kind = o.kind ?? "restaurant";
  const body = kind === "product" ? productPrompt(o) : kind === "daily" ? dailyPrompt(o) : restaurantPrompt(o);
  return body + (o.revision ? revisionBlock(o.revision) : "");
}

function restaurantPrompt(o: GenerateVisitOptions): string {
  const { analysis: a, place, interview: iv } = o;
  const placeBlock = place
    ? `  상호: ${place.name}\n  주소: ${place.address}\n  업종: ${place.category}`
    : `  (카카오에서 확인되지 않음 — 사용자가 입력한 "${o.placeQuery}" 만 있다)`;

  return `네이버 블로그에 올릴 **맛집 방문 후기**를 쓴다. 사용자가 실제로 다녀온 곳이고,
사진은 사용자가 그 자리에서 직접 찍은 것이다. 이웃들이 끝까지 읽고 "여기 가봐야겠다"
싶게 만드는 게 목표다. 사실은 아래 재료에서만 가져온다.

${MEMORY_GAP}

# 페르소나
${PERSONA}

# 맛집 블로거 작법
${BLOGGER_STYLE}

# 이 글의 상황
${o.situation?.trim() || "특별한 상황 없음. 평소처럼 다녀온 한 곳을 쓴다."}

# 방문 시점
${o.visitedOn}
오래된 방문이면 "작년 가을에 갔던 곳인데" 처럼 **시점을 밝힌다.** 숨기지 않는 쪽이
신뢰를 얻고, 사진의 시점과도 어긋나지 않는다.

# 가게 (카카오 로컬 — 공개 정보)
${placeBlock}

# 검색 조사 (Gemini — 구글 검색)
${researchText(o, "가게 소개, 메뉴가 어떤 음식인지, 위치·찾아가는 길을 설명하는 데 적극적으로 쓴다.\n  좋음: \"여기는 돼지국밥으로 알려진 곳이에요\", \"신림역 3번 출구에서 5분 거리예요\"\n  나쁨: \"사장님이 20년째 하신다고 직접 말씀해 주셨어요\"")}

${photoBlocks(a, "메뉴와 가격")}

# 사용자 답변
  동행: ${iv.company}
  시간대: ${iv.mealTime}
  기억나는 것: ${iv.memorable}
  재방문 의사: ${iv.revisit}
  웨이팅: ${iv.waiting || "모름"}
  좌석: ${iv.seat || "모름"}
${iv.downside?.trim() ? `  아쉬웠던 점: ${iv.downside}` : ""}

# 정보 박스 (도입 바로 다음에 이 형식 그대로. 값이 없는 줄은 뺀다)
---
📍 주소: ${place?.address || "(주소 모름 — 이 줄은 빼라)"}
🚇 가는 길: (검색 조사에 가까운 역·출구·도보 시간이 있으면 한 줄로. 없으면 이 줄은 빼라)
🚘 주차: (검색 조사에 있으면. 없으면 이 줄은 빼라)
🪑 좌석: ${iv.seat && iv.seat !== "모름" ? iv.seat : "(모름 — 이 줄은 빼라)"}${iv.company === "혼자" ? " / 혼밥 가능" : ""}
⏰ 영업시간: 방문 전 네이버 지도에서 확인해 주세요
---
영업시간·브레이크타임·전화번호는 지어내지 않는다. 위 문구를 그대로 둔다.

${sponsorBlock(iv, "restaurant")}

# 절대 지어내지 마라
다음은 위 재료에 근거가 없으면 **쓰지 않는다.** 하나라도 쓰면 이 글은 실패다.
  - 주문하지 않은 메뉴의 맛 평가 (어떤 음식인지 소개하는 건 검색 조사에 있으면 된다)
  - 사장님·직원과의 대화, 서비스로 받은 것
  - 사용자 답변에 없는 웨이팅 시간, 음식이 나온 속도
  - 재료 원산지, 조리법, 가게 역사 — 검색 조사에 있을 때만, 찾아본 정보라는 말투로
  - 다른 손님의 반응, 매장이 붐볐는지
  - "메뉴와 가격"에도 검색 조사에도 없는 가격. 근거가 없으면 **가격을 아예 언급하지 마라**

사진에서 읽은 가격은 "방문 당시 기준"임을 밝힌다. 지금 가격은 달라졌을 수 있다.

꼭 필요한데 근거가 애매한 문장은 본문에 쓰지 말고 needsCheck 배열에 넣어라.
사용자가 직접 판단한다.

${titleRules("restaurant")}

# SEO 규칙
${SEO_RULES}
${keywordBlock(o.keywords)}
# 문체 규칙
${ANTI_AI}

${OUTPUT("15~20개")}`;
}

/**
 * 제품 후기 작법.
 *
 * 제품 후기가 광고처럼 읽히는 순간 끝이다. 광고와 가르는 건 **사용 기간과 사용 환경**,
 * 그리고 아쉬운 점이다. 스펙은 조사로 채우되 "체감" 은 사용자 답변에서만 가져온다.
 */
const PRODUCT_STYLE = `**스펙표가 아니라 써 본 사람의 이야기로 쓴다.** 사진은 사용자가 직접 찍은 것이다.
  - 금지: "사진에 ~가 보인다", 공식 홍보 문구 옮겨 쓰기, "필수템·인생템·강력 추천"

글의 흐름:
  1. 도입 2~4줄 — 왜 샀는지, 어떤 불편이 있었는지 **구체적인 장면 하나**로. 제품명을 첫 문단에 한 번
  2. 정보 박스 — 도입 바로 다음. 아래 형식 그대로, 위아래 \`---\`
  3. 언박싱·구성품 — 사진 순서대로 짧게
  4. 디자인·크기감 — 사진에 보이는 것 + 사용 환경(원룸 책상 위 등)에 놓았을 때
  5. 실제로 써 보니 — 이 글의 본론. 사용 환경 속 장면으로. 가장 길게
  6. 좋았던 점 / 아쉬운 점 — \`👍\` \`👎\` 라벨 목록으로 각각 2~3개. 아쉬운 점을 반드시 1개 이상.
     단점 뒤에 곧바로 "다만 ~하면 괜찮아요" 같은 보완을 붙이지 않는다 — 광고·AI 티의 대표 신호다
  7. 이런 분께 추천 / 비추천 — \`✔\` 목록 2~3개. 사용자 답변의 추천 대상으로
  8. 한 줄 총평 + 재구매 의사

생동감:
  - 사용 기간을 꼭 밝힌다("3개월째 쓰는 중인데"). 기간보다 긴 내구성 판단은 하지 않는다
  - 스펙 숫자는 생활 비교로 풀어도 된다 — 사실인 비교만("1.5kg, 생수 1.5L 한 병 무게")
  - 사용자가 "가장 좋았던 점" 에 쓴 것이 글의 하이라이트다. 본론에서 크게 다룬다
  - 비교는 조사된 스펙 비교만. 다른 제품을 써 본 척하지 않는다("전에 쓰던 것" 답변이 있으면 그건 쓴다)
  - 스펙은 정보 박스에 2~3개만. 본문에 "공식몰 기준" 수치를 나열하지 않는다
  - 금지: FAQ 블록, "첫째/둘째/마지막으로", 모든 소제목에 제품명 반복, "살 만할까?" 식 소제목`;

const PRODUCT_SEO = `- 본문 공백 제외 1,500~2,500자
- 인용구 소제목 4~6개. "원룸에 두니 딱 이 정도 크기" 처럼 장면을 묘사하는 문장형
- 사진 자리 \`[사진 N]\` 은 가진 사진을 모두 쓴다. 사진 사이 텍스트는 1~4줄
- 모바일 줄바꿈: 한 줄 20자 안팎, 2~4줄마다 빈 줄. 한 문단은 3문장 이내
- 태그 10~15개: 제품명 변형(브랜드+모델, 모델만) + 제품 종류 + 사용 환경(자취템, 원룸, 직장인) + 후기류(내돈내산은 대가성 규칙대로)
- 구매 링크는 넣지 않는다(제휴 링크를 넣을 거면 사람이 대가성 문구와 함께 넣는다)
- 공감·댓글·이웃추가를 부탁하지 않는다`;

function productPrompt(o: GenerateVisitOptions): string {
  const { analysis: a, interview: iv } = o;
  const price = iv.priceNote?.trim() || (a.menu.find((m) => m.price)?.price ? `${a.menu.find((m) => m.price)!.price!.toLocaleString()}원 (사진에서 읽음)` : "");
  return `네이버 블로그에 올릴 **제품 사용 후기**를 쓴다. 사용자가 실제로 사서(또는 받아서) 써 본 제품이고,
사진은 사용자가 직접 찍은 것이다. 읽는 사람이 "나한테 맞는 물건인지" 판단할 수 있게 하는 게 목표다.
사실은 아래 재료에서만 가져온다.

${MEMORY_GAP}

# 페르소나
${PERSONA}

# 제품 후기 작법
${PRODUCT_STYLE}

# 이 글의 상황
${o.situation?.trim() || "특별한 상황 없음. 평소 쓰는 물건 하나를 소개한다."}

# 구매·사용 시점
${o.visitedOn}

# 제품 (사용자 입력)
  ${o.placeQuery}

# 검색 조사 (Gemini — 구글 검색)
${researchText(o, "정확한 제품명·모델명, 스펙, 구성품, 정가를 정보 박스와 설명에 쓴다.")}
${a.detail?.facts.length ? `
# 판매처 상세페이지에서 읽은 사실 (사용자가 캡처해 올림)
${a.detail.productName ? `  제품명: ${a.detail.productName}\n` : ""}${a.detail.facts.map((f) => `  - ${f.label}: ${f.value}`).join("\n")}

판매처가 밝힌 정보다. 정보 박스의 "주요 스펙" 과 본문 설명에 쓰되, 본문에서는 "판매처 설명에 따르면",
"상세페이지를 보니" 처럼 **출처를 드러내는 말투**로 쓴다. 내가 재 보거나 겪은 것처럼 쓰지 않는다.
사용자 경험(좋았던 점·아쉬운 점)과 부딪히면 사용자 경험을 따른다. 판매처 문장을 그대로 옮기지 않는다.
검색 조사와 값이 다르면 판매처 값을 쓴다(지금 파는 모델의 값이다).` : ""}

${photoBlocks(a, "가격 (가격표·영수증)")}

# 사용자 답변
  사용 기간: ${iv.usagePeriod || "모름"}
  사용 환경: ${iv.usageEnv?.trim() || "모름"}
  가장 좋았던 점: ${iv.memorable}
  아쉬운 점: ${iv.downside?.trim() || "(없음 — 사진·조사로 확인되는 사소한 것만, 없으면 억지로 만들지 않는다)"}
  추천 대상: ${iv.recommendFor?.trim() || "(없음)"}
  재구매 의사: ${iv.rebuy || "모름"}
  구매가·구매처: ${iv.priceNote?.trim() || "(없음)"}
  산 이유·전에 쓰던 것: ${iv.reason?.trim() || "(없음 — 도입은 사용 환경과 사진으로 짧게)"}
${iv.shopLink ? `
# 쇼핑 링크 자리
본문에 \`[쇼핑 링크]\` 를 **딱 두 번** 한 줄로 따로 둔다 — 정보 박스 바로 아래, 그리고 "이런 분께 추천" 바로 아래.
링크 주소는 쓰지 않는다(코드가 채운다). 대가성 문구도 쓰지 않는다(코드가 첫 줄에 넣는다).
링크는 두 곳뿐이다. 여러 번 넣으면 광고 글로 보인다.` : ""}

# 정보 박스 (도입 바로 다음에 이 형식 그대로. 값이 없는 줄은 뺀다)
---
📦 제품: (조사로 확인된 정확한 제품명·모델명. 없으면 "${o.placeQuery}")
💰 구매가: ${price || "(모름 — 이 줄은 빼라)"}
🗓️ 사용 기간: ${iv.usagePeriod && iv.usagePeriod !== "모름" ? iv.usagePeriod : "(모름 — 이 줄은 빼라)"}
🏠 사용 환경: ${iv.usageEnv?.trim() || "(모름 — 이 줄은 빼라)"}
📐 주요 스펙: (조사에 있는 것 2~3개만. 없으면 이 줄은 빼라)
---

${sponsorBlock(iv, "product")}

# 절대 지어내지 마라
  - 사용자 답변에 없는 기능 사용 경험, 사용 기간보다 긴 내구성 판단
  - 조사에 없는 스펙·가격·출시 정보
  - 다른 제품을 써 본 경험(답변에 없으면). 비교는 스펙 비교만
  - 화장품·식품·건강용품의 효능·효과 단정("피부가 좋아졌다", "살이 빠진다" 는 답변에 있을 때만, 개인 경험으로)
  - 업체 홍보 문구

꼭 필요한데 근거가 애매한 문장은 본문에 쓰지 말고 needsCheck 배열에 넣어라.

${titleRules("product")}

# SEO 규칙
${PRODUCT_SEO}
${keywordBlock(o.keywords)}
# 문체 규칙
${ANTI_AI}

${OUTPUT("10~15개")}`;
}

/**
 * 일상 작법.
 *
 * 일상 글은 검색보다 이웃과 홈피드로 읽힌다. 정보 밀도보다 "그날의 결" 이 중요하고,
 * 그래서 사람만 아는 것(누구랑, 어떤 기분이었는지)이 더 크게 들어간다. 검색에 걸리는
 * 건 장소 이름뿐이라 장소가 있으면 제목·정보 박스에 꼭 남긴다.
 */
const DAILY_STYLE = `**하루를 같이 걸은 것처럼** 쓴다. 사진은 사용자가 직접 찍은 것이다.
  - 금지: "사진에 ~가 보인다", 교훈으로 끝내기("소소한 행복이 중요하다는 걸 느꼈다")

글의 흐름 — 상위 일상 글 10편은 두 갈래였다. 장소가 확인됐으면 장소형, 아니면 모음형으로 쓴다.
  장소형:
    1. 계기 2~3줄(왜 갔는지, 어떤 날이었는지)
    2. 정보 박스 — 아래 형식, 위아래 \`---\`
    3. 장소별 인용구 소제목 + 장면(사진 1~2장마다 1~3줄)
    4. 총평 — 좋았던 점 / 아쉬웠던 점 / ⭐ 한줄평
  모음형:
    1. 도입 1~2줄(어떤 날·어떤 주였는지)
    2. 시간 순서대로 장면 — 사진 1~2장마다 1~3문장. 모든 사진에 설명을 달지 않아도 된다
    3. 사용자가 "기억나는 장면" 으로 쓴 것은 조금 길게
    4. 마무리 1~2줄 — 기분 한 줄 + 다음 계획

생동감:
  - 문장을 더 짧고 가볍게. 혼잣말 같은 짧은 문장, 가벼운 자조를 섞는다("날씨 미쳤다.", "강제 갓생 완료.")
  - 사소한 실패·아쉬움이 있으면 살린다(답변에 있을 때만) — 평범한 하루를 읽게 만드는 건 이런 장면이다
  - 계절·날씨·시간대 단서는 사진에 있을 때만 구체적으로
  - 먹은 것·산 것은 짧게. 가격은 사진·답변에 있을 때만`;

const DAILY_SEO = `- 본문 공백 제외 800~1,800자
- 소제목은 0~4개. 짧은 글이면 소제목 없이 장면만 이어도 된다
- 사진 자리 \`[사진 N]\` 은 가진 사진을 모두 쓴다. 사진 사이 텍스트는 1~3줄
- 모바일 줄바꿈: 한 줄 20자 안팎, 2~3줄마다 빈 줄
- 태그 10~15개: 장소명·가게명·동네(관악구카페, 샤로수길 등) + 상황(퇴근후산책, 주말일상, 직장인일상, 자취일상) + 계절.
  검색 유입은 장소·가게 이름으로만 들어온다
- 공감·댓글·이웃추가를 부탁하지 않는다`;

function dailyPrompt(o: GenerateVisitOptions): string {
  const { analysis: a, place, interview: iv } = o;
  return `네이버 블로그에 올릴 **일상 기록**을 쓴다. 사용자가 실제로 보낸 하루이고,
사진은 사용자가 직접 찍은 것이다. 이웃이 편하게 따라 읽다가 "나도 가보고 싶다" 싶게 만드는 게 목표다.
사실은 아래 재료에서만 가져온다.

${MEMORY_GAP}

# 페르소나
${PERSONA}

# 일상 작법
${DAILY_STYLE}

# 이 글의 상황
${o.situation?.trim() || "특별한 상황 없음. 평범한 하루를 기록한다."}

# 날짜
${o.visitedOn}

# 장소·주제
  ${place ? `${place.name} (${place.address}, ${place.category})` : o.placeQuery}

# 검색 조사 (Gemini — 구글 검색)
${researchText(o, "장소 소개, 찾아가는 길을 짧게 설명하는 데 쓴다.")}

${photoBlocks(a, "가격 (메뉴판·영수증)")}

# 사용자 답변
  동행: ${iv.company}
  기억나는 장면: ${iv.memorable}
  그날 기분: ${iv.mood?.trim() || "(없음)"}
  또 갈지: ${iv.revisit}
${iv.downside?.trim() ? `  아쉬웠던 점: ${iv.downside}` : ""}

${place ? `# 정보 박스 (장소가 확인됐다. 도입 다음에 이 형식 그대로. 값이 없는 줄은 뺀다)
---
📍 ${place.name}: ${place.address}
🚇 가는 길: (검색 조사에 있으면 한 줄로. 없으면 이 줄은 빼라)
💰 이용 요금: (검색 조사에 있으면. 없으면 이 줄은 빼라)
---` : "# 정보 박스\n장소가 확인되지 않았다. 정보 박스는 넣지 않는다."}

${sponsorBlock(iv, "daily")}

# 절대 지어내지 마라
  - 답변·사진에 없는 사건, 대화, 만난 사람
  - 사람의 외모 묘사
  - 사진에 없는 날씨·풍경 단정
  - 근거 없는 가격

꼭 필요한데 근거가 애매한 문장은 본문에 쓰지 말고 needsCheck 배열에 넣어라.

${titleRules("daily")}

# SEO 규칙
${DAILY_SEO}
${keywordBlock(o.keywords)}
# 문체 규칙
${ANTI_AI}

${OUTPUT("10~15개")}`;
}

export async function generateVisitDraft(o: GenerateVisitOptions): Promise<VisitDraft> {
  const d = await withContext("후기 생성", () =>
    openaiJson<any>({
      user: buildVisitPrompt(o),
      schema: DRAFT_SCHEMA,
      schemaName: "visit_draft",
      retries: o.retries,
    }),
  );
  const bodyMarkdown = withShopLink(String(d.bodyMarkdown ?? ""), o.interview.shopLink);
  const titles = (d.titles ?? []).map((t: unknown) => String(t).trim()).filter(Boolean);

  return {
    titles: titles.length ? titles : ["(제목을 받지 못했습니다)"],
    bodyMarkdown,
    // 네이버는 짧게 끊은 줄바꿈이 곧 서식이다. 줄을 이어 붙이지 않는다
    bodyHtml: markdownToHtml(bodyMarkdown, { lineBreaks: true }),
    tags: (d.tags ?? [])
      .map((t: unknown) => String(t).replace(/^#/, "").trim())
      .filter(Boolean),
    photoOrder: (d.photoOrder ?? [])
      .map((p: any) => ({ index: Number(p?.index), note: String(p?.note ?? "") }))
      .filter((p: { index: number }) => Number.isFinite(p.index)),
    needsCheck: (d.needsCheck ?? []).map((s: unknown) => String(s)).filter(Boolean),
  };
}

/** 네이버 쇼핑 커넥트 대가성 문구. 글 맨 첫 줄에 텍스트로 — 상위 노출 제휴 글에서 가장 흔하고 표시 기준에도 안전하다 */
export const SHOP_CONNECT_DISCLOSURE = "이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.";

/**
 * 쇼핑 커넥트 링크를 본문에 박는다. 모델에 맡기면 문구를 빠뜨리거나 링크를 여러 번 넣는다.
 *
 * - 첫 줄에 대가성 문구(이미 있으면 그대로)
 * - `[쇼핑 링크]` 자리를 "👉 제품 보러가기" 링크 줄로. 네이버 에디터에서 링크 카드로 바꾸기 쉽게 한 줄로 둔다
 * - 자리가 하나도 없으면 맨 끝에 한 번
 * 고쳐 쓰기로 다시 돌아도 문구·링크가 두 번 들어가지 않게 이미 있는지 먼저 본다.
 */
export function withShopLink(markdown: string, link?: string): string {
  const url = link?.trim();
  if (!url || !/^https:\/\/\S+$/.test(url)) return markdown.replace(/^.*\[쇼핑 링크\].*$/gm, "").replace(/\n{3,}/g, "\n\n");
  const line = `👉 [제품 보러가기](${url})`;
  let out = markdown.replace(/^.*\[쇼핑 링크\].*$/gm, line);
  if (!out.includes(url)) out = `${out.trimEnd()}\n\n${line}\n`;
  if (!out.includes(SHOP_CONNECT_DISCLOSURE)) out = `${SHOP_CONNECT_DISCLOSURE}\n\n${out.trimStart()}`;
  return out;
}

/** 어느 단계에서 실패했는지 오류 앞에 붙인다. 두 경로가 같은 모양으로 알리게 한 곳에 둔다 */
async function withContext<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}
