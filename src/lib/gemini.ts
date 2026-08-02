import { getSetting } from "./db";
import { markdownToHtml } from "./markdown";
import type { GeneratedDraft } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export function geminiKey(): string | null {
  return getSetting("gemini_api_key") || process.env.GEMINI_API_KEY || null;
}

export function geminiModel(): string {
  return getSetting("gemini_model") || process.env.GEMINI_MODEL || "gemini-2.5-pro";
}

export type GenerateOptions = {
  mainKeyword: string;
  subKeyword: string;
  tone?: string;
  targetChars?: number;
  outline?: string;
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    metaDescription: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    bodyMarkdown: { type: "string" },
  },
  required: ["title", "metaDescription", "tags", "bodyMarkdown"],
} as const;

function buildPrompt(o: GenerateOptions): string {
  const tone = o.tone?.trim() || "친근하지만 정보 밀도가 높은 정보성 블로그 문체";
  const target = o.targetChars ?? 2000;
  const outline = o.outline?.trim();

  return [
    "당신은 네이버 블로그 상위노출 경험이 많은 한국어 콘텐츠 작가입니다.",
    "아래 조건으로 네이버 블로그와 티스토리에 동시 발행할 글을 작성하세요.",
    "",
    `## 메인 키워드\n${o.mainKeyword}`,
    `## 서브 키워드\n${o.subKeyword}`,
    outline ? `## 반드시 다룰 내용\n${outline}` : "",
    "",
    "## 제목 규칙",
    "- 제목에 메인 키워드와 서브 키워드를 **둘 다 그대로** 포함할 것 (변형·조사 삽입으로 키워드가 끊기지 않게).",
    "- 메인 키워드를 앞쪽에 배치할 것.",
    "- 공백 포함 32자 내외. 낚시성 과장 표현 금지.",
    "",
    "## 본문 규칙",
    `- 분량: 공백 제외 ${target}자 내외.`,
    `- 문체: ${tone}`,
    "- 마크다운으로 작성. 소제목은 `##`, 하위 항목은 `###` 사용.",
    "- 소제목은 4~6개. 각 소제목에 메인 또는 서브 키워드를 자연스럽게 녹일 것.",
    "- 첫 문단(도입부) 안에 메인 키워드를 1회 이상 포함.",
    "- 메인 키워드는 본문 전체에서 5~8회, 서브 키워드는 3~5회 등장시킬 것. 억지로 반복해 어색해지면 안 됨.",
    "- 표·목록을 최소 1개 이상 사용해 스캔이 쉽게 만들 것.",
    "- 마지막에 `## 마치며` 로 요약 문단을 넣을 것.",
    "- 사실이 불확실한 수치·날짜·가격은 쓰지 말 것. 필요하면 '확인이 필요하다'고 쓸 것.",
    "- 이미지, 스크립트, 외부 위젯 태그는 넣지 말 것.",
    "",
    "## 태그 규칙",
    "- 10개. 메인/서브 키워드 및 연관 검색어 위주. `#` 기호는 빼고 단어만.",
    "",
    "## 메타 설명",
    "- 공백 포함 80~120자. 메인 키워드 포함. 검색결과 요약문으로 쓸 문장.",
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
  const res = await fetch(
    `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(o) }] }],
        generationConfig: {
          temperature: 0.8,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    },
  );

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? text;
    } catch {
      /* 원문 유지 */
    }
    throw new Error(`Gemini 오류 (HTTP ${res.status}): ${detail}`);
  }

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
  return {
    title: String(draft.title ?? "").trim(),
    metaDescription: String(draft.metaDescription ?? "").trim(),
    tags: Array.isArray(draft.tags)
      ? draft.tags.map((t: unknown) => String(t).replace(/^#/, "").trim()).filter(Boolean)
      : [],
    bodyMarkdown,
    bodyHtml: markdownToHtml(bodyMarkdown),
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
  if (!res.ok) throw new Error(`Gemini 오류 (HTTP ${res.status}): ${text.slice(0, 500)}`);

  const payload = JSON.parse(text);
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const jsonText = parts.map((p: any) => p?.text ?? "").join("");
  if (!jsonText.trim()) throw new Error("Gemini 가 제안을 반환하지 않았습니다.");

  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
}
