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
  /*
   * 터치 기기(아이폰)는 선택 복사를 먼저 쓴다.
   *
   * 사파리의 ClipboardItem 은 text/html 만 넣는데, 네이버 앱은 그 형식을 못 읽고 평문만
   * 가져간다(PC 는 됨). 화면에 실제 선택을 만들고 execCommand("copy") 로 복사하면 iOS 가
   * 서식 있는 텍스트(RTF 포함)로 넣어 줘서 앱에도 굵게·크기가 살아난다.
   */
  if (isTouch() && copyBySelection(html)) return "rich";
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
  // 서식 복사가 안 되면 HTML 소스가 아니라 읽을 수 있는 글로 넣는다. 태그가 섞인 채
  // 붙여넣으면 그걸 지우는 게 더 일이다
  await navigator.clipboard.writeText(htmlToPlain(html));
  return "plain";
}

/**
 * 네이버 에디터에 붙여넣기 좋은 형태로 바꾼다.
 *
 * 스마트에디터는 `<h2>` 같은 제목 태그를 자주 버린다(특히 앱). 대신 굵게와 글자 크기는
 * 살린다. 그래서 소제목을 "굵고 큰 문단"으로, 굵게는 `<b>` 로 바꾸고, 문단 사이에 빈 줄을
 * 둔다. 사진 자리(`[사진 N]`)는 한 줄로 두어 나중에 사진으로 갈아끼우기 쉽게 한다.
 */
export function toNaverHtml(html: string, title?: string): string {
  let out = html
    .replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, '<p><b><span style="font-size:19px">$1</span></b></p><p><br></p>')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "<p><b>$1</b></p>")
    .replace(/<strong>/gi, "<b>")
    .replace(/<\/strong>/gi, "</b>")
    .replace(/<em>/gi, "<i>")
    .replace(/<\/em>/gi, "</i>")
    // 문단 사이 빈 줄. 네이버는 <p> 간격이 없어 붙여 보인다
    .replace(/<\/p>\s*<p>/gi, "</p><p><br></p><p>")
    // 위 규칙들이 겹치면 빈 줄이 여러 개 쌓인다. 하나만 남긴다
    .replace(/(<p><br><\/p>){2,}/gi, "<p><br></p>");
  if (title) out = `<p><b><span style="font-size:24px">${title}</span></b></p><p><br></p>${out}`;
  return out;
}

/** 네이버용으로 변환해 서식 복사한다 */
export async function copyForNaver(html: string, title?: string): Promise<"rich" | "plain"> {
  return copyRichHtml(toNaverHtml(html, title));
}

function isTouch(): boolean {
  return typeof window !== "undefined" && ("ontouchend" in window || navigator.maxTouchPoints > 0);
}

/**
 * 보이지 않는 편집 영역에 HTML 을 넣고 선택한 뒤 복사 명령을 내린다.
 * 사용자 제스처 안에서만 되므로 버튼 onClick 에서 동기적으로 불러야 한다.
 */
export function copyBySelection(html: string): boolean {
  try {
    const host = document.createElement("div");
    host.contentEditable = "true";
    host.setAttribute("aria-hidden", "true");
    // 화면 밖으로 빼되 display:none 은 안 된다 — 선택이 안 잡힌다
    host.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;overflow:hidden;";
    host.innerHTML = html;
    document.body.appendChild(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const ok = document.execCommand("copy");
    sel?.removeAllRanges();
    host.remove();
    return ok;
  } catch {
    return false;
  }
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
