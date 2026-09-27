/**
 * 이미지 프롬프트 문구. 서버(stock.ts)와 화면(시트 나누기) 양쪽이 쓰므로 서버 의존성 없이 둔다.
 */

export const STOCK_STYLES = {
  flat: "flat vector illustration, simple shapes, limited pastel palette",
  sticker: "cute sticker style illustration, thick dark outline, soft flat colors",
  clay: "3D clay render icon, soft studio lighting, matte material",
  // 수채화처럼 가장자리가 번지는 화풍은 흰 배경과 경계가 흐려 누끼가 지저분해진다. 외곽선 있는 것만 둔다
  doodle: "hand-drawn doodle illustration, bold marker outline, flat fill colors",
  line: "minimal line icon, uniform stroke, single accent color",
} as const;
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
  "No shadow, no ground, no gradient, no border frame. Leave generous white margin around the object. " +
  "Clean closed outline so the object separates clearly from the background. " +
  "No text, no letters, no numbers, no logos, no brand names, no watermarks, no real people or celebrities. " +
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
    "Vary the pose, angle, color and small details so that no two items are the same, but keep one consistent style and size. " +
    "Each item sits alone in the center of its own equal square cell with wide empty white gaps between items; " +
    "no item touches or crosses into a neighboring cell. " +
    "Solid pure white background (#FFFFFF) everywhere. No grid lines, no borders, no shadows, no ground. " +
    "No text, no letters, no numbers, no logos, no brand names, no watermarks, no real people. " +
    "Square image at the highest resolution available."
  );
}
