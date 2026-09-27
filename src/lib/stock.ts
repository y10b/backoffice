import { geminiCall, geminiModel } from "./gemini";
import { foodTrends } from "./foodTrend";
import { CUTOUT_SUFFIX, STOCK_STYLES, type StockStyle } from "./stockPrompt";

export { CUTOUT_SUFFIX, STOCK_STYLES, type StockStyle };

/**
 * AI 스톡 이미지 — 무엇을 만들지 고르고, ChatGPT 에 줄 프롬프트와 판매용 메타데이터를 만든다.
 *
 * 이미지 생성과 업로드는 사람이 한다. 이 모듈은 그 앞뒤를 맡는다.
 *
 *   시즌 주제 고르기  →  프롬프트 (여기)  →  ChatGPT 로 생성 (사람)
 *   →  누끼·정리·메타데이터 (브라우저, cutout.ts)  →  플랫폼 업로드 (사람)
 *
 * 업로드를 자동화하지 않는 이유: 스톡 플랫폼은 대량 자동 업로드를 스팸으로 제재하고,
 * AI 이미지는 사람이 결함을 걸러야 승인률이 나온다.
 *
 * 판매처 조건(2026-09 조사): 미리캔버스는 AI 체크 필수 + 사진 카테고리 불가라 배경 없는
 * 요소(PNG)로, Adobe Stock 은 AI 체크 필수 + 4MP 이상으로 낸다. 두 곳 모두 실존 인물·
 * 브랜드·캐릭터가 들어가면 반려되거나 계약이 해지된다.
 */

/* ------------------------------------------------------------------ *
 * 시즌 캘린더
 * ------------------------------------------------------------------ */

export type StockEvent = {
  name: string;
  /** 수요가 몰리는 달(1~12). 스톡은 이보다 1~2달 먼저 올라가 있어야 팔린다 */
  months: number[];
  /** 데이터랩에서 추세를 볼 검색어 */
  query: string;
  /** 프롬프트를 만들 때 줄 소재 힌트 */
  hints: string;
};

/**
 * 한국 시즌 이벤트. 디자인 템플릿 수요(학교·관공서·소상공인 홍보물)가 큰 것 위주다.
 * 설날·추석은 음력이라 해마다 달이 흔들려 두 달을 걸어 둔다.
 */
export const STOCK_EVENTS: StockEvent[] = [
  { name: "새해", months: [1], query: "새해", hints: "해돋이, 복주머니, 띠 동물, 새해 인사" },
  { name: "설날", months: [1, 2], query: "설날", hints: "떡국, 세뱃돈 봉투, 한복 입은 뒷모습, 윷놀이, 복조리" },
  { name: "졸업", months: [2], query: "졸업식", hints: "학사모, 꽃다발, 졸업장" },
  { name: "발렌타인데이", months: [2], query: "발렌타인데이", hints: "하트, 초콜릿 상자, 리본" },
  { name: "입학·새학기", months: [3], query: "입학식", hints: "책가방, 연필, 칠판, 새 교과서" },
  { name: "봄·벚꽃", months: [3, 4], query: "벚꽃", hints: "벚꽃 가지, 꽃잎, 봄 소풍 도시락" },
  { name: "어린이날", months: [5], query: "어린이날", hints: "풍선, 바람개비, 선물 상자, 장난감" },
  { name: "어버이날·스승의날", months: [5], query: "어버이날", hints: "카네이션, 감사 카드, 꽃바구니" },
  { name: "장마", months: [6, 7], query: "장마", hints: "우산, 장화, 빗방울, 개구리" },
  { name: "여름휴가", months: [7, 8], query: "여름휴가", hints: "튜브, 수박, 파라솔, 선글라스, 조개" },
  { name: "복날", months: [7, 8], query: "초복", hints: "삼계탕, 부채, 수박" },
  { name: "광복절", months: [8], query: "광복절", hints: "무궁화, 비둘기 (국기·태극 문양은 넣지 않는다)" },
  { name: "추석", months: [9, 10], query: "추석", hints: "송편, 보름달, 선물세트 보자기, 감, 밤" },
  { name: "운동회", months: [9, 10], query: "운동회", hints: "박 터뜨리기, 청백 줄다리기, 계주 바통, 만국기, 메달" },
  { name: "가을 소풍·단풍", months: [10], query: "단풍", hints: "단풍잎, 도토리, 은행잎, 도시락" },
  { name: "할로윈", months: [10], query: "할로윈", hints: "호박 등, 유령, 사탕 바구니, 박쥐" },
  { name: "한글날", months: [10], query: "한글날", hints: "붓, 먹, 한지 질감 (글자는 넣지 않는다)" },
  { name: "수능", months: [11], query: "수능", hints: "합격 엿, 찹쌀떡, 응원 부적 모양, 시계" },
  { name: "빼빼로데이", months: [11], query: "빼빼로데이", hints: "막대 과자, 하트 상자 (상표 없이)" },
  { name: "김장", months: [11], query: "김장", hints: "배추, 고무장갑, 김치통, 고춧가루" },
  { name: "크리스마스", months: [12], query: "크리스마스", hints: "트리, 선물 상자, 양말, 눈사람, 리스" },
  { name: "연말·송년회", months: [12], query: "송년회", hints: "샴페인 잔, 폭죽, 달력" },
  { name: "겨울", months: [12, 1], query: "첫눈", hints: "눈송이, 벙어리장갑, 붕어빵, 군고구마" },
];

export type StockTopic = StockEvent & {
  /** 수요가 몰리기까지 남은 달. 0 이면 이번 달이 한창이다 */
  monthsAhead: number;
  /** 최근 석 달 검색 추세(%). 데이터랩이 없으면 null */
  delta: number | null;
  searches: number | null;
};

/** 지금 달 기준으로 수요 달까지 몇 달 남았는지. 가장 가까운 달로 */
function monthsUntil(now: number, months: number[]): number {
  return Math.min(...months.map((m) => (m - now + 12) % 12));
}

/**
 * 지금 만들어 올릴 주제. 수요 달이 0~3달 안에 있는 것만 고르고, 1~2달 앞(업로드 적기)을
 * 먼저, 그다음 검색 추세가 오르는 순으로 놓는다.
 */
export async function upcomingTopics(now = new Date()): Promise<{ topics: StockTopic[]; errors: string[] }> {
  const month = now.getMonth() + 1;
  const near = STOCK_EVENTS.map((e) => ({ ...e, monthsAhead: monthsUntil(month, e.months) })).filter(
    (e) => e.monthsAhead <= 3,
  );

  const { trends, errors } = await foodTrends(near.map((e) => e.query));
  const byQuery = new Map(trends.map((t) => [t.food, t]));

  // 1~2달 앞이 가장 좋고, 이번 달은 늦었고, 3달 앞은 이르다
  const timing = (m: number) => (m === 1 || m === 2 ? 0 : m === 0 ? 1 : 2);
  const topics = near
    .map((e) => ({ ...e, delta: byQuery.get(e.query)?.delta ?? null, searches: byQuery.get(e.query)?.searches ?? null }))
    .sort((a, b) => timing(a.monthsAhead) - timing(b.monthsAhead) || (b.delta ?? -999) - (a.delta ?? -999));
  return { topics, errors };
}

/* ------------------------------------------------------------------ *
 * 프롬프트 + 메타데이터
 * ------------------------------------------------------------------ */

export type StockPrompt = {
  /** 화면에 보일 한 줄 설명 */
  subject: string;
  /** ChatGPT 에 그대로 붙여 넣을 프롬프트 */
  prompt: string;
  titleKo: string;
  titleEn: string;
  keywordsKo: string[];
  keywordsEn: string[];
  /** Adobe Stock 카테고리 번호 */
  adobeCategory: number;
};

/** Adobe Stock 카테고리. CSV 에는 번호로 넣는다 */
export const ADOBE_CATEGORIES: Record<number, string> = {
  1: "Animals", 2: "Buildings and Architecture", 3: "Business", 4: "Drinks", 5: "The Environment",
  6: "States of Mind", 7: "Food", 8: "Graphic Resources", 9: "Hobbies and Leisure", 10: "Industry",
  11: "Landscapes", 12: "Lifestyle", 13: "People", 14: "Plants and Flowers", 15: "Culture and Religion",
  16: "Science", 17: "Social Issues", 18: "Sports", 19: "Technology", 20: "Transport", 21: "Travel",
};

const PROMPT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string" },
          prompt: { type: "string" },
          titleKo: { type: "string" },
          titleEn: { type: "string" },
          keywordsKo: { type: "array", items: { type: "string" } },
          keywordsEn: { type: "array", items: { type: "string" } },
          adobeCategory: { type: "integer" },
        },
        required: ["subject", "prompt", "titleKo", "titleEn", "keywordsKo", "keywordsEn", "adobeCategory"],
      },
    },
  },
  required: ["items"],
} as const;

export function buildStockPrompt(o: { topic: string; hints?: string; style: StockStyle; count: number }): string {
  return `한국 디자인 플랫폼(미리캔버스)과 Adobe Stock 에 팔 AI 일러스트 요소 세트를 기획한다.
주제: ${o.topic}
${o.hints ? `소재 힌트: ${o.hints}` : ""}
스타일(모든 항목 공통): ${STOCK_STYLES[o.style]}

서로 **확연히 다른 소재** ${o.count}개를 뽑는다. 같은 물건의 색만 바꾼 변형은 스팸으로 반려되니 금지.
실제로 학교 가정통신문, 가게 홍보 포스터, SNS 카드뉴스를 만드는 사람이 가져다 쓸 법한 것을 고른다.

각 항목:
- subject: 한국어 한 줄 설명
- prompt: ChatGPT 이미지 생성에 붙여 넣을 **영어** 프롬프트. 소재를 구체적으로(모양·색·구도) 묘사하고
  스타일 문구를 넣는다. 끝에 다음 문장을 반드시 그대로 붙인다: "${CUTOUT_SUFFIX}"
- titleKo: 미리캔버스용 제목(한국어, 15자 이내, 검색어가 앞에)
- titleEn: Adobe Stock 제목(영어, 70자 이내, 설명형. 예: "Korean autumn sports day relay baton illustration isolated on white")
- keywordsKo: 미리캔버스 태그 10개(한국어)
- keywordsEn: Adobe 키워드 25~35개(영어, 중요한 것 앞 10개에). "AI", "generative" 같은 단어는 넣지 않는다
- adobeCategory: 다음 중 번호 하나 — ${Object.entries(ADOBE_CATEGORIES).map(([k, v]) => `${k} ${v}`).join(", ")}

금지: 실존 인물·유명인, 사람 얼굴 클로즈업(인물은 뒷모습이나 단순화한 캐릭터만), 브랜드·로고·상표
(예: 빼빼로 → "막대 과자"), 캐릭터 IP, 국기·태극기 같은 공식 상징, 작가 이름, 글자가 들어가는 소재.

JSON 으로만 낸다.`;
}

export async function generateStockPrompts(o: {
  topic: string;
  hints?: string;
  style: StockStyle;
  count: number;
}): Promise<StockPrompt[]> {
  const payload = await geminiCall(await geminiModel(), {
    contents: [{ role: "user", parts: [{ text: buildStockPrompt(o) }] }],
    generationConfig: {
      temperature: 0.9,
      responseMimeType: "application/json",
      responseSchema: PROMPT_SCHEMA,
    },
  });
  const parts = payload?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? "").join("") : "";
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini 가 프롬프트 JSON 을 돌려주지 않았습니다. 다시 시도하세요.");
  }

  const clean = (xs: unknown, max: number) =>
    (Array.isArray(xs) ? xs : [])
      .map((x) => String(x).trim())
      .filter((x, i, arr) => x && arr.indexOf(x) === i)
      .slice(0, max);

  return (parsed.items ?? []).map((it: any): StockPrompt => {
    let prompt = String(it.prompt ?? "").trim();
    // 모델이 꼬리 문장을 빼먹으면 누끼가 깨진다. 없으면 붙인다
    if (!prompt.includes("#FFFFFF")) prompt = `${prompt} ${CUTOUT_SUFFIX}`;
    const cat = Number(it.adobeCategory);
    return {
      subject: String(it.subject ?? "").trim(),
      prompt,
      titleKo: String(it.titleKo ?? "").trim(),
      titleEn: String(it.titleEn ?? "").trim().slice(0, 200),
      keywordsKo: clean(it.keywordsKo, 10),
      // Adobe 는 49개까지 받는다
      keywordsEn: clean(it.keywordsEn, 49),
      adobeCategory: ADOBE_CATEGORIES[cat] ? cat : 8,
    };
  });
}
