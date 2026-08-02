import { NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import {
  KEY_STATE,
  REDIRECT_URI,
  adsenseCreds,
  buildConsentUrl,
  newState,
  resultPage,
  stateRecord,
} from "@/lib/adsense";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * 애드센스 연결 시작점. 설정 화면의 버튼이 이 주소를 그냥 열면 된다.
 * 애드센스 Management API 는 서비스 계정을 못 쓰므로 사용자 동의를 반드시 거쳐야 한다.
 */
export async function GET() {
  const creds = adsenseCreds();
  if (!creds) {
    // 사람이 브라우저로 여는 화면이라 JSON 대신 안내를 보여준다
    return html(
      resultPage({
        ok: false,
        title: "먼저 OAuth 클라이언트를 등록하세요",
        lines: [
          "애드센스 OAuth 클라이언트 ID/시크릿이 저장돼 있지 않습니다.",
          "GCP > API 및 서비스 > 사용자 인증 정보에서 '웹 애플리케이션' 클라이언트를 만들고, 설정 화면에 ID 와 시크릿을 저장한 뒤 다시 시도하세요.",
          `이때 승인된 리디렉션 URI 로 ${REDIRECT_URI} 를 함께 등록해야 합니다.`,
        ],
      }),
      400,
    );
  }

  // CSRF 방지용 난수. 콜백에서 이 값과 대조해 남이 흘린 code 를 삼키지 않게 한다.
  const state = newState();
  setSetting(KEY_STATE, stateRecord(state));

  return NextResponse.redirect(buildConsentUrl(creds.clientId, state), 302);
}
