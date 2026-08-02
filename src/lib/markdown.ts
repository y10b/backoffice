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

/** `| a | b |` 를 셀 배열로. 양끝 파이프는 있어도 없어도 받는다. */
function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * `|---|:--:|---:|` 구분줄인지. 정렬 표기(`:`)도 허용한다.
 * 대시 1개짜리(`:-:`)도 유효한 표기라 개수를 제한하지 않는다.
 */
function isTableDivider(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** 구분줄의 콜론 위치에서 정렬을 읽는다. 없으면 null. */
function alignOf(cell: string): "left" | "center" | "right" | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
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

  // 표는 다음 줄이 구분줄인지 봐야 판별되므로 인덱스로 돈다
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      closeList();
      closeQuote();
      continue;
    }

    /*
     * 파이프 표. 프롬프트가 본문에 표를 최소 1개 요구하는데 변환기가 모르면
     * `| a | b |` 가 그대로 문단에 뭉개져 나간다.
     * 헤더줄 + 구분줄 조합일 때만 표로 본다.
     */
    if (trimmed.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushParagraph();
      closeList();
      closeQuote();

      const headers = splitRow(trimmed);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      const attr = (col: number) => {
        const a = aligns[col];
        return a ? ` style="text-align:${a}"` : "";
      };

      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().includes("|") && lines[j].trim()) {
        rows.push(splitRow(lines[j].trim()));
        j++;
      }

      out.push("<table>");
      out.push("<thead><tr>");
      headers.forEach((h, c) => out.push(`<th${attr(c)}>${inline(h)}</th>`));
      out.push("</tr></thead>");
      if (rows.length) {
        out.push("<tbody>");
        for (const row of rows) {
          out.push("<tr>");
          // 헤더보다 셀이 모자라거나 넘쳐도 헤더 수에 맞춰 표를 깨지지 않게 한다
          for (let c = 0; c < headers.length; c++) {
            out.push(`<td${attr(c)}>${inline(row[c] ?? "")}</td>`);
          }
          out.push("</tr>");
        }
        out.push("</tbody>");
      }
      out.push("</table>");

      i = j - 1;
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

/** FAQ 한 쌍. 본문 하단 섹션과 FAQPage 구조화 데이터에 같은 값을 쓴다. */
export type FaqItem = { question: string; answer: string };

/**
 * 외부(Gemini 응답)에서 넘어온 값이라 배열이 아니거나 항목이 깨져 있을 수 있다.
 * 질문·답변이 모두 있는 항목만 남겨 이후 단계가 방어 코드를 반복하지 않게 한다.
 */
export function normalizeFaq(input: unknown): FaqItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => ({
      question: String((item as any)?.question ?? "").trim(),
      answer: String((item as any)?.answer ?? "").trim(),
    }))
    .filter((item) => item.question && item.answer);
}

/**
 * 본문에 FAQ 섹션이 이미 있는지.
 * 모델이 "자주 묻는 질문 (FAQ)" 처럼 꼬리표를 붙이는 경우가 있어 헤딩 앞부분만 본다.
 * 마크다운(`## …`)과 변환된 HTML(`<h2>…`) 양쪽을 받을 수 있게 두 형태를 모두 검사한다.
 */
export function hasFaqHeading(body: string): boolean {
  return (
    /(^|\n)\s*#{1,6}\s*[^\n]*자주\s*묻는\s*질문/.test(body) ||
    /<h[1-6][^>]*>\s*[^<]*자주\s*묻는\s*질문/.test(body)
  );
}

/**
 * 본문 HTML 끝에 FAQ 섹션을 덧붙인다.
 * 모델이 이미 본문 마크다운에 FAQ 를 넣은 경우가 흔해서, 중복 노출(구글이 싫어하는 반복 콘텐츠)을
 * 막기 위해 기존 헤딩이 없을 때만 붙인다.
 */
export function appendFaqHtml(bodyHtml: string, faq: unknown): string {
  const items = normalizeFaq(faq);
  if (!items.length || hasFaqHeading(bodyHtml)) return bodyHtml;

  // 본문 헤딩이 h2 로 시작하므로 FAQ 도 h2, 개별 질문은 h3 로 둬야 계층이 끊기지 않는다.
  const blocks = ["<h2>자주 묻는 질문</h2>"];
  for (const item of items) {
    blocks.push(`<h3>${inline(item.question)}</h3>`);
    blocks.push(`<p>${inline(item.answer)}</p>`);
  }
  const section = blocks.join("\n");
  return bodyHtml.trim() ? `${bodyHtml}\n${section}` : section;
}

export type JsonLdInput = {
  title: string;
  metaDescription: string;
  faq?: unknown;
  tags?: string[];
  /** 발행 URL. 아직 발행 전이면 비워둔다 */
  url?: string;
  author?: string;
  /** ISO 8601 문자열. 실제 발행 시각을 아는 호출부만 넘긴다 */
  datePublished?: string;
};

/**
 * JSON 문자열을 <script> 안에 그대로 넣으면 값 안의 "</script>" 가 스크립트를 닫아버린다.
 * JSON 스펙상 \uXXXX 는 원래 문자로 파싱되므로, 태그를 만들 수 있는 < > & 를 모두 이스케이프해도
 * 구조화 데이터의 의미는 그대로다. U+2028/2029 는 일부 자바스크립트 파서가 줄바꿈으로 보므로 함께 처리한다.
 */
function escapeJsonLd(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Article + FAQPage 구조화 데이터를 <script type="application/ld+json"> 통째로 만든다.
 * 티스토리 HTML 모드에 본문과 함께 붙여넣는 용도라 태그까지 포함한 문자열로 돌려준다.
 */
export function buildJsonLd(input: JsonLdInput): string {
  const title = input.title.trim();
  const faq = normalizeFaq(input.faq);

  const article: Record<string, unknown> = {
    "@type": "Article",
    // 구글은 headline 을 110자까지만 읽으므로 넘치면 잘라서 무시되는 일을 막는다.
    headline: title.slice(0, 110),
    description: input.metaDescription.trim(),
    inLanguage: "ko-KR",
  };
  if (input.tags?.length) article.keywords = input.tags.join(", ");
  if (input.author?.trim()) {
    article.author = { "@type": "Person", name: input.author.trim() };
  }
  if (input.datePublished?.trim()) article.datePublished = input.datePublished.trim();
  if (input.url?.trim()) {
    article.mainEntityOfPage = { "@type": "WebPage", "@id": input.url.trim() };
  }

  // Article 과 FAQPage 는 같은 페이지의 서로 다른 엔티티라 @graph 로 한 블록에 담는다.
  const graph: Record<string, unknown>[] = [article];
  if (faq.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    });
  }

  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2);
  return `<script type="application/ld+json">\n${escapeJsonLd(json)}\n</script>`;
}
