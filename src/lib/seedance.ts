import { getSettings } from "./db";

/**
 * Seedance (ByteDance) 영상 생성.
 *
 * 제출 → 폴링 → 다운로드의 비동기 작업 방식이다. 한 번의 호출로 영상이 나오지 않는다.
 *
 * 엔드포인트는 제공자마다 다르다 (Volcengine 국내, BytePlus 국제, 서드파티 게이트웨이).
 * 크리에이터 어드바이저 때와 같은 이유로 base URL 과 모델 ID 를 코드에 박지 않고
 * 설정에서 바꿀 수 있게 둔다.
 */

/** Volcengine Ark (중국). BytePlus 국제는 https://ark.ap-southeast.bytepluses.com/api/v3 */
export const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_MODEL = "doubao-seedance-2-0-260128";

export type SeedanceConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export async function seedanceConfig(): Promise<SeedanceConfig> {
  const s = await getSettings(["seedance_api_key", "seedance_base_url", "seedance_model"]);
  const apiKey = s.seedance_api_key || process.env.SEEDANCE_API_KEY || "";
  if (!apiKey) {
    throw new Error("Seedance API 키가 없습니다. 설정 화면에서 등록하세요.");
  }
  return {
    apiKey,
    baseUrl: (s.seedance_base_url || process.env.SEEDANCE_BASE_URL || DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    model: s.seedance_model || process.env.SEEDANCE_MODEL || DEFAULT_MODEL,
  };
}

export type SeedanceOptions = {
  prompt: string;
  /** 이미지→영상. 첫 프레임을 고정해 캐릭터 일관성을 크게 올린다 */
  imageUrl?: string;
  /** 4~15초 */
  duration?: number;
  resolution?: "480p" | "720p" | "1080p" | "2K";
  /** 쇼츠는 9:16 */
  ratio?: "16:9" | "9:16" | "4:3" | "3:4" | "21:9" | "1:1" | "adaptive";
  watermark?: boolean;
};

export type SeedanceTask = {
  id: string;
  /** 응답 원문 — 제공자마다 필드가 달라서 화면 디버그에 그대로 노출한다 */
  raw: unknown;
};

export type SeedanceStatus = {
  status: "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled" | "unknown";
  videoUrl: string | null;
  error?: string;
  raw: unknown;
};

async function call(
  cfg: SeedanceConfig,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* JSON 이 아니면 원문 유지 — 게이트웨이 오류 페이지인 경우가 있다 */
  }
  return { ok: res.ok, status: res.status, body, text };
}

function errorMessage(status: number, body: unknown, text: string): string {
  const detail =
    (body as any)?.error?.message ??
    (body as any)?.message ??
    (typeof body === "string" ? body.slice(0, 300) : text.slice(0, 300));
  if (status === 401 || status === 403) {
    return `Seedance 인증 실패 (HTTP ${status}). API 키를 확인하세요. ${detail}`;
  }
  if (status === 404) {
    return `엔드포인트를 찾지 못했습니다 (HTTP 404). 설정에서 base URL 을 제공자에 맞게 바꾸세요 (Volcengine / BytePlus / 서드파티). ${detail}`;
  }
  if (status === 429) {
    return `Seedance 요청이 제한됐습니다 (HTTP 429). 잠시 뒤 다시 시도하세요. ${detail}`;
  }
  return `Seedance 오류 (HTTP ${status}): ${detail}`;
}

/** 영상 생성 작업 제출. 즉시 완성되지 않으므로 task id 만 돌아온다. */
export async function submitVideo(o: SeedanceOptions): Promise<SeedanceTask> {
  if (!o.prompt?.trim()) throw new Error("프롬프트가 비어 있습니다.");
  const cfg = await seedanceConfig();

  const content: unknown[] = [{ type: "text", text: o.prompt }];
  if (o.imageUrl) {
    content.push({ type: "image_url", image_url: { url: o.imageUrl } });
  }

  const { ok, status, body, text } = await call(cfg, "/contents/generations/tasks", {
    method: "POST",
    body: JSON.stringify({
      model: cfg.model,
      content,
      // 4~15초 밖의 값은 제공자가 거부한다. 여기서 먼저 잘라 400 을 줄인다
      duration: Math.min(Math.max(o.duration ?? 5, 4), 15),
      resolution: o.resolution ?? "720p",
      ratio: o.ratio ?? "9:16",
      watermark: o.watermark ?? false,
    }),
  });

  if (!ok) throw new Error(errorMessage(status, body, text));

  const id = (body as any)?.id ?? (body as any)?.task_id ?? (body as any)?.data?.id;
  if (!id) {
    throw new Error(
      `작업 ID 를 찾지 못했습니다. 응답 형식이 다를 수 있습니다: ${text.slice(0, 300)}`,
    );
  }
  return { id: String(id), raw: body };
}

const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled"]);

/** 작업 상태 조회. 완료되면 videoUrl 이 채워진다. */
export async function pollVideo(taskId: string): Promise<SeedanceStatus> {
  const cfg = await seedanceConfig();
  const { ok, status, body, text } = await call(
    cfg,
    `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
  );

  if (!ok) throw new Error(errorMessage(status, body, text));

  const b = body as any;
  const raw = String(b?.status ?? b?.data?.status ?? "").toLowerCase();
  const normalized = (
    TERMINAL.has(raw) || raw === "queued" || raw === "running" ? raw : "unknown"
  ) as SeedanceStatus["status"];

  return {
    status: normalized,
    videoUrl:
      b?.content?.video_url ?? b?.data?.content?.video_url ?? b?.video_url ?? null,
    error: b?.error?.message ?? b?.failure_reason ?? undefined,
    raw: body,
  };
}

export function isTerminal(status: SeedanceStatus["status"]): boolean {
  return TERMINAL.has(status);
}
