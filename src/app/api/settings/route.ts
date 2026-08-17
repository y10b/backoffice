import { NextResponse } from "next/server";
import { getSettings, setSetting } from "@/lib/db";
import { splitKeys } from "@/lib/gemini";
import { DEFAULT_MODEL as CLAUDE_DEFAULT_MODEL } from "@/lib/claude";
import { DEFAULT_MODEL as VEO_DEFAULT_MODEL } from "@/lib/veo";
import { FREE_MODEL as FISH_FREE_MODEL } from "@/lib/fishaudio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/** DB 값이 우선이고, 없으면 환경변수로 떨어진다. */
function resolve(
  stored: string | undefined,
  env: string,
): { value: string; fromEnv: boolean } {
  if (stored) return { value: stored, fromEnv: false };
  return { value: process.env[env] ?? "", fromEnv: Boolean(process.env[env]) };
}

export async function GET() {
  // 설정 화면은 키를 열 개 넘게 읽는다. 하나씩 왕복하면 화면이 눈에 띄게 느려진다
  const s = await getSettings([
    "searchad_api_key", "searchad_secret_key", "searchad_customer_id",
    "naver_client_id", "naver_client_secret",
    "gemini_api_key", "gemini_model",
    "ga4_service_account", "ga4_property_id",
    "adsense_client_id", "adsense_client_secret",
    "adsense_refresh_token", "adsense_account",
    "youtube_api_key",
    "anthropic_api_key", "claude_model",
    "veo_model",
    "fish_api_key", "fish_model",
  ]);

  const adKey = resolve(s.searchad_api_key, "NAVER_SEARCHAD_API_KEY");
  const adSecret = resolve(s.searchad_secret_key, "NAVER_SEARCHAD_SECRET_KEY");
  const adCustomer = resolve(s.searchad_customer_id, "NAVER_SEARCHAD_CUSTOMER_ID");
  const clientId = resolve(s.naver_client_id, "NAVER_CLIENT_ID");
  const clientSecret = resolve(s.naver_client_secret, "NAVER_CLIENT_SECRET");
  const gemini = resolve(s.gemini_api_key, "GEMINI_API_KEY");
  const gaKey = resolve(s.ga4_service_account, "GA4_SERVICE_ACCOUNT");
  const gaProp = resolve(s.ga4_property_id, "GA4_PROPERTY_ID");
  const adsenseId = resolve(s.adsense_client_id, "ADSENSE_CLIENT_ID");
  const adsenseSecret = resolve(s.adsense_client_secret, "ADSENSE_CLIENT_SECRET");
  const adsenseToken = s.adsense_refresh_token ?? "";
  const youtube = resolve(s.youtube_api_key, "YOUTUBE_API_KEY");
  const anthropic = resolve(s.anthropic_api_key, "ANTHROPIC_API_KEY");
  const fish = resolve(s.fish_api_key, "FISH_API_KEY");

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
      account: s.adsense_account ?? "",
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
      // 키가 여러 개면 첫 개만 미리보기로 쓰고 개수를 따로 알린다
      apiKeyPreview: mask(splitKeys(gemini.value)[0] ?? ""),
      keyCount: splitKeys(`${gemini.value}\n${process.env.GEMINI_API_KEY ?? ""}`).length,
      model: s.gemini_model || process.env.GEMINI_MODEL || "gemini-2.5-flash",
    },
    youtube: {
      configured: Boolean(youtube.value),
      fromEnv: youtube.fromEnv,
      apiKeyPreview: mask(youtube.value),
    },
    claude: {
      configured: Boolean(anthropic.value),
      fromEnv: anthropic.fromEnv,
      apiKeyPreview: mask(anthropic.value),
      model: s.claude_model || process.env.CLAUDE_MODEL || CLAUDE_DEFAULT_MODEL,
    },
    veo: {
      // Veo 는 Gemini 키를 그대로 쓴다. 별도 키가 없으니 설정 여부도 Gemini 를 따른다
      configured: Boolean(gemini.value),
      model: s.veo_model || process.env.VEO_MODEL || VEO_DEFAULT_MODEL,
    },
    fish: {
      configured: Boolean(fish.value),
      fromEnv: fish.fromEnv,
      apiKeyPreview: mask(fish.value),
      model: s.fish_model || process.env.FISH_MODEL || FISH_FREE_MODEL,
      free: (s.fish_model || process.env.FISH_MODEL || FISH_FREE_MODEL) === FISH_FREE_MODEL,
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
  youtubeApiKey: "youtube_api_key",
  anthropicApiKey: "anthropic_api_key",
  claudeModel: "claude_model",
  veoModel: "veo_model",
  fishApiKey: "fish_api_key",
  fishModel: "fish_model",
};

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const warnings: string[] = [];

  for (const [field, key] of Object.entries(TEXT_FIELDS)) {
    const v = body[field];
    if (typeof v === "string" && v.trim()) await setSetting(key, v.trim());
  }

  if (
    typeof body.searchAdCustomerId === "string" &&
    body.searchAdCustomerId.trim() &&
    !/^\d+$/.test(body.searchAdCustomerId.trim())
  ) {
    warnings.push("CUSTOMER_ID 는 보통 숫자입니다. 검색광고 > 도구 > API 관리에서 확인하세요.");
  }

  if (body.clearSearchAd) {
    await setSetting("searchad_api_key", "");
    await setSetting("searchad_secret_key", "");
    await setSetting("searchad_customer_id", "");
  }
  if (body.clearOpenApi) {
    await setSetting("naver_client_id", "");
    await setSetting("naver_client_secret", "");
  }
  if (body.clearGa4) {
    await setSetting("ga4_service_account", "");
    await setSetting("ga4_property_id", "");
  }
  if (body.clearAdsense) {
    await setSetting("adsense_client_id", "");
    await setSetting("adsense_client_secret", "");
    // 토큰과 계정 캐시까지 지워야 다음 연결이 깨끗하게 시작된다
    await setSetting("adsense_refresh_token", "");
    await setSetting("adsense_account", "");
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
