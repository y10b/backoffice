/**
 * GA4 속성 설정을 코드로 맞춘다 (Admin API). scripts/ga4-setup.mjs 가 부른다.
 *
 * 계산기 사용(calculator_use)이 어느 글에서 나는지, 그 글을 끝까지 읽었는지(scroll)를
 * 주요 이벤트로 봐야 "돈 되는 글"과 "읽히기만 하는 글"이 갈린다. GA4 화면에서 손으로
 * 켜도 되지만, 속성을 새로 만들거나 누가 꺼도 한 번 돌리면 같은 상태로 돌아오게 코드로 둔다.
 *
 * 전부 멱등이다 — 있는 것은 건드리지 않고, 없는 것만 만든다. 결과는 개수로만 돌려준다.
 * https://developers.google.com/analytics/devguides/config/admin/v1/rest
 *
 * 스코프는 analytics.edit. 서비스 계정이 속성 "편집자" 여야 쓰기가 된다.
 */
import { getSettings } from "./db";
import { ga4Creds, type Ga4Creds } from "./ga4";
import { getAccessToken } from "./google-auth";

export const GA4_EDIT_SCOPE = "https://www.googleapis.com/auth/analytics.edit";
const ADMIN = "https://analyticsadmin.googleapis.com";

/** 주요 이벤트로 둘 것. calculator_use 는 계산기 스크립트가 쏘는 커스텀 이벤트다 */
export const KEY_EVENTS = ["calculator_use", "scroll"] as const;

/** 이벤트 범위 맞춤 측정기준. calculator_use 의 calc_type(freelancer33 | vat | income_tax) */
export const CUSTOM_DIMENSIONS = [
  {
    parameterName: "calc_type",
    displayName: "계산기 종류",
    description: "calculator_use 이벤트의 계산기 구분 (freelancer33 · vat · income_tax)",
    scope: "EVENT",
  },
] as const;

/** 향상된 측정 중 켜 둘 것. 전부다 — 티스토리는 페이지 안에서 할 수 있는 행동이 적다 */
const ENHANCED_FLAGS = [
  "streamEnabled",
  "scrollsEnabled",
  "outboundClicksEnabled",
  "siteSearchEnabled",
  "videoEngagementEnabled",
  "fileDownloadsEnabled",
  "pageChangesEnabled",
  "formInteractionsEnabled",
] as const;

async function admin(
  creds: Ga4Creds,
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const token = await getAccessToken(creds.serviceAccount, GA4_EDIT_SCOPE);
  const res = await fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* 아래에서 원문 일부로 */
  }
  if (!res.ok) {
    const msg = (json.error as { message?: string } | undefined)?.message ?? text.slice(0, 300);
    if (res.status === 403) {
      throw new Error(
        `GA4 Admin API 권한 없음 (${path}). 서비스 계정 ${creds.serviceAccount.clientEmail} 을 속성 "편집자"로 두고, GCP 에서 Google Analytics Admin API 를 켰는지 확인하세요. (${msg})`,
      );
    }
    throw new Error(`GA4 Admin API 오류 ${res.status} (${path}): ${msg}`);
  }
  return json;
}

/** 목록 API 는 pageToken 으로 이어진다. 개수가 적어 한두 번이면 끝난다 */
async function listAll<T>(creds: Ga4Creds, path: string, field: string): Promise<T[]> {
  const out: T[] = [];
  let pageToken = "";
  for (let i = 0; i < 20; i += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await admin(creds, `${path}${sep}pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    out.push(...((r[field] as T[] | undefined) ?? []));
    pageToken = String(r.nextPageToken ?? "");
    if (!pageToken) break;
  }
  return out;
}

export type Ga4SetupResult = {
  stream: string;
  /** flags: 이번에 켠 설정 이름 (개수만 찍으면 무엇이 꺼져 있었는지 남지 않는다) */
  enhanced: { checked: number; enabled: number; flags: string[] };
  keyEvents: { existing: number; created: number };
  customDimensions: { existing: number; created: number };
  errors: string[];
};

/**
 * 웹 스트림 하나를 고른다. 설정에 측정 ID(ga4_measurement_id)가 있으면 그 스트림,
 * 없으면 첫 웹 스트림. 스트림이 여러 개인 속성에서 엉뚱한 곳을 켜지 않게 측정 ID 를 먼저 본다.
 */
async function pickStream(creds: Ga4Creds): Promise<string> {
  const s = await getSettings(["ga4_measurement_id"]);
  const measurementId = (s.ga4_measurement_id || process.env.GA4_MEASUREMENT_ID || "").trim();
  const streams = await listAll<{ name?: string; type?: string; webStreamData?: { measurementId?: string } }>(
    creds,
    `/v1beta/properties/${creds.propertyId}/dataStreams`,
    "dataStreams",
  );
  const web = streams.filter((x) => x.type === "WEB_DATA_STREAM");
  const hit = measurementId ? web.find((x) => x.webStreamData?.measurementId === measurementId) : web[0];
  if (!hit?.name) {
    throw new Error(
      measurementId
        ? `측정 ID ${measurementId} 인 웹 스트림이 속성 ${creds.propertyId} 에 없습니다.`
        : `속성 ${creds.propertyId} 에 웹 스트림이 없습니다.`,
    );
  }
  return hit.name; // properties/123/dataStreams/456
}

export async function setupGa4(): Promise<Ga4SetupResult> {
  const resolved = await ga4Creds();
  if ("error" in resolved) throw new Error(resolved.error);
  const { creds } = resolved;
  const errors: string[] = [];
  const prop = `/v1beta/properties/${creds.propertyId}`;

  const result: Ga4SetupResult = {
    stream: "",
    enhanced: { checked: 0, enabled: 0, flags: [] },
    keyEvents: { existing: 0, created: 0 },
    customDimensions: { existing: 0, created: 0 },
    errors,
  };

  /* 1. 향상된 측정 — 꺼진 것만 켠다 (v1alpha 에만 있다) */
  try {
    const stream = await pickStream(creds);
    result.stream = stream.split("/").pop() ?? stream;
    const path = `/v1alpha/${stream}/enhancedMeasurementSettings`;
    const cur = await admin(creds, path);
    const off = ENHANCED_FLAGS.filter((f) => cur[f] !== true);
    result.enhanced.checked = ENHANCED_FLAGS.length;
    if (off.length) {
      const patch = Object.fromEntries(off.map((f) => [f, true]));
      await admin(creds, `${path}?updateMask=${off.join(",")}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      result.enhanced.enabled = off.length;
      result.enhanced.flags = [...off];
    }
  } catch (e) {
    errors.push(`[향상된 측정] ${(e as Error).message}`);
  }

  /*
   * 2. 주요 이벤트. 한 번도 수집된 적 없는 이벤트 이름도 등록된다 — 계산기를 올리기 전에
   * 만들어 두면 첫 사용부터 전환으로 잡힌다.
   */
  try {
    const existing = new Set(
      (await listAll<{ eventName?: string }>(creds, `${prop}/keyEvents`, "keyEvents")).map((k) => k.eventName),
    );
    for (const name of KEY_EVENTS) {
      if (existing.has(name)) {
        result.keyEvents.existing += 1;
        continue;
      }
      try {
        await admin(creds, `${prop}/keyEvents`, {
          method: "POST",
          body: JSON.stringify({ eventName: name, countingMethod: "ONCE_PER_EVENT" }),
        });
        result.keyEvents.created += 1;
      } catch (e) {
        errors.push(`[주요 이벤트 ${name}] ${(e as Error).message}`);
      }
    }
  } catch (e) {
    errors.push(`[주요 이벤트] ${(e as Error).message}`);
  }

  /* 3. 맞춤 측정기준. 이미 있으면(보관처리된 것 포함 이름이 같으면) 건너뛴다 */
  try {
    const existing = new Set(
      (
        await listAll<{ parameterName?: string; scope?: string }>(creds, `${prop}/customDimensions`, "customDimensions")
      ).map((d) => `${d.scope}:${d.parameterName}`),
    );
    for (const dim of CUSTOM_DIMENSIONS) {
      if (existing.has(`${dim.scope}:${dim.parameterName}`)) {
        result.customDimensions.existing += 1;
        continue;
      }
      try {
        await admin(creds, `${prop}/customDimensions`, { method: "POST", body: JSON.stringify(dim) });
        result.customDimensions.created += 1;
      } catch (e) {
        errors.push(`[맞춤 측정기준 ${dim.parameterName}] ${(e as Error).message}`);
      }
    }
  } catch (e) {
    errors.push(`[맞춤 측정기준] ${(e as Error).message}`);
  }

  return result;
}
