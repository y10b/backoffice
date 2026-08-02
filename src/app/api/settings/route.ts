import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/** DB 값이 우선이고, 없으면 환경변수로 떨어진다. */
function resolve(key: string, env: string): { value: string; fromEnv: boolean } {
  const stored = getSetting(key) ?? "";
  if (stored) return { value: stored, fromEnv: false };
  return { value: process.env[env] ?? "", fromEnv: Boolean(process.env[env]) };
}

export async function GET() {
  const adKey = resolve("searchad_api_key", "NAVER_SEARCHAD_API_KEY");
  const adSecret = resolve("searchad_secret_key", "NAVER_SEARCHAD_SECRET_KEY");
  const adCustomer = resolve("searchad_customer_id", "NAVER_SEARCHAD_CUSTOMER_ID");
  const clientId = resolve("naver_client_id", "NAVER_CLIENT_ID");
  const clientSecret = resolve("naver_client_secret", "NAVER_CLIENT_SECRET");
  const gemini = resolve("gemini_api_key", "GEMINI_API_KEY");
  const gaKey = resolve("ga4_service_account", "GA4_SERVICE_ACCOUNT");
  const gaProp = resolve("ga4_property_id", "GA4_PROPERTY_ID");
  const adsenseId = resolve("adsense_client_id", "ADSENSE_CLIENT_ID");
  const adsenseSecret = resolve("adsense_client_secret", "ADSENSE_CLIENT_SECRET");
  const adsenseToken = getSetting("adsense_refresh_token") ?? "";

  // 서비스 계정 JSON 은 통째로 저장되므로, 화면에는 어느 계정인지만 보여준다
  let gaEmail = "";
  try {
    gaEmail = String(JSON.parse(gaKey.value || "{}").client_email ?? "");
  } catch {
    /* 깨진 JSON 이면 이메일을 못 보여줄 뿐, 저장 자체는 막지 않는다 */
  }

  return NextResponse.json({
    ga4: {
      configured: Boolean(gaKey.value && gaProp.value),
      fromEnv: gaKey.fromEnv,
      clientEmail: gaEmail,
      propertyId: gaProp.value,
      keyValid: Boolean(gaEmail),
    },
    adsense: {
      configured: Boolean(adsenseId.value && adsenseSecret.value),
      fromEnv: adsenseId.fromEnv,
      clientIdPreview: mask(adsenseId.value),
      connected: Boolean(adsenseToken),
      account: getSetting("adsense_account") ?? "",
    },
    searchAd: {
      configured: Boolean(adKey.value && adSecret.value && adCustomer.value),
      fromEnv: adKey.fromEnv,
      apiKeyPreview: mask(adKey.value),
      secretKeySet: Boolean(adSecret.value),
      customerId: adCustomer.value,
    },
    openApi: {
      configured: Boolean(clientId.value && clientSecret.value),
      fromEnv: clientId.fromEnv,
      clientIdPreview: mask(clientId.value),
      clientSecretSet: Boolean(clientSecret.value),
    },
    gemini: {
      configured: Boolean(gemini.value),
      fromEnv: gemini.fromEnv,
      apiKeyPreview: mask(gemini.value),
      model: getSetting("gemini_model") || process.env.GEMINI_MODEL || "gemini-2.5-pro",
    },
  });
}

const TEXT_FIELDS: Record<string, string> = {
  searchAdApiKey: "searchad_api_key",
  searchAdSecretKey: "searchad_secret_key",
  searchAdCustomerId: "searchad_customer_id",
  naverClientId: "naver_client_id",
  naverClientSecret: "naver_client_secret",
  geminiApiKey: "gemini_api_key",
  geminiModel: "gemini_model",
  ga4ServiceAccount: "ga4_service_account",
  ga4PropertyId: "ga4_property_id",
  adsenseClientId: "adsense_client_id",
  adsenseClientSecret: "adsense_client_secret",
};

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const warnings: string[] = [];

  for (const [field, key] of Object.entries(TEXT_FIELDS)) {
    const v = body[field];
    if (typeof v === "string" && v.trim()) setSetting(key, v.trim());
  }

  if (
    typeof body.searchAdCustomerId === "string" &&
    body.searchAdCustomerId.trim() &&
    !/^\d+$/.test(body.searchAdCustomerId.trim())
  ) {
    warnings.push("CUSTOMER_ID 는 보통 숫자입니다. 검색광고 > 도구 > API 관리에서 확인하세요.");
  }

  if (body.clearSearchAd) {
    setSetting("searchad_api_key", "");
    setSetting("searchad_secret_key", "");
    setSetting("searchad_customer_id", "");
  }
  if (body.clearOpenApi) {
    setSetting("naver_client_id", "");
    setSetting("naver_client_secret", "");
  }
  if (body.clearGa4) {
    setSetting("ga4_service_account", "");
    setSetting("ga4_property_id", "");
  }
  if (body.clearAdsense) {
    setSetting("adsense_client_id", "");
    setSetting("adsense_client_secret", "");
    // 토큰과 계정 캐시까지 지워야 다음 연결이 깨끗하게 시작된다
    setSetting("adsense_refresh_token", "");
    setSetting("adsense_account", "");
  }

  // 서비스 계정 JSON 은 형식이 틀리면 조회 시점에야 실패해서, 저장할 때 미리 잡아준다
  if (typeof body.ga4ServiceAccount === "string" && body.ga4ServiceAccount.trim()) {
    try {
      const parsed = JSON.parse(body.ga4ServiceAccount);
      if (!parsed.client_email || !parsed.private_key) {
        warnings.push(
          "서비스 계정 JSON 에 client_email 또는 private_key 가 없습니다. GCP 에서 받은 키 파일 내용을 그대로 붙여넣으세요.",
        );
      }
    } catch {
      warnings.push("서비스 계정 JSON 을 해석하지 못했습니다. 파일 내용 전체를 붙여넣었는지 확인하세요.");
    }
  }

  if (
    typeof body.ga4PropertyId === "string" &&
    body.ga4PropertyId.trim() &&
    !/^\d+$/.test(body.ga4PropertyId.trim())
  ) {
    warnings.push(
      "GA4 속성 ID 는 숫자입니다. 측정 ID(G-XXXXXXX)가 아니라 관리 → 속성 설정에 있는 숫자 ID 를 넣으세요.",
    );
  }

  return NextResponse.json({ ok: true, warnings });
}
