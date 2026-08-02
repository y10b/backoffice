/**
 * 본문을 보조하는 시각 자료(비교표·단계 흐름·요약 박스 등)를 HTML 로 다룬다.
 *
 * 왜 이미지가 아니라 HTML 인가:
 *  - 이미지 생성은 별도 API·저장소·업로드가 필요하고 붙여넣기로 옮길 수 없다.
 *  - 인라인 스타일 HTML 은 티스토리 HTML 모드에 그대로 붙으면 바로 보인다.
 *  - 텍스트라서 검색엔진이 내용을 읽는다. 이미지 속 글자는 못 읽는다.
 *
 * 네이버 스마트에디터는 대부분의 태그·스타일을 지우므로 이 기능은 사실상 티스토리용이다.
 *
 * 모델이 만든 HTML 을 그대로 렌더하면 미리보기 화면에서 스크립트가 실제로 돈다.
 * 그래서 통과시킬 태그·속성을 화이트리스트로 못박고, 나머지는 전부 텍스트로 떨어뜨린다.
 */

/** 블로그 본문 보조에 필요한 최소한만. 폼·미디어·스크립트 계열은 전부 뺀다. */
const ALLOWED_TAGS = new Set([
  "div", "p", "span", "br", "hr",
  "h3", "h4",
  "table", "thead", "tbody", "tr", "th", "td",
  "ul", "ol", "li",
  "strong", "em", "b", "i", "small",
]);

/** 스스로 닫는 태그 — 스택에 쌓지 않는다 */
const VOID_TAGS = new Set(["br", "hr"]);

/**
 * 안쪽이 글이 아니라 코드인 태그. 태그만 버리고 내용을 남기면
 * `alert(1)` 같은 소스가 본문에 텍스트로 노출된다. 내용째 건너뛴다.
 */
const RAW_TEXT_TAGS = new Set([
  "script", "style", "noscript", "template", "textarea", "title", "iframe", "object",
]);

/** 레이아웃에 필요한 CSS 속성만. 위치 고정·동작 유발 속성은 뺀다. */
const ALLOWED_STYLE_PROPS = new Set([
  "color", "background", "background-color",
  "border", "border-top", "border-bottom", "border-left", "border-right",
  "border-radius", "border-collapse", "border-spacing",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
  "font-size", "font-weight", "font-style", "line-height",
  "text-align", "vertical-align", "text-decoration",
  "width", "min-width", "max-width", "height",
  "display", "flex", "flex-direction", "flex-wrap", "gap",
  "justify-content", "align-items",
  "list-style", "list-style-type", "white-space", "word-break", "opacity",
]);

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 스타일 값에서 실행 가능한 것을 걷어낸다.
 * `url(...)` 은 외부 요청을 만들고, `expression`/`javascript:` 는 구형 엔진에서 실행된다.
 */
function sanitizeStyle(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    if (!value) continue;
    if (/url\s*\(|expression\s*\(|javascript:|@import|[<>\\]/i.test(value)) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(";");
}

/** 표 병합만 허용. 나머지 속성(onclick, href, src …)은 전부 버린다. */
function sanitizeAttrs(tag: string, raw: string): string {
  const out: string[] = [];

  const style = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw);
  if (style) {
    const clean = sanitizeStyle(style[2] ?? style[3] ?? "");
    if (clean) out.push(`style="${escapeText(clean)}"`);
  }

  if (tag === "td" || tag === "th") {
    for (const name of ["colspan", "rowspan"]) {
      const m = new RegExp(`\\b${name}\\s*=\\s*("(\\d+)"|'(\\d+)'|(\\d+))`, "i").exec(raw);
      const v = m?.[2] ?? m?.[3] ?? m?.[4];
      // 말도 안 되게 큰 값은 표를 깨뜨리므로 상한을 둔다
      if (v && Number(v) >= 1 && Number(v) <= 100) out.push(`${name}="${Number(v)}"`);
    }
  }

  return out.length ? ` ${out.join(" ")}` : "";
}

/**
 * 화이트리스트 밖의 것은 태그로 인정하지 않고 텍스트로 이스케이프한다.
 * 열린 태그를 스택으로 추적해, 모델이 닫는 걸 빠뜨려도 끝에서 닫아준다.
 */
export function sanitizeVisualHtml(html: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  const token = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<!--[\s\S]*?-->|([^<]+)|(<)/g;

  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    const [full, tagName, attrs, text, strayLt] = m;

    if (text !== undefined) {
      out.push(text);
      continue;
    }
    if (strayLt !== undefined) {
      out.push("&lt;");
      continue;
    }
    if (tagName === undefined) continue; // 주석은 통째로 버린다

    const tag = tagName.toLowerCase();
    const closing = full.startsWith("</");

    if (RAW_TEXT_TAGS.has(tag)) {
      if (closing) continue;
      // 닫는 태그까지 통째로 건너뛴다. 못 찾으면 나머지를 전부 버린다
      const close = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(token.lastIndex);
      const found = close.exec(rest);
      token.lastIndex = found
        ? token.lastIndex + found.index + found[0].length
        : html.length;
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // 그 외 비허용 태그는 껍데기만 버리고 안쪽 글은 살린다
      continue;
    }

    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at < 0) continue; // 짝 없는 닫기 무시
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }

    if (VOID_TAGS.has(tag)) {
      out.push(`<${tag} />`);
      continue;
    }

    out.push(`<${tag}${sanitizeAttrs(tag, attrs ?? "")}>`);
    stack.push(tag);
  }

  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("").trim();
}

export type Visual = {
  /** 어떤 종류인지 — UI 배지와 모델 프롬프트 양쪽에서 쓴다 */
  type: string;
  title: string;
  html: string;
};

/** 모델 응답에서 시각 자료를 안전하게 뽑는다. 깨진 입력은 조용히 버린다. */
export function parseVisuals(raw: unknown): Visual[] {
  if (!Array.isArray(raw)) return [];
  const out: Visual[] = [];
  for (const v of raw) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const html = sanitizeVisualHtml(String(o.html ?? ""));
    if (!html) continue;
    out.push({
      type: String(o.type ?? "").trim() || "자료",
      title: String(o.title ?? "").trim(),
      html,
    });
  }
  return out;
}

/**
 * 본문 HTML 의 `{{visual:N}}` 자리를 실제 시각 자료로 바꾼다.
 *
 * 마크다운을 거치면 플레이스홀더가 `<p>{{visual:1}}</p>` 형태가 되므로 그 껍데기째 치환한다.
 * 쓰이지 않은 자료는 유실되지 않게 본문 끝에 덧붙인다.
 */
export function applyVisuals(bodyHtml: string, visuals: Visual[]): string {
  if (!visuals.length) return bodyHtml;

  const used = new Set<number>();
  const replaced = bodyHtml.replace(
    /(?:<p>\s*)?\{\{\s*visual\s*:\s*(\d+)\s*\}\}(?:\s*<\/p>)?/gi,
    (whole, n: string) => {
      const idx = Number(n) - 1;
      const v = visuals[idx];
      if (!v) return ""; // 없는 번호를 가리키면 자리만 지운다
      used.add(idx);
      return v.html;
    },
  );

  const leftover = visuals.filter((_, i) => !used.has(i));
  if (!leftover.length) return replaced;
  return [replaced, ...leftover.map((v) => v.html)].join("\n");
}
