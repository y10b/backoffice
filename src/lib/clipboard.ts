"use client";

/** 일반 텍스트 복사 */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * HTML 을 서식 있는 형태로 복사한다.
 * 스마트에디터 ONE 처럼 HTML 모드가 없는 편집기에 붙여넣을 때 소제목·굵게가 살아남는다.
 * ClipboardItem 미지원 브라우저에서는 평문 HTML 복사로 떨어진다.
 */
export async function copyRichHtml(html: string): Promise<"rich" | "plain"> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([htmlToPlain(html)], { type: "text/plain" }),
        }),
      ]);
      return "rich";
    } catch {
      /* 권한/포맷 문제면 평문으로 폴백 */
    }
  }
  await navigator.clipboard.writeText(html);
  return "plain";
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|li|blockquote|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
