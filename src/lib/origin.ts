/**
 * 이 앱이 서비스되는 주소.
 *
 * OAuth 리디렉션 URI 를 조립하는 데 쓴다. 로컬에서는 3939 포트지만 배포하면 Vercel
 * 도메인이라, 하드코딩해 두면 배포 즉시 `redirect_uri_mismatch` 가 난다.
 */
const LOCAL_ORIGIN = "http://localhost:3939";

export function appOrigin(): string {
  const raw = (process.env.APP_ORIGIN || "").trim();
  if (!raw) return LOCAL_ORIGIN;
  // 끝 슬래시가 붙어 들어오면 `//api/oauth/callback` 이 되어 URI 가 안 맞는다
  return raw.replace(/\/+$/, "");
}

/**
 * 구글 동의 후 돌아올 주소.
 *
 * 이 값이 바뀌면 GCP 콘솔의 **승인된 리디렉션 URI** 에도 같은 값을 등록해야 한다.
 * 한 글자라도 다르면(끝 슬래시, 포트, localhost↔127.0.0.1) 구글이 거부한다.
 */
export function oauthRedirectUri(): string {
  return `${appOrigin()}/api/oauth/callback`;
}
