import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import {
  DEFAULT_PRESETS,
  cookieHasAuth,
  loadPresets,
  normalizeCookie,
} from "@/lib/naver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mask(v: string | null): string {
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

export async function GET() {
  const cookie = getSetting("naver_cookie") ?? "";
  const key = getSetting("gemini_api_key") ?? "";
  return NextResponse.json({
    naverCookieSet: Boolean(cookie),
    naverCookieValid: cookieHasAuth(cookie),
    naverCookiePreview: mask(cookie),
    geminiKeySet: Boolean(key || process.env.GEMINI_API_KEY),
    geminiKeyFromEnv: !key && Boolean(process.env.GEMINI_API_KEY),
    geminiKeyPreview: mask(key),
    geminiModel: getSetting("gemini_model") || process.env.GEMINI_MODEL || "gemini-2.5-pro",
    presets: loadPresets(),
    defaultPresets: DEFAULT_PRESETS,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const warnings: string[] = [];

  if (typeof body.naverCookie === "string" && body.naverCookie.trim()) {
    const normalized = normalizeCookie(body.naverCookie);
    if (!cookieHasAuth(normalized)) {
      warnings.push(
        "쿠키에 NID_AUT 또는 NID_SES 가 없습니다. 로그인 상태의 creator-advisor.naver.com 요청에서 Cookie 헤더 전체를 복사하세요.",
      );
    }
    setSetting("naver_cookie", normalized);
  }

  if (typeof body.geminiApiKey === "string" && body.geminiApiKey.trim()) {
    setSetting("gemini_api_key", body.geminiApiKey.trim());
  }

  if (typeof body.geminiModel === "string" && body.geminiModel.trim()) {
    setSetting("gemini_model", body.geminiModel.trim());
  }

  if (Array.isArray(body.presets)) {
    setSetting("endpoint_presets", JSON.stringify(body.presets));
  }

  if (body.clearNaverCookie) setSetting("naver_cookie", "");
  if (body.resetPresets) setSetting("endpoint_presets", JSON.stringify(DEFAULT_PRESETS));

  return NextResponse.json({ ok: true, warnings });
}
