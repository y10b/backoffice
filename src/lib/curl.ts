/**
 * DevTools 의 "Copy as cURL" 결과를 파싱한다.
 * 엔드포인트가 바뀌었을 때 코드를 고치는 대신 붙여넣기로 해결하기 위한 통로.
 */
export type ParsedCurl = {
  url: string;
  cookie: string | null;
  headers: Record<string, string>;
};

/** 셸 인용 규칙(작은따옴표/큰따옴표/백슬래시/줄바꿈 continuation)을 고려해 토큰화 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\" && i + 1 < input.length) {
        cur += input[++i];
      } else if (ch === '"') {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }

    // 줄 끝 백슬래시는 continuation, 그 외 백슬래시는 다음 문자를 이스케이프
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === "\n" || next === "\r") {
        i++;
        if (next === "\r" && input[i + 1] === "\n") i++;
        continue;
      }
      if (next !== undefined) {
        cur += next;
        i++;
        started = true;
        continue;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur || started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }

    cur += ch;
    started = true;
  }

  if (cur || started) tokens.push(cur);
  return tokens;
}

export function parseCurl(input: string): ParsedCurl {
  const tokens = tokenize(input.trim());
  if (!tokens.length) throw new Error("빈 입력입니다.");

  const headers: Record<string, string> = {};
  let url: string | null = null;
  let cookie: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === "curl") continue;

    if (t === "-H" || t === "--header") {
      const raw = tokens[++i];
      if (!raw) continue;
      const idx = raw.indexOf(":");
      if (idx === -1) continue;
      const name = raw.slice(0, idx).trim().toLowerCase();
      const value = raw.slice(idx + 1).trim();
      if (name === "cookie") cookie = value;
      else headers[name] = value;
      continue;
    }

    if (t === "-b" || t === "--cookie") {
      cookie = tokens[++i] ?? null;
      continue;
    }

    if (t === "--url") {
      url = tokens[++i] ?? null;
      continue;
    }

    // 값을 소비하는 플래그는 인자까지 건너뛴다
    if (/^(-X|--request|-d|--data|--data-raw|--data-binary|-A|--user-agent|-e|--referer|--compressed-mime)$/.test(t)) {
      i++;
      continue;
    }

    // 나머지 옵션 플래그는 무시
    if (t.startsWith("-")) continue;

    if (!url && /^https?:\/\//i.test(t)) url = t;
  }

  if (!url) throw new Error("cURL 문자열에서 URL 을 찾지 못했습니다.");

  return { url, cookie, headers };
}

/** 파싱한 URL 을 프리셋(path + query) 형태로 되돌린다 */
export function curlToPreset(url: string): { path: string; query: Record<string, string> } {
  const u = new URL(url);
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  return { path: u.pathname, query };
}
