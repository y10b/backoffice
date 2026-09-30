/**
 * 이미지 프롬프트 문구. 서버(stock.ts)와 화면(시트 나누기) 양쪽이 쓰므로 서버 의존성 없이 둔다.
 */

/**
 * 스타일 문구. 2026-10 조사(미리캔버스 기여자 후기, Adobe·Canva 2026 트렌드)에서 잘 팔리고
 * 누끼가 깔끔한 쪽으로 다듬었다. 수채화처럼 가장자리가 번지는 화풍은 흰 배경과 경계가 흐려
 * 누끼가 지저분해져 넣지 않는다.
 */
export const STOCK_STYLES = {
  flat: "flat vector illustration style, solid color fills, no gradients, no texture, crisp simple shapes, at most one flat shadow tone per color",
  // 흰 테두리 스티커는 흰 배경에서 누끼로 같이 사라진다. 테두리 바깥에 옅은 회색 윤곽선을 두른다
  sticker: "kawaii sticker style, thick uniform off-white die-cut border with a thin light-gray outline around it, rounded chunky shapes, soft pastel palette, simple dot eyes",
  clay: "soft 3D clay render, matte plasticine texture, rounded chunky forms, soft even studio lighting from the top left, no environment",
  // 2026 트렌드 "Imperfect by Design" — 손맛 있는 불완전함
  doodle: "hand-drawn doodle style, slightly uneven marker lines of consistent weight, subtle paper-grain feel on the object only, imperfect charming shapes",
  line: "minimal line icon style, uniform stroke weight, rounded caps and joins, single color with at most one flat accent fill",
} as const;

/**
 * 모든 이미지 프롬프트에 붙는 품질 규칙.
 *
 * - 흰색 함정: 누끼는 흰 배경을 지운다. 요소 안의 흰 부분(눈 흰자, 구름, 눈사람)까지 지워지지
 *   않게 요소 안의 흰색은 크림색으로 칠하게 한다. 미리캔버스도 에디터 배경과 같은 #FFFFFF 를
 *   요소에 쓰지 말라고 안내한다.
 * - 반려 사유(기여자 후기): 너무 단순함, 잘린 요소, 여백 과다, 색만 바꾼 중복, AI 흔적(손가락·왜곡)
 * - 세트 일관성: 같은 시점·광원·크기감·팔레트여야 컬렉션으로 팔린다
 */
export const STOCK_QUALITY =
  "Each object is fully inside its space with nothing cropped, filling about 75% of it with an even margin. " +
  "No cast shadows, no reflections, no floor. " +
  "Do not use pure white inside the objects; paint any white parts off-white or cream (#F7F3EC) so they survive background removal. " +
  "Every object has a clear closed outer contour. " +
  "Same 3/4 front viewing angle, same top-left light, same scale and visual weight for every object; one cohesive palette of about 5 colors. " +
  "Simple readable silhouettes that stay clear at thumbnail size; avoid tiny details and hairline strokes. " +
  "No hands or fingers shown up close (characters have simple mitten-like hands). " +
  "Commercial stock quality: clean edges, no artifacts, no distortion.";
export type StockStyle = keyof typeof STOCK_STYLES;

/**
 * 누끼를 로직으로 따려면 배경이 "단색 흰색" 이어야 한다. 모델이 그림자·바닥·그라데이션을
 * 넣으면 가장자리에서 배경을 걷어내는 방식이 깨진다. 그래서 모든 프롬프트 끝에 붙인다.
 *
 * 글자를 막는 이유: 이미지 모델이 쓰는 한글은 자주 깨지고, 미리캔버스는 글자를 템플릿에서
 * 따로 얹으므로 글자 없는 요소가 더 잘 쓰인다.
 */
export const CUTOUT_SUFFIX =
  "Isolated single object centered on a solid pure white background (#FFFFFF). " +
  "No shadow, no ground, no gradient, no border frame. " +
  STOCK_QUALITY +
  " No text, no letters, no numbers, no logos, no brand names, no watermarks, no QR codes, no real people or celebrities. " +
  "Square image.";

/**
 * 한 아이템을 여러 변형으로 한 장에 그리는 시트 프롬프트.
 *
 * 칸 단위로 자르므로(cutout.ts splitGrid) 모델이 격자를 지켜야 한다. "칸마다 하나, 칸을
 * 넘지 않게, 넓은 흰 간격" 을 거듭 적는다. 격자선을 그리면 선이 요소로 잘려 나오니 막는다.
 */
export function sheetPrompt(o: { item: string; rows: number; cols: number; style: StockStyle }): string {
  const n = o.rows * o.cols;
  return (
    `A sticker sheet of ${n} different variations of ${o.item}, arranged in a ${o.rows} by ${o.cols} grid. ` +
    `${STOCK_STYLES[o.style]}. ` +
    // 색만 바꾼 변형은 미리캔버스·Adobe 모두 스팸으로 반려한다. 포즈·동작·소품·표정·상황으로 바꾼다
    "Each variation must be clearly different in pose, action, prop, expression or situation — never just a color change, flip or rotation — " +
    "while keeping the same design, proportions, palette and size. " +
    "Each item sits alone in the center of its own equal square cell with wide empty white gaps between items; " +
    "no item touches or crosses into a neighboring cell. " +
    "Solid pure white background (#FFFFFF) everywhere. No grid lines, no borders, no shadows, no ground. " +
    STOCK_QUALITY +
    " " +
    "No text, no letters, no numbers, no logos, no brand names, no watermarks, no real people. " +
    "Square image at the highest resolution available."
  );
}

/* ------------------------------------------------------------------ *
 * 한 장 격자 — 서로 다른 아이템 N개를 프롬프트 하나로
 * ------------------------------------------------------------------ */

/**
 * 개수별 격자 모양(행×열). 이미지 모델이 가장 크게 주는 캔버스가 1536×1024(가로) ·
 * 1024×1536(세로) · 1024×1024 라서, 칸이 정사각에 가깝고 가장 크게 나오는 모양을 고른다.
 * 열이 행보다 많으면 가로형 캔버스를 쓴다.
 */
const GRID_TABLE: Record<number, [rows: number, cols: number]> = {
  3: [1, 3],
  4: [2, 2],
  6: [2, 3],
  8: [2, 4],
  9: [3, 3],
  10: [2, 5],
  12: [3, 4],
  16: [4, 4],
};
/** 화면의 개수 선택지 — bestGrid 가 표로 아는 값만 */
export const GRID_COUNTS = Object.keys(GRID_TABLE).map(Number);

export type GridCanvas = { w: number; h: number; orientation: "landscape" | "portrait" | "square" };

/**
 * n 개를 담을 격자. 표에 없는 개수(모델이 7개만 돌려준 경우 등)는 정사각에 가깝게
 * 열을 먼저 늘리고, 남는 칸은 비운다.
 */
export function bestGrid(n: number): { rows: number; cols: number } {
  const hit = GRID_TABLE[n];
  if (hit) return { rows: hit[0], cols: hit[1] };
  const k = Math.max(1, Math.round(n));
  const cols = Math.ceil(Math.sqrt(k));
  return { rows: Math.ceil(k / cols), cols };
}

/** 격자 모양에 맞는 가장 큰 캔버스 */
export function gridCanvas(rows: number, cols: number): GridCanvas {
  if (cols > rows) return { w: 1536, h: 1024, orientation: "landscape" };
  if (rows > cols) return { w: 1024, h: 1536, orientation: "portrait" };
  return { w: 1024, h: 1024, orientation: "square" };
}

/** 칸 한 개의 예상 픽셀 (캔버스 ÷ 격자). 실제로는 간격이 있어 그림은 이보다 조금 작다 */
export function cellSize(rows: number, cols: number, canvas = gridCanvas(rows, cols)): { w: number; h: number } {
  return { w: Math.floor(canvas.w / cols), h: Math.floor(canvas.h / rows) };
}

/**
 * 개별 프롬프트에서 아이템 묘사만 꺼낸다 — 스타일 문구와 누끼용 꼬리 문장을 떼어낸다.
 * 격자 프롬프트는 스타일·배경을 한 번만 말하므로, 아이템마다 반복되면 목록이 길고 흐려진다.
 * 모델이 꼬리 문장을 제 말로 바꿔 썼으면 "#FFFFFF" 가 든 문장부터 잘라낸다.
 */
export function itemDescription(prompt: string, style?: StockStyle): string {
  let s = prompt.replace(CUTOUT_SUFFIX, " ");
  const hex = s.indexOf("#FFFFFF");
  if (hex >= 0) {
    const start = Math.max(s.lastIndexOf(". ", hex), -1);
    s = s.slice(0, start + 1);
  }
  if (style) {
    const phrase = STOCK_STYLES[style].toLowerCase();
    const at = s.toLowerCase().indexOf(phrase);
    if (at >= 0) s = s.slice(0, at) + s.slice(at + phrase.length);
  }
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,;])\s*([,.;])/g, "$2")
    .replace(/^[\s,.;]+|[\s,.;]+$/g, "")
    .trim();
}

/**
 * 서로 다른 아이템 N개를 한 장의 격자로 그리는 프롬프트.
 *
 * 문구 원칙은 sheetPrompt 와 같다(칸마다 하나, 칸을 넘지 않게, 넓은 흰 간격, 격자선 금지).
 * 여기에 순서를 못 박는다 — 칸 위치가 곧 파일 이름(아이템)이라 순서가 틀리면 이름이 뒤바뀐다.
 * 캔버스는 가장 큰 것을 요청한다. 칸이 작을수록 업스케일 부담이 커진다.
 */
export function gridSheetPrompt(o: {
  items: string[];
  style: StockStyle;
  rows: number;
  cols: number;
  size?: GridCanvas;
}): string {
  const n = o.items.length;
  const cells = o.rows * o.cols;
  const size = o.size ?? gridCanvas(o.rows, o.cols);
  const list = o.items.map((it, i) => `${i + 1}. ${it}`).join("\n");
  const empty = cells - n;
  return (
    `A single sheet of ${n} different illustrations arranged in a grid of ${o.rows} rows by ${o.cols} columns, ` +
    `placed in this exact order, row by row, starting at the top left and reading left to right:\n` +
    `${list}\n\n` +
    `${STOCK_STYLES[o.style]}. All ${n} items share one consistent art style, line weight and color palette, ` +
    "and are drawn at the same size. " +
    "Exactly one item per cell: each item sits alone in the center of its own equal cell, " +
    "with wide empty white gutters between cells; no item touches or crosses into a neighboring cell. " +
    (empty > 0 ? `Leave the last ${empty} cell${empty > 1 ? "s" : ""} completely empty. ` : "") +
    "Solid pure white background (#FFFFFF) everywhere. " +
    STOCK_QUALITY +
    " " +
    "No grid lines, no borders, no frames, no cell numbers, no captions, no shadows, no ground. " +
    "No text, no letters, no numbers, no logos, no brand names, no watermarks, no real people. " +
    `${size.w}x${size.h} ${size.orientation} image at the highest resolution, crisp clean edges, no blur.`
  );
}
