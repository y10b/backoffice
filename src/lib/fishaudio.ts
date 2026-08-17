import { getSettings } from "./db";

/**
 * Fish Audio TTS — 유아 채널 내레이션·가사 음성.
 *
 * 확인해 본 셋 중 **유일하게 실제로 무료 API 가 있는 곳**이다.
 * `s2.1-pro-free` 는 유료와 같은 모델이고 하드 캡이 없다(대신 Fair Use 정책 적용).
 *
 * 다만 무료 등급은 "일부 상용 시나리오에 제약이 있을 수 있다"고 공지돼 있다.
 * 수익화 채널에 쓸 거라면 유료 등급으로 올리는 게 안전하다. 그래서 모델을 고정하지 않고
 * 설정에서 바꿀 수 있게 둔다.
 */

const API_BASE = "https://api.fish.audio";

/** 무료 등급 모델. 유료로 올리려면 설정에서 s2.1-pro 등으로 바꾼다 */
export const FREE_MODEL = "s2.1-pro-free";

export async function fishConfig(): Promise<{ apiKey: string; model: string }> {
  const s = await getSettings(["fish_api_key", "fish_model"]);
  const apiKey = s.fish_api_key || process.env.FISH_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "Fish Audio API 키가 없습니다. fish.audio 에서 발급받아 설정 화면에 등록하세요 (무료 등급 가능).",
    );
  }
  return { apiKey, model: s.fish_model || process.env.FISH_MODEL || FREE_MODEL };
}

export type TtsOptions = {
  text: string;
  /**
   * 목소리 ID. fish.audio 의 공개 보이스 라이브러리에서 고른 모델 ID.
   * 비우면 기본 목소리로 나온다.
   */
  referenceId?: string;
  format?: "mp3" | "wav" | "opus";
};

export type TtsResult = {
  /** 오디오 바이트 */
  audio: ArrayBuffer;
  contentType: string;
  format: string;
};

export async function synthesize(o: TtsOptions): Promise<TtsResult> {
  if (!o.text?.trim()) throw new Error("읽을 텍스트가 비어 있습니다.");
  const { apiKey, model } = await fishConfig();
  const format = o.format ?? "mp3";

  const res = await fetch(`${API_BASE}/v1/tts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      // 모델 선택은 바디가 아니라 헤더로 간다
      model,
    },
    body: JSON.stringify({
      text: o.text,
      format,
      ...(o.referenceId ? { reference_id: o.referenceId } : {}),
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text)?.message ?? JSON.parse(text)?.detail ?? detail;
    } catch {
      /* 원문 유지 */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Fish Audio 인증 실패 (HTTP ${res.status}). API 키를 확인하세요. ${detail}`);
    }
    if (res.status === 429) {
      throw new Error(
        `Fish Audio 요청이 제한됐습니다 (HTTP 429). 무료 등급은 Fair Use 정책이 적용됩니다. ${detail}`,
      );
    }
    throw new Error(`Fish Audio 오류 (HTTP ${res.status}): ${detail}`);
  }

  const audio = await res.arrayBuffer();
  if (!audio.byteLength) throw new Error("Fish Audio 가 빈 응답을 반환했습니다.");

  return {
    audio,
    contentType: res.headers.get("content-type") ?? `audio/${format}`,
    format,
  };
}

/** 공개 보이스 라이브러리 검색. 한국어 목소리를 골라 referenceId 로 쓴다 */
export async function searchVoices(
  query: string,
  language = "ko",
): Promise<{ id: string; title: string; languages: string[]; likes: number }[]> {
  const { apiKey } = await fishConfig();
  const url = new URL(`${API_BASE}/model`);
  if (query.trim()) url.searchParams.set("title", query.trim());
  url.searchParams.set("language", language);
  url.searchParams.set("page_size", "20");
  url.searchParams.set("sort_by", "score");

  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`목소리 목록을 받지 못했습니다 (HTTP ${res.status}).`);
  }
  const data: any = await res.json();
  return (data?.items ?? []).map((m: any) => ({
    id: String(m?._id ?? m?.id ?? ""),
    title: String(m?.title ?? ""),
    languages: Array.isArray(m?.languages) ? m.languages.map(String) : [],
    likes: Number(m?.like_count ?? 0) || 0,
  }));
}
