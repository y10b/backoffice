import type { Raster } from "./cutout";

/**
 * 업스케일 — 누끼 딴 작은 조각을 판매·편집에 쓸 크기로 키운다. 브라우저 캔버스만 쓴다.
 *
 * 한 번에 크게 키우면(384 → 2048) 브라우저 보간이 계단·뭉개짐을 남긴다. 그래서
 *
 *   1. 투명 픽셀의 색을 이웃 불투명 색으로 채운다 (color bleed)
 *   2. 색(RGB)과 알파를 **따로** 2배씩 단계적으로 키운다 (imageSmoothingQuality = "high")
 *   3. 약한 언샤프 마스크(반경 1)로 경계를 다시 세운다
 *
 * 1·2 를 하는 이유: 누끼 PNG 의 투명 픽셀은 RGB 가 흰색(원래 배경)으로 남아 있다. 그대로
 * 키우면 보간이 가장자리에서 그 흰색을 섞어 테두리에 흰 띠(헤일로)가 번진다. 캔버스는 내부에서
 * 알파를 곱해(premultiplied) 저장하므로 투명 픽셀에 색을 써 넣어도 사라진다 — 그래서 색은
 * 불투명한 캔버스로, 알파는 회색조 캔버스로 따로 키워 마지막에 합친다.
 *
 * 잘 버티는 화풍: 플랫·라인·스티커·손그림은 면이 넓고 경계가 단순해 2~5배도 깔끔하다.
 * 한계: 보간은 **있는 픽셀을 늘릴 뿐 디테일을 새로 만들지 않는다.** 3D 클레이나 사진풍의
 * 질감·잔털은 키우면 부드럽게 뭉개진다. 그런 건 원본을 크게 뽑는 게 답이다.
 *
 * 순수 함수(upscalePlan, colorBleed, unsharpMask)는 Node 에서도 돈다. DOM 은
 * upscaleRaster 안에서만 쓴다.
 */

/** 화면 선택지 (긴 변 px). 0 은 키우지 않음 */
export const UPSCALE_TARGETS = [0, 1024, 2048, 4096] as const;
export const DEFAULT_UPSCALE = 2048;

/**
 * 긴 변이 target 에 닿을 때까지 2배씩 키우는 단계. 마지막 단계는 target 에 딱 맞춘다.
 * 이미 target 이상이면 빈 배열(키우지 않는다 — 줄이는 건 이 모듈의 일이 아니다).
 *
 *   384×300 → 2048: 768×600, 1536×1200, 2048×1600
 */
export function upscalePlan(w: number, h: number, target: number): { w: number; h: number }[] {
  const long = Math.max(w, h);
  if (!target || long <= 0 || long >= target) return [];
  const longs: number[] = [];
  for (let s = long * 2; s < target; s *= 2) longs.push(s);
  longs.push(target);
  return longs.map((L) => ({ w: Math.max(1, Math.round((w * L) / long)), h: Math.max(1, Math.round((h * L) / long)) }));
}

/**
 * 투명 픽셀(알파 0)의 RGB 를 이웃 불투명 픽셀의 평균색으로 채운다. 한 번에 한 겹씩
 * `passes` 겹까지 바깥으로 번진다. 알파는 건드리지 않는다 — 보이는 결과는 같고, 키울 때
 * 가장자리에 섞여 들어가는 색만 바뀐다. 보간 커널이 몇 픽셀만 보므로 몇 겹이면 충분하다.
 */
export function colorBleed(img: Raster, passes = 4): Raster {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(img.data);
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = data[i * 4 + 3] > 0 ? 1 : 0;

  const fill: number[] = [];
  const rgb: number[] = [];
  for (let pass = 0; pass < passes; pass++) {
    fill.length = 0;
    rgb.length = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if ((!dx && !dy) || nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (!known[j]) continue;
            r += data[j * 4];
            g += data[j * 4 + 1];
            b += data[j * 4 + 2];
            n++;
          }
        }
        if (n) {
          fill.push(i);
          rgb.push(r / n, g / n, b / n);
        }
      }
    }
    if (!fill.length) break;
    // 한 겹을 다 계산한 뒤에 써 넣는다. 도중에 쓰면 스캔 방향으로 색이 쏠린다
    fill.forEach((i, k) => {
      data[i * 4] = rgb[k * 3];
      data[i * 4 + 1] = rgb[k * 3 + 1];
      data[i * 4 + 2] = rgb[k * 3 + 2];
      known[i] = 1;
    });
  }
  return { data, width: w, height: h };
}

/**
 * 언샤프 마스크, 반경 1: out = 원본 + amount × (원본 − 3×3 가우시안[1 2 1]).
 * `channels` 로 어느 채널에 걸지 고른다 (기본 RGB+알파 — 알파도 세워야 외곽선이 또렷하다).
 * `threshold` 보다 작은 차이는 건드리지 않는다 — 평평한 면의 잡티를 키우지 않게.
 * 가장자리 밖은 가장 가까운 픽셀로 본다.
 */
export function unsharpMask(
  img: Raster,
  amount = 0.4,
  o: { threshold?: number; channels?: number[] } = {},
): Raster {
  const { width: w, height: h, data: src } = img;
  const threshold = o.threshold ?? 2;
  const channels = o.channels ?? [0, 1, 2, 3];
  const out = new Uint8ClampedArray(src);
  const K = [1, 2, 1];
  for (const c of channels) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            sum += K[dy + 1] * K[dx + 1] * src[(ny * w + nx) * 4 + c];
          }
        }
        const p = (y * w + x) * 4 + c;
        const diff = src[p] - sum / 16;
        if (Math.abs(diff) < threshold) continue;
        out[p] = src[p] + amount * diff; // Uint8ClampedArray 가 0~255 로 자르고 반올림한다
      }
    }
  }
  return { data: out, width: w, height: h };
}

/** 색과 알파를 나눈다. 둘 다 불투명 이미지라 캔버스의 알파 곱셈에 망가지지 않는다 */
export function splitAlpha(img: Raster): { color: Raster; alpha: Raster } {
  const n = img.width * img.height;
  const color = new Uint8ClampedArray(n * 4);
  const alpha = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    color[p] = img.data[p];
    color[p + 1] = img.data[p + 1];
    color[p + 2] = img.data[p + 2];
    color[p + 3] = 255;
    alpha[p] = alpha[p + 1] = alpha[p + 2] = img.data[p + 3];
    alpha[p + 3] = 255;
  }
  return { color: { data: color, width: img.width, height: img.height }, alpha: { data: alpha, width: img.width, height: img.height } };
}

/** splitAlpha 의 반대. 알파는 회색조 이미지의 R 에서 읽는다 */
export function mergeAlpha(color: Raster, alpha: Raster): Raster {
  const n = color.width * color.height;
  const data = new Uint8ClampedArray(color.data);
  for (let i = 0; i < n; i++) data[i * 4 + 3] = alpha.data[i * 4];
  return { data, width: color.width, height: color.height };
}

/* ------------------------------------------------------------------ *
 * 브라우저
 * ------------------------------------------------------------------ */

function stepResize(r: Raster, plan: { w: number; h: number }[]): Raster {
  let cur = document.createElement("canvas");
  cur.width = r.width;
  cur.height = r.height;
  cur.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  for (const s of plan) {
    const next = document.createElement("canvas");
    next.width = s.w;
    next.height = s.h;
    const ctx = next.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, s.w, s.h);
    cur.width = cur.height = 0; // 큰 캔버스 메모리를 바로 놓는다
    cur = next;
  }
  const img = cur.getContext("2d")!.getImageData(0, 0, cur.width, cur.height);
  cur.width = cur.height = 0;
  return { data: img.data, width: img.width, height: img.height };
}

/**
 * 긴 변이 target 이 되도록 키운다. target 이 0 이거나 이미 그 이상이면 그대로 돌려준다.
 * amount 는 언샤프 양(0.3~0.5 권장).
 */
export function upscaleRaster(img: Raster, target: number, amount = 0.4): Raster {
  const plan = upscalePlan(img.width, img.height, target);
  if (!plan.length) return img;
  const { color, alpha } = splitAlpha(colorBleed(img));
  const merged = mergeAlpha(stepResize(color, plan), stepResize(alpha, plan));
  return unsharpMask(merged, amount);
}
