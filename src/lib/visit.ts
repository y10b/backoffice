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
 *  | 사람        | 누구랑, 어땠는지, 또 갈 건지 (30초 인터뷰)      |
 *
 * 셋 중 어디에도 없는 것은 **쓰지 않는다.** 안 시킨 메뉴의 맛, 사장님과의 대화,
 * 웨이팅 시간 — AI 가 후기를 쓸 때 반사적으로 지어내는 것들이라 프롬프트에 목록으로
 * 박아뒀다. 지어낸 방문기는 표시광고법 문제이기 전에 그 가게에 실제 피해를 준다.
 *
 * 사진 원본은 저장하지 않는다. 분석 결과만 남긴다 — 발행은 사용자가 휴대폰에서 직접
 * 하므로 서버가 원본을 들고 있을 이유가 없고, 무료 티어 용량도 아낀다.
 *
 * 모델은 OpenAI(GPT)다. 사용자가 채널별로 모델을 나눴다 — 네이버 후기 갈래는 GPT,
 * 티스토리 본문은 Gemini. 그래서 여기만 openai.ts 를 쓴다.
 */

import { openaiJson } from "./openai";
import { markdownToHtml } from "./markdown";
import { searchPlaces, type Place } from "./kakao";

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
};

/*
 * OpenAI strict 스키마: 객체마다 additionalProperties:false, 키는 전부 required.
 * 없을 수 있는 값(못 읽은 가격, 영수증 없음)은 null 을 허용해 표현한다.
 */
const ANALYSIS_SCHEMA = {
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
          kind: { type: "string", enum: ["외관", "내부", "메뉴판", "음식", "영수증", "기타"] },
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

const ANALYSIS_PROMPT = `너는 음식점 방문 사진을 읽어 **사실만** 뽑아내는 분석기다.

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

export async function analyzePhotos(photos: InputPhoto[]): Promise<PhotoAnalysis> {
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
      user: ANALYSIS_PROMPT,
      images: photos.map((p) => ({
        mimeType: p.mimeType,
        data: p.data,
        label: `--- 사진 ${p.index} ---`,
      })),
      schema: ANALYSIS_SCHEMA,
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
};

export const INTERVIEW_FIELDS = {
  company: ["혼자", "친구", "가족", "연인", "회식"],
  mealTime: ["점심", "저녁", "그 외"],
  revisit: ["응", "아니", "근처 오면"],
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
export const PERSONA = `- 20대 중반, 서울 관악구 거주, 회사원
- 혼밥 비중이 높고 웨이팅을 싫어한다
- 말투: 친근한 존댓말 ("~했어요", "~더라구요")
- 톤: 담백하고 솔직하다. 호불호를 분명히 말하되 과장하지 않는다. 별로면 별로라고 쓴다
- 맛 표현에 미사여구를 쌓지 않는다. 구체적인 비교로 설명한다
  ("생각보다 안 짜요", "양은 공기밥 추가해야 할 정도")`;

/** AI 티를 생성 단계에서 막는다. humanize-korean 의 A·D·E·G·H·I 카테고리를 옮긴 것 */
const ANTI_AI = `- **문장 길이를 섞는다.** 단락마다 10자 미만 짧은 문장을 최소 1개
- 같은 어미 3연속 금지 ("~했어요. ~했어요. ~했어요.")
- 문두 접속사(그리고/또한/하지만/그래서) 연속 사용 금지
- "~인 것 같아요" 류 헤지는 글 전체 2회 이하
- 이중피동("보여지는", "생각되어지는") 금지
- 금지 표현: 결론적으로, ~를 통해, 시사하는 바가 크다, 단연 최고, 인생 맛집,
  강력 추천, 여러분, 정갈한, 눈과 입이 모두 즐거운`;

/**
 * 네이버 SEO 규칙.
 *
 * 주의 — `/write` 의 블로그 프롬프트와 다르다. 저쪽은 정보성 글이라 답변엔진(AEO)
 * 최적화가 중심이지만, 방문 후기는 **체류시간**이 전부다. 소제목·이모지·볼드를
 * 걷어내면 오히려 손해라 남긴다.
 */
const SEO_RULES = `- 제목 28자 내외. \`지역 + 메뉴\` 핵심 키워드를 앞쪽에. 3안을 제시한다
- 첫 문단에 지역명과 메뉴 키워드가 자연스럽게 들어가야 한다. 인사말로 시작하지 않는다
- 공백 포함 1,500~2,500자
- 소제목 3~5개. 각 소제목 아래 사진 1~3장
- 사진 자리는 \`[사진 N]\` 으로 표시한다. 사진 사이에는 텍스트 2~4문장을 둔다
- 태그 10개: 지역 3 + 메뉴 3 + 상호 1 + 상황 3
- 마지막에 지도(장소) 첨부를 안내하는 한 줄`;

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
  retries?: number;
};

export function buildVisitPrompt(o: GenerateVisitOptions): string {
  const { analysis: a, place, interview: iv } = o;

  const menuBlock = a.menu.length
    ? a.menu.map((m) => `  - ${m.name}${m.price ? ` ${m.price.toLocaleString()}원` : " (가격 못 읽음)"}`).join("\n")
    : "  (메뉴판·영수증 사진이 없어 가격 근거가 없다)";

  const placeBlock = place
    ? `  상호: ${place.name}\n  주소: ${place.address}\n  업종: ${place.category}`
    : `  (카카오에서 확인되지 않음 — 사용자가 입력한 "${o.placeQuery}" 만 있다)`;

  return `네이버 블로그에 올릴 **방문 후기**를 쓴다. 사용자가 실제로 다녀온 곳이고,
사진이 그 증거다. 오래전 방문이라 세부는 기억하지 못하므로 아래 재료로만 쓴다.

# 페르소나
${PERSONA}

# 이 글의 상황
${o.situation?.trim() || "특별한 상황 없음. 평소처럼 다녀온 한 곳을 쓴다."}

# 방문 시점
${o.visitedOn}
오래된 방문이면 "작년 가을에 갔던 곳인데" 처럼 **시점을 밝힌다.** 숨기지 않는 쪽이
신뢰를 얻고, 사진의 시점과도 어긋나지 않는다.

# 가게 (카카오 로컬 — 공개 정보)
${placeBlock}

# 사진에서 확인된 것
${a.observations.map((s) => `  - ${s}`).join("\n") || "  (없음)"}

# 사진 목록
${a.photos.map((p) => `  ${p.index}. [${p.kind}] ${p.caption}`).join("\n")}

# 메뉴와 가격 (사진에서 읽은 것)
${menuBlock}
${a.receipt ? `\n# 영수증\n  주문: ${a.receipt.items.join(", ")}${a.receipt.total ? `\n  총액: ${a.receipt.total.toLocaleString()}원` : ""}${a.receipt.people ? `\n  인원: ${a.receipt.people}명` : ""}` : ""}

# 사용자 답변
  동행: ${iv.company}
  시간대: ${iv.mealTime}
  기억나는 것: ${iv.memorable}
  재방문 의사: ${iv.revisit}
${iv.downside?.trim() ? `  아쉬웠던 점: ${iv.downside}` : ""}

# 확신하지 못한 것 (본문에 쓰지 마라)
${a.uncertain.map((s) => `  - ${s}`).join("\n") || "  (없음)"}

# 절대 지어내지 마라
다음은 위 재료에 근거가 없으면 **쓰지 않는다.** 하나라도 쓰면 이 글은 실패다.
  - 주문하지 않은 메뉴의 맛 평가
  - 사장님·직원과의 대화, 서비스로 받은 것
  - 웨이팅 시간, 음식이 나온 속도
  - 재료 원산지, 조리법, 가게 역사, 몇 년 됐는지
  - 다른 손님의 반응, 매장이 붐볐는지
  - 위 "메뉴와 가격"에 없는 가격. 근거가 없으면 **가격을 아예 언급하지 마라**

가격을 쓸 때는 "방문 당시 기준"임을 밝힌다. 지금 가격은 달라졌을 수 있다.

꼭 필요한데 근거가 애매한 문장은 본문에 쓰지 말고 needsCheck 배열에 넣어라.
사용자가 직접 판단한다.

# SEO 규칙
${SEO_RULES}

# 문체 규칙
${ANTI_AI}

# 출력
titles(3안), bodyMarkdown, tags(10개), photoOrder(업로드 순서와 각 자리 설명),
needsCheck 를 JSON 으로 낸다.`;
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
  const bodyMarkdown = String(d.bodyMarkdown ?? "");
  const titles = (d.titles ?? []).map((t: unknown) => String(t).trim()).filter(Boolean);

  return {
    titles: titles.length ? titles : ["(제목을 받지 못했습니다)"],
    bodyMarkdown,
    bodyHtml: markdownToHtml(bodyMarkdown),
    tags: (d.tags ?? [])
      .map((t: unknown) => String(t).replace(/^#/, "").trim())
      .filter(Boolean),
    photoOrder: (d.photoOrder ?? [])
      .map((p: any) => ({ index: Number(p?.index), note: String(p?.note ?? "") }))
      .filter((p: { index: number }) => Number.isFinite(p.index)),
    needsCheck: (d.needsCheck ?? []).map((s: unknown) => String(s)).filter(Boolean),
  };
}

/** 어느 단계에서 실패했는지 오류 앞에 붙인다. 두 경로가 같은 모양으로 알리게 한 곳에 둔다 */
async function withContext<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}
