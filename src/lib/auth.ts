/**
 * 백오피스 접근 제어.
 *
 * 로컬 전용일 때는 인증이 필요 없었지만, 배포하면 URL 을 아는 누구나 설정 화면에서
 * Gemini·검색광고 키를 꺼내 쓰고 애드센스 수익을 들여다볼 수 있다.
 * `robots.txt` 와 `noindex` 는 색인만 막지 접근을 막지 못한다.
 *
 * 미들웨어(Edge 런타임)에서 검증하므로 `node:crypto` 를 쓸 수 없다.
 * Web Crypto(`crypto.subtle`)만 사용하고, 그래서 모든 함수가 비동기다.
 *
 * 세션은 서버에 저장하지 않는다. 토큰이 만료시각과 그 서명을 함께 들고 다녀
 * 자체 검증된다 — 저장소를 붙이면 DB 왕복이 매 요청마다 생긴다.
 */

export const SESSION_COOKIE = "backoffice_session";

/** 일주일. 개인 도구라 자주 로그인시킬 이유가 없다 */
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * 비밀번호가 설정돼 있지 않으면 인증을 통째로 건너뛴다.
 * 로컬에서 매번 로그인하는 건 불필요한 마찰이고, 이 도구는 로컬로도 계속 쓴다.
 * 배포 환경에는 반드시 `BACKOFFICE_PASSWORD` 를 넣어야 한다.
 */
export function authRequired(): boolean {
  return Boolean(process.env.BACKOFFICE_PASSWORD);
}

function secret(): string {
  // 서명 키를 따로 두지 않았다면 비밀번호로 대신한다. 비밀번호를 바꾸면 기존 세션이
  // 자동으로 무효가 되는 부수 효과가 있는데, 이 경우엔 오히려 바람직하다.
  return process.env.SESSION_SECRET || process.env.BACKOFFICE_PASSWORD || "";
}

function toBase64Url(bytes: ArrayBuffer): string {
  let bin = "";
  const view = new Uint8Array(bytes);
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
}

/**
 * 길이를 먼저 비교하고 전 바이트를 XOR 로 누적한다.
 * Edge 에는 `timingSafeEqual` 이 없어서 직접 구현한다. 앞 글자만 맞아도 빨리 끝나는
 * `===` 비교는 응답 시간으로 정답을 흘린다.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 형식: `{만료ms}.{base64url(HMAC)}` */
export async function createSession(now = Date.now()): Promise<string> {
  const exp = String(now + SESSION_MAX_AGE_SEC * 1000);
  return `${exp}.${await hmac(exp, secret())}`;
}

export async function verifySession(
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !sig) return false;

  // 만료를 먼저 본다. 지난 토큰은 서명이 맞아도 통과시키지 않는다
  if (Number(exp) <= now) return false;

  return timingSafeEqual(sig, await hmac(exp, secret()));
}

export async function verifyPassword(input: string): Promise<boolean> {
  const expected = process.env.BACKOFFICE_PASSWORD || "";
  if (!expected) return false;
  // 길이 차이로도 정보가 새지 않게, 비교 전에 양쪽을 같은 길이의 해시로 만든다
  const key = secret();
  return timingSafeEqual(await hmac(input, key), await hmac(expected, key));
}

/**
 * 로그인 후 돌아갈 경로. 외부 주소로 튕기는 오픈 리다이렉트를 막기 위해
 * 같은 출처의 경로(`/` 로 시작하고 `//` 가 아닌 것)만 허용한다.
 */
export function safeNextPath(input: string | null | undefined): string {
  if (!input || !input.startsWith("/") || input.startsWith("//")) return "/";
  return input;
}
