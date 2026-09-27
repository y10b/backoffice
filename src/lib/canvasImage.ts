"use client";

import type { Raster } from "./cutout";

/**
 * 브라우저 캔버스 ↔ Raster 변환. cutout.ts 는 순수 계산만 하고, 파일을 읽고 쓰는 건 여기서 한다.
 */

export async function fileToRaster(file: File): Promise<Raster> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

export function rasterToCanvas(r: Raster): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지를 만들지 못했습니다."))), type, quality),
  );
}

/** 파일 이름. 업로드 화면과 CSV 가 이 이름으로 이어지므로 영문·숫자만 쓴다 */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 5)
      .join("-") || "element"
  );
}

