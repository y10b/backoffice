/**
 * 누끼 — 흰 배경 위 일러스트에서 배경을 걷어내고 요소별로 잘라낸다.
 *
 * AI 배경 제거 모델을 쓰지 않는다. 프롬프트에서 "단색 흰 배경, 그림자 없음, 닫힌 외곽선" 을
 * 강제하므로(stock.ts 의 CUTOUT_SUFFIX) 가장자리에서 배경색과 비슷한 픽셀만 따라 들어가는
 * 채우기(flood fill)로 충분하다. 의존성이 없고, 결과가 결정적이라 왜 그렇게 잘렸는지 설명된다.
 *
 * 가장자리에서만 들어가는 이유: 그림 **안쪽**의 흰색(눈 흰자, 반사광)은 배경과 이어져 있지
 * 않으니 남는다. 도넛 구멍처럼 안쪽에 갇힌 배경은 `holes` 로 따로 뚫는다.
 *
 * 브라우저 ImageData 와 모양이 같은 `Raster` 만 다룬다. 그래서 Node 에서도 테스트된다.
 */

export type Raster = { data: Uint8ClampedArray; width: number; height: number };
export type Box = { x: number; y: number; w: number; h: number };

export type CutoutOptions = {
  /** 이 거리(RGB 유클리드, 0~441) 안이면 배경이다 */
  tolerance?: number;
  /** tolerance 바깥으로 이만큼은 반투명으로 녹인다. 계단 현상을 없앤다 */
  softness?: number;
  /** 배경과 이어지지 않은 안쪽 배경(도넛 구멍)도 뚫을지 */
  holes?: boolean;
};

export type CutoutResult = {
  image: Raster;
  /** 추정한 배경색 */
  background: [number, number, number];
  /** 가장자리가 거의 한 색이었는지. 아니면 결과를 믿기 어렵다 */
  uniform: boolean;
  /** 이미 투명 배경이라 손대지 않았는지 */
  alreadyTransparent: boolean;
};

function borderIndices(w: number, h: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < w; x++) out.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) out.push(y * w, y * w + w - 1);
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function removeBackground(src: Raster, o: CutoutOptions = {}): CutoutResult {
  const tol = o.tolerance ?? 30;
  const soft = o.softness ?? 40;
  const { width: w, height: h } = src;
  const data = new Uint8ClampedArray(src.data);
  const border = borderIndices(w, h);

  // 이미 투명 배경(ChatGPT 가 투명 PNG 를 줬을 때)이면 배경 제거를 건너뛴다
  const transparentBorder = border.filter((i) => data[i * 4 + 3] < 250).length;
  if (transparentBorder > border.length * 0.5) {
    return { image: { data, width: w, height: h }, background: [255, 255, 255], uniform: true, alreadyTransparent: true };
  }

  const bg: [number, number, number] = [
    median(border.map((i) => data[i * 4])),
    median(border.map((i) => data[i * 4 + 1])),
    median(border.map((i) => data[i * 4 + 2])),
  ];
  const dist = (i: number) => {
    const p = i * 4;
    const dr = data[p] - bg[0];
    const dg = data[p + 1] - bg[1];
    const db = data[p + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const uniform = border.filter((i) => dist(i) <= tol).length >= border.length * 0.9;

  /*
   * 0 = 아직, 1 = 배경(완전 투명), 2 = 경계(반투명, 더 들어가지 않음).
   * 배경 픽셀에서만 이웃으로 번진다. 경계 픽셀은 알파만 받고 멈춘다 — 여기서 멈춰야
   * 외곽선 안쪽으로 파고들지 않는다.
   */
  const state = new Uint8Array(w * h);
  const alpha = new Float32Array(w * h).fill(1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const visit = (i: number) => {
    if (state[i]) return;
    const d = dist(i);
    if (d <= tol) {
      state[i] = 1;
      alpha[i] = 0;
      queue[tail++] = i;
    } else if (d < tol + soft) {
      state[i] = 2;
      alpha[i] = Math.min(alpha[i], (d - tol) / soft);
    }
  };

  for (const i of border) visit(i);
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if ((dx || dy) && nx >= 0 && nx < w) visit(ny * w + nx);
      }
    }
  }

  if (o.holes) punchHoles(w, h, state, alpha, dist, tol);

  for (let i = 0; i < w * h; i++) {
    const a = alpha[i];
    const p = i * 4;
    if (a >= 1) continue;
    if (a <= 0) {
      data[p + 3] = 0;
      continue;
    }
    /*
     * 반투명 픽셀은 배경색이 섞여 있다. 그대로 두면 어두운 배경에 얹었을 때 흰 테두리가
     * 뜬다(헤일로). 배경 성분을 빼서 원래 색을 되살린다: c = (관측 - (1-a)·배경) / a
     */
    for (let c = 0; c < 3; c++) {
      data[p + c] = Math.max(0, Math.min(255, (data[p + c] - (1 - a) * bg[c]) / a));
    }
    data[p + 3] = Math.round(a * data[p + 3]);
  }

  return { image: { data, width: w, height: h }, background: bg, uniform, alreadyTransparent: false };
}

/**
 * 배경과 이어지지 않은 배경색 덩어리 중 충분히 큰 것만 뚫는다.
 * 작은 것은 그림 안의 흰 점(눈 반사광 등)일 가능성이 높아 남긴다.
 */
function punchHoles(
  w: number,
  h: number,
  state: Uint8Array,
  alpha: Float32Array,
  dist: (i: number) => number,
  tol: number,
) {
  const minArea = Math.max(64, Math.round(w * h * 0.002));
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (state[start] || seen[start] || dist(start) > tol) continue;
    const comp: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const n of next) {
        if (n < 0 || seen[n] || state[n] || dist(n) > tol) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (comp.length >= minArea) for (const i of comp) alpha[i] = 0;
  }
}

/** 보이는 픽셀(알파 > 16)을 모두 감싸는 상자. 없으면 null */
export function opaqueBox(img: Raster): Box | null {
  const { data, width: w, height: h } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * 스티커 시트처럼 한 장에 여러 요소가 있으면 요소마다 따로 잘라 돌려준다.
 *
 * 보이는 픽셀을 이어진 덩어리로 묶고, `gap` 픽셀 안으로 가까운 덩어리는 한 요소로 합친다
 * (떨어져 그려진 눈·반짝이 같은 부속이 따로 잘리지 않게). 전체의 `minShare` 보다 작은
 * 덩어리는 부스러기로 보고 버린다.
 *
 * 상자로만 자르면 이웃 요소가 상자 안으로 삐져 들어온다. 그래서 그 요소에 속한 덩어리의
 * 픽셀만 옮겨 담는다.
 */
export function splitElements(img: Raster, gap: number, pad: number, minShare = 0.01): Raster[] {
  const { data, width: w, height: h } = img;
  const label = new Int32Array(w * h).fill(-1);
  type Group = Box & { area: number; ids: number[] };
  const groups: Group[] = [];
  const stack: number[] = [];
  let total = 0;

  for (let start = 0; start < w * h; start++) {
    if (label[start] >= 0 || data[start * 4 + 3] <= 16) continue;
    const id = groups.length;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      area++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (label[n] >= 0 || data[n * 4 + 3] <= 16) continue;
          label[n] = id;
          stack.push(n);
        }
      }
    }
    total += area;
    groups.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area, ids: [id] });
  }

  // 가까운 것끼리 합친다. 합치면 다른 것과 새로 가까워질 수 있어 변화가 없을 때까지 돈다
  const near = (a: Box, b: Box) =>
    a.x - gap <= b.x + b.w && b.x - gap <= a.x + a.w && a.y - gap <= b.y + b.h && b.y - gap <= a.y + a.h;
  let merged = groups;
  let changed = true;
  while (changed) {
    changed = false;
    const out: Group[] = [];
    for (const g of merged) {
      const hit = out.find((o) => near(o, g));
      if (!hit) {
        out.push({ ...g, ids: [...g.ids] });
        continue;
      }
      const x = Math.min(hit.x, g.x);
      const y = Math.min(hit.y, g.y);
      hit.w = Math.max(hit.x + hit.w, g.x + g.w) - x;
      hit.h = Math.max(hit.y + hit.h, g.y + g.h) - y;
      hit.x = x;
      hit.y = y;
      hit.area += g.area;
      hit.ids.push(...g.ids);
      changed = true;
    }
    merged = out;
  }

  return merged
    .filter((g) => g.area >= total * minShare)
    .sort((a, b) => (Math.abs(a.y - b.y) > gap * 2 ? a.y - b.y : a.x - b.x))
    .map((g) => {
      const mine = new Set(g.ids);
      const out = cropPadded(img, g, pad);
      // 상자 안에 들어온 남의 픽셀은 지운다
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          const l = label[(g.y + y) * w + g.x + x];
          if (l >= 0 && !mine.has(l)) out.data[((y + pad) * out.width + x + pad) * 4 + 3] = 0;
        }
      }
      return out;
    });
}

/** 상자만큼 잘라 둘레에 투명 여백 `pad` 를 두른 새 래스터 */
export function cropPadded(img: Raster, box: Box, pad: number): Raster {
  const w = box.w + pad * 2;
  const h = box.h + pad * 2;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < box.h; y++) {
    const from = ((box.y + y) * img.width + box.x) * 4;
    out.set(img.data.subarray(from, from + box.w * 4), ((y + pad) * w + pad) * 4);
  }
  return { data: out, width: w, height: h };
}

export type GridPiece = {
  image: Raster;
  /** 칸 번호(0부터, 왼쪽 위에서 가로로) */
  cell: number;
  /** 그림이 칸 가장자리에 닿았다 — 옆 칸으로 넘어가 잘렸을 수 있다 */
  touchesEdge: boolean;
  /** 칸 배경이 단색이 아니었다 */
  uniform: boolean;
};

/**
 * 격자 시트를 rows×cols 칸으로 나눠 칸마다 누끼를 딴다.
 *
 * 덩어리로 나누는(splitElements) 대신 칸으로 나누는 이유: 한 요소가 여러 조각(떨어진
 * 반짝이, 김)으로 그려지거나 이웃과 살짝 붙어도 칸 단위면 한 요소로 남는다. 이미지 모델은
 * 격자를 대체로 고르게 지키지만 완벽하진 않아서, 칸 가장자리에 닿은 요소는 표시해 둔다.
 * 빈 칸은 건너뛴다.
 */
export function splitGrid(img: Raster, rows: number, cols: number, pad: number, o: CutoutOptions = {}): GridPiece[] {
  const out: GridPiece[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round((c * img.width) / cols);
      const y0 = Math.round((r * img.height) / rows);
      const x1 = Math.round(((c + 1) * img.width) / cols);
      const y1 = Math.round(((r + 1) * img.height) / rows);
      const cell = cropPadded(img, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0);
      const cut = removeBackground(cell, o);
      const box = opaqueBox(cut.image);
      // 칸 넓이의 0.5% 도 안 되면 먼지다. 빈 칸으로 친다
      if (!box || box.w * box.h < cell.width * cell.height * 0.005) continue;
      out.push({
        image: cropPadded(cut.image, box, pad),
        cell: r * cols + c,
        touchesEdge: box.x === 0 || box.y === 0 || box.x + box.w >= cell.width || box.y + box.h >= cell.height,
        uniform: cut.uniform,
      });
    }
  }
  return out;
}

/**
 * 한 줄로 늘어선 투영값에서 "내용이 있는 구간" 을 찾는다.
 *
 * - `noise` 이하는 빈 줄로 본다 (안티앨리어싱 찌꺼기, 먼지)
 * - 빈 줄이 `minGap` 보다 짧으면 요소 안의 틈(떨어져 그린 반짝이, 김)이라 보고 잇는다
 * - 다른 구간의 중앙값의 1/4 도 안 되는 가는 구간은 이웃에 붙인다
 */
function bands(profile: Int32Array | number[], noise: number, minGap: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= profile.length; i++) {
    const on = i < profile.length && profile[i] > noise;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const last = out[out.length - 1];
      if (last && start - last[1] < minGap) last[1] = i;
      else out.push([start, i]);
      start = -1;
    }
  }
  if (out.length < 2) return out;

  const sizes = out.map(([a, b]) => b - a).sort((x, y) => x - y);
  const med = sizes[Math.floor(sizes.length / 2)];
  const merged: [number, number][] = [];
  for (const b of out) {
    if (b[1] - b[0] >= med / 4) {
      merged.push([...b]);
      continue;
    }
    // 가는 구간 — 더 가까운 이웃에 붙인다. 앞에 있는 게 없으면 뒤에 붙도록 남겨 둔다
    const prev = merged[merged.length - 1];
    if (prev) prev[1] = b[1];
    else merged.push([...b]);
  }
  // 맨 앞이 가는 구간으로 남았으면 다음 구간과 합친다
  if (merged.length > 1 && merged[0][1] - merged[0][0] < med / 4) {
    merged[1][0] = merged[0][0];
    merged.shift();
  }
  return merged;
}

export type GutterPiece = {
  image: Raster;
  /** 몇 번째 행, 몇 번째 열에서 나왔는지 (0부터) */
  row: number;
  col: number;
};

/**
 * 빈 줄(여백)을 찾아 격자를 스스로 알아낸다. 칸 수를 몰라도 되고, 칸이 고르지 않아도 된다.
 *
 * 배경을 걷어낸 이미지에서 가로줄마다 보이는 픽셀 수를 세면, 요소 행 사이의 여백은 0 이
 * 된다 — 그 사이가 행 경계다. 행마다 같은 방법을 세로로 한 번 더 하면 열 경계가 나온다.
 * 행마다 열을 따로 찾으므로 줄마다 요소 개수나 위치가 달라도 맞게 잘린다.
 *
 * 빈 줄이 하나도 없으면(요소끼리 붙어 있으면) 그 행은 통째로 한 조각이 된다. 그때는
 * 균등 격자나 덩어리 나누기를 쓴다.
 */
export function splitByGutters(img: Raster, pad: number): GutterPiece[] {
  const { data, width: w, height: h } = img;
  const on = (x: number, y: number) => data[(y * w + x) * 4 + 3] > 16;
  // 이미지 긴 변의 1% 보다 좁은 틈은 요소 안의 틈으로 본다
  const minGap = Math.max(3, Math.round(Math.max(w, h) * 0.01));

  const rowProfile = new Int32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) rowProfile[y]++;
  const rows = bands(rowProfile, Math.max(1, Math.round(w * 0.002)), minGap);

  const out: GutterPiece[] = [];
  rows.forEach(([y0, y1], ri) => {
    const colProfile = new Int32Array(w);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (on(x, y)) colProfile[x]++;
    const cols = bands(colProfile, Math.max(1, Math.round((y1 - y0) * 0.002)), minGap);

    cols.forEach(([x0, x1], ci) => {
      const cell = cropPadded(img, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0);
      const box = opaqueBox(cell);
      if (!box) return;
      out.push({ image: cropPadded(cell, box, pad), row: ri, col: ci });
    });
  });
  return out;
}
