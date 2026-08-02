/**
 * 시각 자료 HTML 을 PNG 로 굽는다. 브라우저에서만 돈다.
 *
 * 왜 필요한가: 시각 자료는 인라인 스타일 HTML 이라 티스토리 HTML 모드에는 그대로
 * 붙지만, 네이버 스마트에디터는 태그와 스타일을 대부분 지운다. 네이버에 올리려면
 * 결국 그림이어야 한다.
 *
 * 왜 서버가 아니라 브라우저인가: 서버에서 HTML 을 그리려면 헤드리스 크롬이 필요하고,
 * 그건 Vercel 서버리스에서 못 돈다(ffmpeg 와 같은 이유). 반면 브라우저에는 이미
 * 렌더 엔진이 있다. SVG 의 foreignObject 안에 HTML 을 넣으면 그 엔진이 그려주고,
 * 그 SVG 를 canvas 에 올리면 PNG 가 나온다. 의존성이 하나도 안 붙는다.
 *
 * 제약: foreignObject 안은 XML 로 해석되므로 HTML 이 well-formed 여야 한다.
 * 시각 자료는 sanitizeVisualHtml 을 거쳐 태그가 짝이 맞고 void 태그도 `<br />`
 * 형태라 그대로 통과한다. 손으로 쓴 HTML 을 넣으면 깨질 수 있다.
 */

export type RenderOptions = {
  /** 그림의 가로 픽셀. 블로그 본문 폭에 맞춰 잡는다 */
  width?: number;
  /**
   * 확대 배율. 1 로 구우면 고해상도 화면에서 흐리게 보인다.
   * 2 면 글자가 또렷하고 용량도 감당할 만하다.
   */
  scale?: number;
  /** 배경색. 투명하게 두면 블로그의 어두운 테마에서 글자가 안 보인다 */
  background?: string;
  /** 안쪽 여백. 0 이면 글자가 가장자리에 붙어 답답하다 */
  padding?: number;
};

/**
 * 본문에 쓰는 글꼴을 그대로 지정한다.
 *
 * foreignObject 는 문서의 CSS 를 물려받지 않아서, 지정하지 않으면 Times 계열
 * 기본 글꼴로 그려진다. 한글이 특히 흉해진다. 시스템에 있는 것만 나열한다 —
 * 웹폰트는 외부 요청이라 canvas 에 올릴 때 막힌다.
 */
const FONT_STACK =
  "'Pretendard','Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR',sans-serif";

/**
 * 실제 렌더 크기를 재려면 한 번 화면에 올려봐야 한다.
 * 눈에 띄지 않게 화면 밖에 두고 높이만 재서 걷어낸다.
 */
function measure(html: string, width: number, padding: number): { node: HTMLElement; height: number } {
  const holder = document.createElement("div");
  holder.style.cssText = [
    "position:fixed",
    "left:-99999px",
    "top:0",
    `width:${width}px`,
    `padding:${padding}px`,
    "box-sizing:border-box",
    `font-family:${FONT_STACK}`,
    "font-size:16px",
    "line-height:1.6",
    "color:#111",
  ].join(";");
  holder.innerHTML = html;
  document.body.appendChild(holder);
  // getBoundingClientRect 는 소수점을 준다. 올림해야 마지막 줄이 잘리지 않는다
  const height = Math.ceil(holder.getBoundingClientRect().height);
  return { node: holder, height };
}

export async function htmlToPngBlob(html: string, o: RenderOptions = {}): Promise<Blob> {
  const width = o.width ?? 800;
  const scale = o.scale ?? 2;
  const padding = o.padding ?? 24;
  const background = o.background ?? "#ffffff";

  const { node, height } = measure(html, width, padding);

  let serialized: string;
  try {
    /*
     * 재는 동안 화면 밖에 두려고 넣은 위치 지정을 걷어낸다. 이게 남은 채로 직렬화하면
     * SVG 안에서도 -99999px 로 밀려나 그림이 통째로 하얗게 나온다.
     */
    node.style.position = "static";
    node.style.left = "auto";
    node.style.top = "auto";

    /*
     * innerHTML 이 아니라 XMLSerializer 를 쓴다. innerHTML 은 `<br>` 처럼 닫히지 않은
     * 태그를 그대로 내보내는데, foreignObject 안은 XML 이라 그 상태로는 파싱이 실패하고
     * 그림이 통째로 빈다. XMLSerializer 는 `<br />` 로 닫아주고, 바깥 요소에
     * xhtml 네임스페이스도 알아서 붙여준다 — 손으로 또 붙이면 속성이 중복돼
     * 역시 파싱이 깨진다.
     */
    serialized = new XMLSerializer().serializeToString(node);
  } finally {
    node.remove();
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    serialized +
    `</foreignObject></svg>`;

  const img = new Image();
  // data URL 로 넘긴다. blob URL 은 브라우저에 따라 canvas 를 오염된 것으로 본다
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () =>
      reject(new Error("시각 자료를 그림으로 그리지 못했습니다. HTML 구조를 확인하세요."));
  });

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 를 만들지 못했습니다.");

  // 투명 배경으로 두면 블로그 테마에 따라 글자가 안 보인다
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG 로 변환하지 못했습니다."))),
      "image/png",
    );
  });
}

/** 파일 이름에 못 쓰는 글자를 걷어낸다. 제목을 그대로 쓰면 저장이 실패한다 */
export function safeFileName(name: string, fallback = "visual"): string {
  const clean = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || fallback;
}

export async function downloadHtmlAsPng(
  html: string,
  fileName: string,
  o?: RenderOptions,
): Promise<void> {
  const blob = await htmlToPngBlob(html, o);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(fileName)}.png`;
  a.click();
  // 즉시 지우면 다운로드가 시작되기 전에 사라지는 브라우저가 있다
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
