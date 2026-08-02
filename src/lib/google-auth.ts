import crypto from "node:crypto";

/**
 * 구글 서비스 계정 → 액세스 토큰 (2-legged OAuth, JWT Bearer).
 *
 * GA4 Data API 는 서비스 계정을 받아주므로 브라우저 동의 화면이 필요 없다.
 * 개인 백오피스에 리다이렉트 URI·리프레시 토큰 저장소를 두지 않으려고 이 방식을 골랐다.
 * https://developers.google.com/identity/protocols/oauth2/service-account
 *
 * 이 파일은 DB 를 모른다. 자격증명은 전부 인자로 받는다.
 * (설정 읽기는 ga4.ts 가 하고, 여기는 순수 함수로 남겨 단독 테스트가 되게 한다.)
 */
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GA4_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** 구글이 허용하는 JWT 최대 수명. 넘기면 발급 자체가 거부된다. */
const MAX_TTL_SECONDS = 3600;
/** 만료 직전 토큰으로 요청을 쏘면 도착 시점에 이미 죽어 있을 수 있어 미리 갈아끼운다. */
const REFRESH_SKEW_MS = 60_000;

export type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
};

/**
 * base64url 은 표준 base64 와 세 글자가 다르다(`+`→`-`, `/`→`_`, 패딩 `=` 제거).
 * 그대로 표준 base64 를 보내면 구글은 서명 검증에 실패해 invalid_grant 만 던지고
 * 무엇이 틀렸는지는 알려주지 않는다. 디버깅이 가장 어려운 지점이라 함수로 못 박아 둔다.
 */
export function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * PEM 안의 줄바꿈을 되살린다.
 *
 * 키 파일을 통째로 붙여넣으면 JSON.parse 가 `\n` 을 실제 줄바꿈으로 풀어주지만,
 * private_key 값만 따로 복사해 오면 역슬래시+n 두 글자가 그대로 남는다.
 * 그 상태로는 createSign 이 PEM 을 못 읽으므로 양쪽 입력을 모두 받아준다.
 */
export function normalizePrivateKey(pem: string): string {
  return `${pem.replace(/\\n/g, "\n").trim()}\n`;
}

/** 설정에 저장된 서비스 계정 JSON 문자열을 파싱한다. 형식이 틀리면 한국어로 던진다. */
export function parseServiceAccount(raw: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      "서비스 계정 JSON 을 해석하지 못했습니다. GCP 에서 내려받은 키 파일 내용을 중괄호까지 통째로 붙여넣었는지 확인하세요.",
    );
  }

  const o = (json ?? {}) as {
    type?: unknown;
    client_email?: unknown;
    private_key?: unknown;
  };
  const clientEmail = typeof o.client_email === "string" ? o.client_email.trim() : "";
  const privateKey = typeof o.private_key === "string" ? o.private_key : "";

  if (!clientEmail || !privateKey) {
    // OAuth 클라이언트 JSON(installed/web) 을 대신 붙여넣는 실수가 잦아 구분해 안내한다.
    throw new Error(
      o.type === "service_account"
        ? "서비스 계정 JSON 에 client_email 또는 private_key 가 없습니다. 키 파일이 잘리지 않았는지 확인하세요."
        : '서비스 계정 키가 아닙니다. GCP → IAM 및 관리자 → 서비스 계정 → 키에서 만든 JSON("type": "service_account")을 붙여넣으세요.',
    );
  }

  return { clientEmail, privateKey: normalizePrivateKey(privateKey) };
}

export type JwtClaim = {
  iss: string;
  scope: string;
  aud: string;
  iat: number;
  exp: number;
};

export function buildClaim(
  clientEmail: string,
  scope: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = MAX_TTL_SECONDS,
): JwtClaim {
  return {
    iss: clientEmail,
    scope,
    aud: TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + Math.min(MAX_TTL_SECONDS, Math.max(60, ttlSeconds)),
  };
}

/**
 * 서명 대상 문자열 `base64url(header).base64url(claim)`.
 * 서명한 뒤 이 문자열을 그대로 다시 만들어 쓰면 JSON 키 순서가 달라져 검증이 깨질 수 있어,
 * 조립을 한 곳에 모으고 호출부는 결과만 이어 붙인다.
 */
export function signingInput(claim: JwtClaim): string {
  const header = { alg: "RS256", typ: "JWT" };
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
}

/** 서명까지 마친 JWT assertion 한 줄. */
export function buildAssertion(
  sa: ServiceAccount,
  scope: string,
  nowSeconds?: number,
): string {
  const input = signingInput(buildClaim(sa.clientEmail, scope, nowSeconds));
  let signature: Buffer;
  try {
    signature = crypto.createSign("RSA-SHA256").update(input).sign(sa.privateKey);
  } catch {
    // 원문 예외에 키 일부가 실려 나올 수 있어 삼키고 우리 문구만 남긴다.
    throw new Error(
      "서비스 계정 개인키(private_key)를 읽지 못했습니다. BEGIN/END PRIVATE KEY 줄을 포함해 값이 온전한지 확인하세요.",
    );
  }
  return `${input}.${base64url(signature)}`;
}

type TokenEntry = { token: string; expiresAt: number };

/**
 * 토큰 캐시. 액세스 토큰은 1시간짜리인데 대시보드는 새로고침마다 API 를 부르므로,
 * 매번 새로 발급받으면 왕복 한 번이 통째로 늘고 토큰 발급 한도도 갉아먹는다.
 *
 * 키에 개인키 지문을 섞는 이유: 키를 새로 발급해 교체해도 client_email 은 그대로라,
 * 이메일만으로 캐싱하면 폐기된 토큰을 만료까지 계속 쓰게 된다.
 */
const tokenCache = new Map<string, TokenEntry>();
/** 첫 로딩에 요청이 동시에 여러 개 뜨면 발급도 여러 번 나가므로 진행 중인 것을 공유한다. */
const inflight = new Map<string, Promise<string>>();

function cacheKey(sa: ServiceAccount, scope: string): string {
  const fingerprint = crypto
    .createHash("sha256")
    .update(sa.privateKey)
    .digest("hex")
    .slice(0, 16);
  return `${sa.clientEmail}|${scope}|${fingerprint}`;
}

async function requestAccessToken(
  sa: ServiceAccount,
  scope: string,
): Promise<TokenEntry> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: buildAssertion(sa, scope),
  });

  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(`구글 토큰 서버에 접속하지 못했습니다: ${(e as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* JSON 이 아니면 아래에서 상태 코드만으로 안내한다 */
  }
  const payload = (parsed ?? {}) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !payload.access_token) {
    throw new Error(explainTokenError(res.status, payload.error, payload.error_description));
  }

  const ttl = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600;
  return { token: payload.access_token, expiresAt: Date.now() + ttl * 1000 };
}

/**
 * 토큰 발급 실패는 원문이 `invalid_grant` 한 단어뿐이라 그대로 보여주면 손쓸 데가 없다.
 * 사용자가 실제로 확인할 곳을 문구에 담는다. assertion·키는 절대 싣지 않는다.
 */
export function explainTokenError(
  status: number,
  error?: string,
  description?: string,
): string {
  const detail = [error, description].filter(Boolean).join(": ") || `HTTP ${status}`;

  if (error === "invalid_grant") {
    return `구글이 JWT 서명을 거부했습니다 (${detail}). 서비스 계정 키가 폐기되지 않았는지, PC 시각이 실제 시각과 크게 어긋나지 않았는지 확인하세요.`;
  }
  if (error === "invalid_client" || error === "unauthorized_client") {
    return `서비스 계정을 확인하지 못했습니다 (${detail}). client_email 이 맞는지, 해당 키가 GCP 에서 삭제되지 않았는지 확인하세요.`;
  }
  if (error === "invalid_scope") {
    return `요청한 권한 범위가 거부됐습니다 (${detail}). 조직 정책으로 서비스 계정 사용이 막혀 있을 수 있습니다.`;
  }
  if (status === 401) {
    return `토큰 발급 인증에 실패했습니다 (${detail}). 키가 잘못됐거나 PC 시각이 어긋났을 때 주로 납니다.`;
  }
  return `토큰 발급 실패 (HTTP ${status}): ${detail}`;
}

/** 캐시된 액세스 토큰. 만료 60초 전부터는 새로 받는다. */
export async function getAccessToken(
  sa: ServiceAccount,
  scope: string = GA4_READONLY_SCOPE,
): Promise<string> {
  const key = cacheKey(sa, scope);

  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - REFRESH_SKEW_MS > Date.now()) return hit.token;

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = requestAccessToken(sa, scope)
    .then((entry) => {
      tokenCache.set(key, entry);
      return entry.token;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** 설정 화면에서 키를 갈아끼웠을 때 죽은 토큰을 붙들지 않도록 비운다. */
export function clearTokenCache(): void {
  tokenCache.clear();
}
