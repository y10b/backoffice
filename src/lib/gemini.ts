import { getSetting } from "./db";
import { appendFaqHtml, buildJsonLd, markdownToHtml, normalizeFaq } from "./markdown";
import { applyVisuals, parseVisuals } from "./visuals";
import type { GeneratedDraft } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export function geminiKey(): string | null {
  return getSetting("gemini_api_key") || process.env.GEMINI_API_KEY || null;
}

/**
 * 폴백이 flash 인 이유: 무료 티어에서 gemini-2.5-pro 는 입력 토큰 쿼터에 걸려 429 로 막힌다.
 * 설정 화면이나 GEMINI_MODEL 로 pro 를 지정하면 그대로 존중한다.
 */
export function geminiModel(): string {
  return getSetting("gemini_model") || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/**
 * 1패스(사실 조사) 전용 모델. 조사는 요약 작업이라 flash 로 충분하고,
 * 2패스까지 합치면 호출이 2배라 비싼 모델로 두면 쿼터가 금방 마른다.
 */
const RESEARCH_MODEL = "gemini-2.5-flash";

export type GenerateOptions = {
  mainKeyword: string;
  subKeyword: string;
  tone?: string;
  targetChars?: number;
  outline?: string;
  /**
   * 본문 생성 전에 구글 검색 그라운딩으로 최신 사실을 먼저 조사할지.
   * 재테크·보험·정부지원금처럼 매년 수치가 바뀌는 주제가 주력이라 기본값은 켬이다.
   */
  grounded?: boolean;
};

/** 1패스(검색 그라운딩) 결과 */
export type ResearchResult = {
  /** 조사 결과 평문. 2패스 프롬프트에 그대로 주입한다 */
  text: string;
  /**
   * 참고 출처.
   * `title` 에 실제 매체명(예: mk.co.kr)이 오므로 화면 표시에는 이걸 쓴다.
   * `uri` 는 원문 주소가 아니라 vertexaisearch.cloud.google.com 리다이렉트 프록시라
   * 그대로 보여주면 전부 같은 도메인처럼 보이고, 시간이 지나면 만료될 수 있다. 링크 대상으로만 쓸 것.
   */
  sources: { title: string; uri: string }[];
  searchQueries: string[];
};

/**
 * 무료 티어 쿼터에 자주 걸리는데 HTTP 429 만 보면 원인을 알기 어렵다.
 * 사용자가 바로 알아보게 429 는 별도 문구로 감싼다.
 */
function geminiError(status: number, body: string): Error {
  let detail = body;
  try {
    detail = JSON.parse(body)?.error?.message ?? body;
  } catch {
    /* 원문 유지 */
  }
  if (status === 429) {
    return new Error(
      `Gemini 무료 티어 쿼터 초과입니다 (HTTP 429). 잠시 뒤 다시 시도하거나 결제 등급을 올리세요. 원문: ${detail}`,
    );
  }
  return new Error(`Gemini 오류 (HTTP ${status}): ${detail}`);
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    metaDescription: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    bodyMarkdown: { type: "string" },
    // 본문 마크다운과 별개로 받아야 FAQPage 구조화 데이터를 조립할 수 있다.
    faq: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
        required: ["question", "answer"],
      },
    },
    // 본문을 보조하는 시각 자료. 본문의 {{visual:N}} 자리에 끼워 넣는다.
    visuals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          html: { type: "string" },
        },
        required: ["type", "title", "html"],
      },
    },
  },
  required: ["title", "metaDescription", "tags", "bodyMarkdown", "faq", "visuals"],
} as const;

/**
 * 1패스 프롬프트. 글을 쓰지 말고 사실만 모으게 한다.
 * 그라운딩 호출은 질의당 1,300~3,000 토큰을 쓰므로 지시는 짧게 유지한다.
 */
export function buildResearchPrompt(o: GenerateOptions): string {
  const year = new Date().getFullYear();
  return [
    "아래 주제로 한국어 블로그 글을 쓰려 합니다. 구글 검색으로 최신 사실만 조사하세요. 글은 쓰지 마세요.",
    `주제: ${o.mainKeyword} / ${o.subKeyword}`,
    o.outline?.trim() ? `다룰 내용: ${o.outline.trim()}` : "",
    "",
    `- ${year}년 기준으로 바뀐 수치·요건·날짜·금액(한도, 요율, 신청 기간, 지원 대상, 가격)을 우선 확인할 것.`,
    "- 항목마다 '몇 년 기준'인지 함께 적을 것.",
    "- 검색으로 확인되지 않은 항목은 '확인되지 않음'이라고 명시할 것. 추정치로 채우지 말 것.",
    "- 독자가 실제로 검색할 질문 4~5개도 뽑을 것.",
    "- 출력은 마크다운 불릿만. 서론·결론 없이 한 줄씩.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 표시용 폴백. 주소가 이상해도 던지지 않는다 */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/**
 * 그라운딩 응답에서 조사 텍스트와 출처를 뽑는다.
 * 1패스는 실패해도 글은 나와야 하므로, 응답 모양이 달라지거나 필드가 비어도 던지지 않고 빈 값을 돌려준다.
 */
export function parseGrounding(payload: unknown): ResearchResult {
  const candidate = (payload as any)?.candidates?.[0];
  const parts = candidate?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: any) => p?.text ?? "").join("")
    : "";

  const meta = candidate?.groundingMetadata;
  const chunks = Array.isArray(meta?.groundingChunks) ? meta.groundingChunks : [];
  // 같은 문서가 여러 청크로 쪼개져 오므로 URI 기준으로 중복을 접는다.
  const seen = new Set<string>();
  const sources: { title: string; uri: string }[] = [];
  for (const chunk of chunks) {
    const uri = String(chunk?.web?.uri ?? "").trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    // title 이 비면 프록시 host 라도 보여준다. 최소한 링크가 살아 있다는 건 알 수 있다.
    sources.push({ title: String(chunk?.web?.title ?? "").trim() || hostOf(uri), uri });
  }

  const searchQueries = Array.isArray(meta?.webSearchQueries)
    ? meta.webSearchQueries.map((q: unknown) => String(q).trim()).filter(Boolean)
    : [];

  return { text: text.trim(), sources, searchQueries };
}

/**
 * 1패스: 검색 그라운딩으로 최신 사실을 수집한다.
 * 그라운딩과 responseSchema 는 동시에 못 쓴다(HTTP 400 "Tool use with a response mime type ... is unsupported").
 * 그래서 여기서는 responseMimeType/responseSchema 를 넣지 않고 평문으로 받는다.
 * 실패는 전부 삼킨다 — 최신 정보가 없더라도 글 자체는 나오는 편이 낫다.
 */
async function researchLatest(
  o: GenerateOptions,
  key: string,
): Promise<ResearchResult | null> {
  try {
    const res = await fetch(
      `${API_BASE}/models/${encodeURIComponent(RESEARCH_MODEL)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildResearchPrompt(o) }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2 },
        }),
      },
    );
    if (!res.ok) return null;

    const research = parseGrounding(JSON.parse(await res.text()));
    // 텍스트가 비면 주입할 게 없으니 조사 자체를 없던 일로 취급한다.
    return research.text ? research : null;
  } catch {
    return null;
  }
}

/** 2패스 프롬프트. 1패스 결과가 있으면 학습 지식보다 우선하도록 주입한다 */
export function buildPrompt(o: GenerateOptions, research?: ResearchResult | null): string {
  const tone = o.tone?.trim() || "친근하지만 정보 밀도가 높은 정보성 블로그 문체";
  const target = o.targetChars ?? 2000;
  const outline = o.outline?.trim();

  return [
    "당신은 구글 검색 SEO 에 밝은 한국어 콘텐츠 작가입니다.",
    "아래 조건으로 티스토리(주력)와 네이버 블로그에 함께 발행할 글을 작성하세요.",
    "구글은 키워드 밀도보다 '검색 의도를 얼마나 빨리, 정확히 충족하는가'를 봅니다. 그 기준으로 쓰세요.",
    "",
    `## 메인 키워드\n${o.mainKeyword}`,
    `## 서브 키워드\n${o.subKeyword}`,
    outline ? `## 반드시 다룰 내용\n${outline}` : "",
    // 모델의 학습 시점 지식보다 방금 검색한 사실이 항상 최신이므로 우선순위를 명시한다.
    research?.text
      ? `## 조사된 최신 정보 (이 내용을 우선하라)\n${research.text}\n\n- 위 조사 결과가 당신의 기억과 다르면 **조사 결과를 따를 것**.\n- 위 조사 결과에 **없는** 수치·날짜·금액·요건은 지어내지 말 것. 필요하면 '확인이 필요하다'로 쓸 것.\n- '확인되지 않음'으로 표시된 항목은 확정된 것처럼 쓰지 말 것.`
      : "",
    "",
    "## 제목 규칙",
    "- 제목에 메인 키워드와 서브 키워드를 **둘 다 원형 그대로** 포함할 것 (변형·조사 삽입으로 키워드가 끊기지 않게).",
    "- 메인 키워드를 앞쪽에 배치할 것.",
    "- 공백 포함 32자 내외. 낚시성 과장 표현 금지.",
    "",
    "## 검색 의도 충족 (가장 중요)",
    "- 도입부 첫 2~3문장 안에 독자가 검색한 질문에 대한 **직접적인 답**을 먼저 제시할 것. 배경 설명·인사말로 시작하지 말 것.",
    "- 이 도입부는 구글 피처드 스니펫에 그대로 인용될 수 있게, 그 부분만 읽어도 말이 되는 완결된 문장으로 쓸 것.",
    "- 상세한 근거·조건·예외는 그 뒤에 이어서 설명할 것.",
    "",
    "## 헤딩 계층",
    "- 마크다운으로 작성. 글 제목이 h1 이므로 본문 소제목은 `##`(h2) 로 시작할 것. `#` 는 쓰지 말 것.",
    "- h2 는 4~6개. h2 아래 세부 항목은 `###`(h3). 단계를 건너뛰지 말 것(h2 다음에 바로 h4 금지).",
    "- 각 소제목은 그 자체로 하나의 질문·주제에 답하게 쓰고, 메인 또는 서브 키워드를 자연스럽게 녹일 것.",
    "",
    "## 본문 규칙",
    `- 분량: 공백 제외 ${target}자 내외.`,
    `- 문체: ${tone}`,
    "- 첫 문단(도입부) 안에 메인 키워드를 1회 이상 포함.",
    "- 메인 키워드는 본문 전체에서 5~8회, 서브 키워드는 3~5회 등장시킬 것.",
    "- 다만 **억지 반복은 절대 금지**. 문장이 어색해지느니 횟수를 못 채우는 편이 낫다. 지시대명사·동의어로 자연스럽게 받을 것.",
    "- 표(마크다운 표)와 목록을 **각각 최소 1개씩** 사용해 훑어보기 쉽게 만들 것. 표는 비교·요약에 쓸 것.",
    "- 마지막 요약 문단은 `## 마치며` 로 넣을 것.",
    "- 이미지, 스크립트, 외부 위젯 태그는 넣지 말 것.",
    "",
    "## 신뢰성 (E-E-A-T)",
    "- 사실이 불확실한 수치·날짜·가격은 쓰지 말 것. 필요하면 '확인이 필요하다'고 쓸 것.",
    "- 출처가 있어야 성립하는 통계·순위·법령 조항은 단정하지 말고 '공식 자료 확인이 필요하다'는 식으로 처리할 것.",
    "- 의료·법률·금융 주제는 단정적 조언·처방·투자 권유를 하지 말 것. 일반적인 정보 정리에 그치고, 판단은 전문가 상담이 필요하다고 안내할 것.",
    "- 효과·수익·결과를 보장하는 표현(반드시, 100%, 무조건)은 쓰지 말 것.",
    "",
    "## FAQ",
    "- 본문 맨 끝(`## 마치며` 뒤)에 `## 자주 묻는 질문` 섹션을 넣을 것.",
    "- 실제로 검색될 법한 질문 4~5개. 각 질문은 `###` 로, 답변은 2~4문장.",
    "- 답변은 질문에 바로 답하는 문장으로 시작할 것. 본문에서 이미 한 말을 그대로 복사하지 말 것.",
    "- 같은 내용을 `faq` 필드에도 질문/답변 쌍으로 넣을 것(구조화 데이터용). 답변은 마크다운 없이 평문으로.",
    "",
    "## 시각 자료 규칙 (`visuals`)",
    "- 글을 **보조해서 설명하는** 시각 자료를 2~3개 만들 것. 장식이 아니라 글로 길게 풀면 지루한 것을 한눈에 보여주는 용도.",
    "- 유형 예시: 조건별 비교표, 단계별 절차 흐름, 체크리스트, 핵심 수치 요약 카드, 해당/비해당 판단 기준표.",
    "- **인라인 style 속성만** 쓸 것. `<style>` 태그, `<script>`, 외부 이미지, 링크는 절대 금지.",
    "- 쓸 수 있는 태그: div, p, span, table, thead, tbody, tr, th, td, ul, ol, li, strong, em, h3, h4, br.",
    "- 배경색·테두리·여백으로 구분되게 하되, 색은 밝은 배경에 어두운 글자로(블로그 본문은 흰 배경).",
    "- 글자 크기는 px 로 지정하고 14px 이상. 표는 `border-collapse:collapse` 와 셀 padding 을 줄 것.",
    "- 각 자료의 `title` 은 자료 위에 캡션으로 쓸 짧은 제목. `type` 은 `비교표`/`절차`/`체크리스트`/`요약` 중 하나.",
    "- **본문 마크다운에는 자료가 들어갈 자리마다 `{{visual:1}}`, `{{visual:2}}` 를 빈 줄로 분리해 넣을 것.** 번호는 visuals 배열 순서와 맞출 것.",
    "- 자료 안의 수치도 조사된 정보에 없으면 지어내지 말 것.",
    "",
    "## 태그 규칙",
    "- 10개. 메인/서브 키워드 및 연관 검색어 위주. `#` 기호는 빼고 단어만.",
    "",
    "## 메타 설명",
    "- 공백 포함 80~120자. 메인 키워드 포함. 검색결과 요약문으로 쓸 문장.",
    "- 글을 읽으면 무엇을 알게 되는지 구체적으로 쓸 것. '알아보자' 같은 빈 문장 금지.",
    "",
    "JSON 으로만 응답하세요.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateDraft(o: GenerateOptions): Promise<GeneratedDraft> {
  const key = geminiKey();
  if (!key) {
    throw new Error("Gemini API 키가 없습니다. 설정 화면에서 등록하세요.");
  }
  if (!o.mainKeyword.trim()) throw new Error("메인 키워드가 비어 있습니다.");

  const model = geminiModel();

  // 1패스: 검색 그라운딩으로 최신 사실 수집. 실패하면 null 이 와서 조용히 2패스만 돈다.
  const research = o.grounded === false ? null : await researchLatest(o, key);

  // 2패스: 구조화 출력으로 본문 생성. 그라운딩과 responseSchema 는 같이 못 쓰므로 호출을 나눈다.
  const res = await fetch(
    `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(o, research) }] }],
        generationConfig: {
          temperature: 0.8,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    },
  );

  const text = await res.text();
  if (!res.ok) throw geminiError(res.status, text);

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Gemini 응답을 JSON 으로 해석하지 못했습니다.");
  }

  const parts = payload?.candidates?.[0]?.content?.parts;
  const jsonText = Array.isArray(parts)
    ? parts.map((p: any) => p?.text ?? "").join("")
    : "";
  if (!jsonText.trim()) {
    const reason = payload?.candidates?.[0]?.finishReason ?? "알 수 없음";
    throw new Error(`Gemini 가 본문을 반환하지 않았습니다 (finishReason: ${reason}).`);
  }

  let draft: any;
  try {
    draft = JSON.parse(jsonText);
  } catch {
    throw new Error("Gemini 가 반환한 초안 JSON 을 파싱하지 못했습니다.");
  }

  const bodyMarkdown = String(draft.bodyMarkdown ?? "");
  const title = String(draft.title ?? "").trim();
  const metaDescription = String(draft.metaDescription ?? "").trim();
  const tags = Array.isArray(draft.tags)
    ? draft.tags.map((t: unknown) => String(t).replace(/^#/, "").trim()).filter(Boolean)
    : [];
  // 스키마로 강제해도 모델이 faq 를 빼거나 빈 객체를 넣는 경우가 있어 정규화로 흡수한다.
  const faq = normalizeFaq(draft.faq);
  // 모델이 만든 HTML 이라 화이트리스트로 걸러야 미리보기에서 스크립트가 돌지 않는다.
  const visuals = parseVisuals(draft.visuals);

  return {
    title,
    metaDescription,
    tags,
    bodyMarkdown,
    // 모델이 본문에 FAQ 를 이미 넣었으면 그대로 두고, 빠졌을 때만 faq 배열로 채워 넣는다.
    // 시각 자료는 {{visual:N}} 자리에 끼워 넣는다. 자리 표시가 없으면 본문 끝에 붙는다.
    bodyHtml: applyVisuals(appendFaqHtml(markdownToHtml(bodyMarkdown), faq), visuals),
    faq,
    visuals,
    jsonLd: buildJsonLd({ title, metaDescription, faq, tags }),
    // 그라운딩을 껐거나 1패스가 실패하면 빈 배열이 되고, UI 는 이것으로 '출처 없음'을 판단한다.
    sources: research?.sources ?? [],
    searchQueries: research?.searchQueries ?? [],
  };
}

/** 메인/서브 키워드 조합 후보를 뽑는다 */
export async function suggestSubKeywords(
  mainKeyword: string,
  context: string[],
): Promise<{ subKeyword: string; title: string; reason: string }[]> {
  const key = geminiKey();
  if (!key) throw new Error("Gemini API 키가 없습니다. 설정 화면에서 등록하세요.");

  const prompt = [
    "당신은 네이버 블로그 키워드 전략가입니다.",
    `메인 키워드: ${mainKeyword}`,
    context.length
      ? `같은 시점 인기 키워드 목록(참고): ${context.slice(0, 40).join(", ")}`
      : "",
    "",
    "이 메인 키워드와 조합했을 때 검색 의도가 뚜렷하고 경쟁이 덜한 서브 키워드 5개를 제안하세요.",
    "각 항목마다 '메인 키워드 + 서브 키워드' 형태의 제목안과 추천 이유(한 문장)를 함께 주세요.",
    "제목에는 메인 키워드와 서브 키워드가 원형 그대로 들어가야 합니다.",
    "JSON 으로만 응답하세요.",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(
    `${API_BASE}/models/${encodeURIComponent(geminiModel())}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              suggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    subKeyword: { type: "string" },
                    title: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["subKeyword", "title", "reason"],
                },
              },
            },
            required: ["suggestions"],
          },
        },
      }),
    },
  );

  const text = await res.text();
  if (!res.ok) throw geminiError(res.status, text.slice(0, 500));

  const payload = JSON.parse(text);
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const jsonText = parts.map((p: any) => p?.text ?? "").join("");
  if (!jsonText.trim()) throw new Error("Gemini 가 제안을 반환하지 않았습니다.");

  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
}
