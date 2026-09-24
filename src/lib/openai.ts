/**
 * OpenAI (GPT) 호출 — 방문 후기 레인 전용.
 *
 * 채널별로 모델을 나눴다. 네이버 방문 후기(사진 분석·본문)는 GPT, 티스토리 본문은
 * 그대로 Gemini(gemini.ts)다. 그래서 여기는 방문 후기가 쓰는 "JSON 한 덩이 받기" 하나만 둔다.
 *
 * Chat Completions + Structured Outputs(json_schema, strict) 를 쓴다. strict 스키마는
 * - 모든 객체에 additionalProperties: false
 * - properties 의 키가 전부 required 에 있어야 하고
 * - 없어도 되는 값은 type: ["integer", "null"] 처럼 null 을 허용해 표현한다.
 * 규칙을 어기면 400 이 나므로 스키마를 넘기는 쪽(visit.ts)이 지킨다.
 */
import { getSettings } from "./db";

const API_BASE = "https://api.openai.com/v1";

export const DEFAULT_MODEL = "gpt-5.5";

/** 설정 화면에서 고르는 목록. 이 키로 전부 호출되는 것을 확인했다 */
export const MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-4.1"];

export async function openaiKey(): Promise<string | null> {
  const s = await getSettings(["openai_api_key"]);
  return s.openai_api_key?.trim() || process.env.OPENAI_API_KEY?.trim() || null;
}

export async function openaiModel(): Promise<string> {
  const s = await getSettings(["openai_model"]);
  return s.openai_model?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 기다리면 풀릴 수 있는 오류. 잘못된 키(401)·스키마 오류(400)는 다시 걸어도 같다 */
function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

/** 상태코드 + 본문 앞 300자. 키는 요청 헤더에만 있고 응답에는 실리지 않지만, 혹시 몰라 가린다 */
function openaiError(status: number, body: string, key: string): Error {
  const safe = body.split(key).join("••••").slice(0, 300);
  return new Error(`OpenAI ${status}: ${safe}`);
}

export type OpenaiJsonOptions = {
  system?: string;
  user: string;
  /**
   * base64 (data: 접두사 없이). label 을 주면 그 이미지 바로 앞에 텍스트로 붙인다 —
   * 사진 번호를 모델 출력(index)과 이어 붙이려면 이미지마다 이름표가 필요하다.
   */
  images?: { mimeType: string; data: string; label?: string }[];
  /** strict 규칙을 지킨 JSON 스키마 */
  schema: object;
  schemaName: string;
  maxTokens?: number;
  /** 429·5xx 에서 몇 번 더 기다려 볼지 (4·8·16초). 기본 2 */
  retries?: number;
};

export async function openaiJson<T>(o: OpenaiJsonOptions): Promise<T> {
  const key = await openaiKey();
  if (!key) throw new Error("OpenAI API 키가 없습니다. 설정 화면에서 등록하세요.");
  const model = await openaiModel();
  const maxRetries = o.retries ?? 2;

  const userContent: unknown[] = [
    { type: "text", text: o.user },
    ...(o.images ?? []).flatMap((img) => [
      ...(img.label ? [{ type: "text", text: img.label }] : []),
      {
        type: "image_url",
        // 메뉴판·영수증의 작은 글씨를 읽어야 해서 high 다. low 면 512px 로 줄여 가격을 못 읽는다
        image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: "high" },
      },
    ]),
  ];

  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(o.system ? [{ role: "system", content: o.system }] : []),
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: o.schemaName, strict: true, schema: o.schema },
    },
  };
  // gpt-5 계열은 temperature 를 받지 않는다(400). 토큰 상한도 max_completion_tokens 로만 받는다
  if (o.maxTokens) body.max_completion_tokens = o.maxTokens;
  const payload = JSON.stringify(body);

  let attempt = 0;
  for (;;) {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: payload,
    });
    const text = await res.text();

    if (!res.ok) {
      if (shouldRetry(res.status) && attempt < maxRetries) {
        attempt += 1;
        await sleep(4000 * 2 ** (attempt - 1));
        continue;
      }
      throw openaiError(res.status, text, key);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("OpenAI 응답을 JSON 으로 해석하지 못했습니다.");
    }
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (msg?.refusal) throw new Error(`OpenAI 가 응답을 거절했습니다: ${String(msg.refusal).slice(0, 300)}`);
    const content = typeof msg?.content === "string" ? msg.content : "";
    if (!content.trim()) {
      throw new Error(`OpenAI 가 빈 응답을 반환했습니다 (finish_reason: ${choice?.finish_reason ?? "알 수 없음"}).`);
    }
    try {
      return JSON.parse(content) as T;
    } catch {
      // length 로 끊기면 JSON 이 반쯤 온다. 이유를 같이 알려야 토큰 상한을 의심할 수 있다
      throw new Error(
        `OpenAI 가 반환한 JSON 을 파싱하지 못했습니다 (finish_reason: ${choice?.finish_reason ?? "알 수 없음"}).`,
      );
    }
  }
}

/** 키·모델 확인. 모델 id 를 돌려준다. 설정 화면의 "테스트" 버튼용 */
export async function openaiPing(): Promise<string> {
  const key = await openaiKey();
  if (!key) throw new Error("OpenAI API 키가 등록되지 않았습니다.");
  const model = await openaiModel();
  const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  if (!res.ok) throw openaiError(res.status, text, key);
  try {
    return String(JSON.parse(text)?.id ?? model);
  } catch {
    return model;
  }
}
