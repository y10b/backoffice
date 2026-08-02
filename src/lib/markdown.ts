/**
 * 블로그 본문에 필요한 범위만 다루는 마크다운 → HTML 변환기.
 * 스마트에디터 ONE / 티스토리 HTML 모드에 붙여넣기 좋게 단순한 태그만 낸다.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 인라인 서식. 이스케이프 후에 적용하므로 사용자 입력이 태그로 새지 않는다. */
function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  return out;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let paragraph: string[] = [];
  let inQuote = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push("</blockquote>");
      inQuote = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      closeList();
      closeQuote();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      closeQuote();
      // 글 제목이 h1 이므로 본문 헤딩은 h2 부터 시작한다.
      // h1 을 h2 로 끌어올리되(h1 중복 방지) h2 이하는 그대로 둬서 h1→h3 건너뜀을 막는다.
      const level = Math.min(Math.max(heading[1].length, 2), 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      closeList();
      closeQuote();
      out.push("<hr />");
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      closeList();
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(`<p>${inline(quote[1])}</p>`);
      continue;
    }
    closeQuote();

    const ul = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ol) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  closeQuote();
  return out.join("\n");
}

/** HTML 에서 대략적인 본문 글자 수(공백 제외)를 센다 */
export function countChars(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, "").length;
}
