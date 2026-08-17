import { geminiKeys } from "./gemini";

/**
 * Veo 영상 생성 (Gemini API).
 *
 * "구글 플로우로 무료" 는 웹 UI 이야기다. Flow(flow.google)는 API 가 없어서 코드에서
 * 부를 수 없다. 같은 Veo 모델을 프로그램으로 쓰는 경로가 이 파일이고, 이쪽은 **유료**다.
 * 무료로 하려면 Flow 웹에서 만들어 내려받아 업로드하는 경로를 쓴다(쇼츠 소재 업로드).
 *
 * 키는 기존 Gemini 키를 그대로 쓴다. Veo 도 같은 `x-goog-api-key` 라 다중 키 로테이션이
 * 그대로 재활용된다.
 *
 * 제출 → 폴링 → 다운로드의 비동기 작업이다.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** 싼 순서대로. lite → fast → 표준 */
export const MODELS = [
  "veo-3.1-lite-generate-preview",
  "veo-3.1-fast-generate-preview",
  "veo-3.1-generate-preview",
] as const;

export const DEFAULT_MODEL = MODELS[0];

export type VeoOptions = {
  prompt: string;
  model?: string;
  /** Veo 3.1 은 4·6·8초를 받는다 */
  durationSeconds?: 4 | 6 | 8;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  negativePrompt?: string;
  /**
   * 첫 프레임 이미지 (base64, 데이터 URI 접두어 없이).
   * 캐릭터 일관성을 올리는 가장 확실한 수단이다.
   */
  imageBase64?: string;
  imageMimeType?: string;
};

export type VeoTask = {
  /** 롱러닝 오퍼레이션 이름. 폴링에 그대로 쓴다 */
  operation: string;
  raw: unknown;
};

export type VeoStatus = {
  done: boolean;
  /** 완료 시 영상 주소. 이 URI 는 API 키 헤더가 있어야 받아진다 */
  videoUri: string | null;
  error?: string;
  raw: unknown;
};

function errorMessage(status: number, text: string): string {
  let detail = text.slice(0, 400);
  try {
    detail = JSON.parse(text)?.error?.message ?? detail;
  } catch {
    /* 원문 유지 */
  }
  if (status === 429) {
    return `Veo 쿼터에 걸렸습니다 (HTTP 429). Veo 는 무료 티어에 포함되지 않아 결제가 설정된 키가 필요합니다. 원문: ${detail}`;
  }
  if (status === 403) {
    return `Veo 접근이 거부됐습니다 (HTTP 403). 해당 키 프로젝트에 결제가 설정돼 있는지 확인하세요. 원문: ${detail}`;
  }
  if (status === 404) {
    return `모델을 찾지 못했습니다 (HTTP 404). 프리뷰 모델은 이름이 자주 바뀝니다. 설정에서 다른 Veo 모델을 골라보세요. 원문: ${detail}`;
  }
  return `Veo 오류 (HTTP ${status}): ${detail}`;
}

/** 쿼터·권한 문제면 다음 키로 넘겨본다. 그 외에는 키를 바꿔도 같은 답이 온다 */
function shouldTryNextKey(status: number, body: string): boolean {
  if (status === 429) return true;
  return status === 403 && /quota|exhaust|rate.?limit|billing/i.test(body);
}

async function callWithKeys(
  path: string,
  init: RequestInit,
): Promise<{ body: unknown; text: string }> {
  const keys = await geminiKeys();
  if (!keys.length) {
    throw new Error("Gemini API 키가 없습니다. Veo 는 같은 키를 씁니다 — 설정 화면에서 등록하세요.");
  }

  let last: { status: number; text: string } | null = null;
  for (const key of keys) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-goog-api-key": key, ...(init.headers ?? {}) },
      cache: "no-store",
    });
    const text = await res.text();
    if (res.ok) {
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* 원문 유지 */
      }
      return { body, text };
    }
    last = { status: res.status, text };
    if (!shouldTryNextKey(res.status, text)) break;
  }
  throw new Error(errorMessage(last!.status, last!.text));
}

export async function submitVideo(o: VeoOptions): Promise<VeoTask> {
  if (!o.prompt?.trim()) throw new Error("프롬프트가 비어 있습니다.");
  const model = o.model || DEFAULT_MODEL;

  const instance: Record<string, unknown> = { prompt: o.prompt };
  if (o.imageBase64) {
    instance.image = {
      inlineData: {
        mimeType: o.imageMimeType ?? "image/png",
        data: o.imageBase64,
      },
    };
  }

  const { body, text } = await callWithKeys(
    `/models/${encodeURIComponent(model)}:predictLongRunning`,
    {
      method: "POST",
      body: JSON.stringify({
        instances: [instance],
        parameters: {
          aspectRatio: o.aspectRatio ?? "9:16",
          resolution: o.resolution ?? "720p",
          // 문서상 문자열로 받는다. 4·6·8 외의 값은 거부되므로 여기서 맞춰 보낸다
          durationSeconds: String(o.durationSeconds ?? 8),
          ...(o.negativePrompt ? { negativePrompt: o.negativePrompt } : {}),
        },
      }),
    },
  );

  const operation = (body as any)?.name;
  if (!operation) {
    throw new Error(`작업 이름을 찾지 못했습니다: ${text.slice(0, 300)}`);
  }
  return { operation: String(operation), raw: body };
}

export async function pollVideo(operation: string): Promise<VeoStatus> {
  // 오퍼레이션 이름이 이미 `models/...` 형태의 경로다
  const { body } = await callWithKeys(`/${operation.replace(/^\/+/, "")}`, { method: "GET" });
  const b = body as any;

  return {
    done: Boolean(b?.done),
    videoUri:
      b?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ??
      b?.response?.generatedSamples?.[0]?.video?.uri ??
      null,
    error: b?.error?.message,
    raw: body,
  };
}

/**
 * 결과 영상을 받아온다.
 *
 * Veo 가 주는 URI 는 API 키 헤더가 있어야 열린다. 브라우저는 헤더를 붙일 수 없으므로
 * 서버가 대신 받아 그대로 흘려보낸다.
 */
export async function fetchVideo(uri: string): Promise<Response> {
  const keys = await geminiKeys();
  if (!keys.length) throw new Error("Gemini API 키가 없습니다.");

  const res = await fetch(uri, {
    headers: { "x-goog-api-key": keys[0] },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`영상을 받지 못했습니다 (HTTP ${res.status}).`);
  }
  return res;
}
