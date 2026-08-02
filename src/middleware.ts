import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authRequired, verifySession } from "@/lib/auth";

/**
 * 모든 요청을 막고 로그인한 세션만 통과시킨다.
 *
 * 화면만 막고 API 를 열어두면 의미가 없다 — `/api/settings` 하나로 키가 전부 새고,
 * `/api/analytics/adsense` 로 수익이 보인다. 그래서 matcher 가 API 도 포함한다.
 */
export async function middleware(req: NextRequest) {
  if (!authRequired()) return NextResponse.next();

  const { pathname, search } = req.nextUrl;

  // 로그인 자체와 로그아웃은 막으면 안 된다. 막으면 들어올 방법이 없어진다
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  /*
   * 자동화(GitHub Actions)는 브라우저가 아니라 세션 쿠키를 만들 수 없다.
   * 그래서 크론 경로만 통과시키고, 대신 라우트 안에서 CRON_SECRET 으로 따로 확인한다.
   * 여기서 막으면 자동 생성이 아예 못 들어온다.
   */
  if (pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  /*
   * API 는 로그인 화면 HTML 을 돌려받아도 쓸 수 없다. 화면 요청과 갈라서
   * fetch 하는 쪽이 상태 코드로 판단할 수 있게 한다.
   */
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "로그인이 필요합니다." },
      { status: 401 },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  /*
   * 정적 자원과 robots.txt 는 인증 없이 나가야 한다.
   * robots.txt 를 막으면 크롤러가 "수집 금지" 지시 자체를 못 읽는다.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
