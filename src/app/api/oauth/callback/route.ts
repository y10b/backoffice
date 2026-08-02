import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import {
  KEY_ACCOUNT,
  KEY_REFRESH_TOKEN,
  KEY_STATE,
  REDIRECT_URI,
  adsenseCreds,
  clearTokenCache,
  exchangeCode,
  resolveAccount,
  resultPage,
  tokenErrorMessage,
  verifyState,
} from "@/lib/adsense";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function fail(title: string, lines: string[], status = 400): NextResponse {
  return html(resultPage({ ok: false, title, lines }), status);
}

/**
 * 구글 동의 화면이 돌려보내는 착지점. 브라우저가 직접 여는 유일한 API 라 JSON 이 아니라
 * 한국어 안내 HTML 을 준다. 오류 원문은 escape 를 거쳐(resultPage 안에서) 들어간다.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const denied = params.get("error");
  const code = params.get("code");
  const state = params.get("state");

  // state 는 성공하든 실패하든 한 번 쓰고 버린다(재사용 차단)
  const savedState = await getSetting(KEY_STATE);
  setSetting(KEY_STATE, "");

  if (denied) {
    return fail("애드센스 연결이 취소됐습니다", [
      tokenErrorMessage(400, denied, params.get("error_description") ?? ""),
    ]);
  }
  if (!code) {
    return fail("인증 코드가 없습니다", [
      "구글이 code 파라미터를 보내지 않았습니다. 설정 화면에서 [애드센스 연결] 을 다시 눌러 주세요.",
    ]);
  }
  if (!verifyState(savedState, state)) {
    return fail("요청을 확인하지 못했습니다", [
      "CSRF 방지용 state 값이 맞지 않거나 만료됐습니다(10분).",
      "연결을 시작한 창과 돌아온 창이 다르거나, 오래된 링크를 다시 연 경우입니다. 설정 화면에서 처음부터 다시 시도하세요.",
    ]);
  }

  const creds = await adsenseCreds();
  if (!creds) {
    return fail("OAuth 클라이언트가 없습니다", [
      "연결 도중 클라이언트 ID/시크릿이 지워졌습니다. 설정 화면에서 다시 저장한 뒤 시도하세요.",
    ]);
  }

  const exchanged = await exchangeCode(code, creds);
  if (!exchanged.ok) {
    return fail("토큰 교환에 실패했습니다", [
      exchanged.error,
      // 가장 흔한 원인이라 URI 를 그대로 보여줘 복사·붙여넣기로 끝나게 한다
      `승인된 리디렉션 URI 가 정확히 아래와 같아야 합니다: ${REDIRECT_URI}`,
    ]);
  }

  setSetting(KEY_REFRESH_TOKEN, exchanged.refreshToken);
  // 다른 구글 계정으로 다시 연결했을 수 있으니 캐시된 계정 이름과 토큰은 버린다
  setSetting(KEY_ACCOUNT, "");
  clearTokenCache();

  // 여기서 계정을 한 번 조회해두면 API 활성화 여부까지 지금 확인되고, 대시보드는 바로 그린다
  const account = await resolveAccount(exchanged.accessToken);
  if (!account.ok) {
    return html(
      resultPage({
        ok: false,
        title: "연결은 됐지만 계정을 읽지 못했습니다",
        lines: [
          "인증 자체는 성공해 토큰을 저장했습니다.",
          account.error,
          "원인을 해결한 뒤 대시보드를 새로고침하면 됩니다.",
        ],
      }),
      200,
    );
  }

  return html(
    resultPage({
      ok: true,
      title: "애드센스 연결 완료",
      lines: [
        `연결된 애드센스 계정: ${account.account}`,
        "이제 대시보드에서 수익이 보입니다.",
      ],
    }),
    200,
  );
}
