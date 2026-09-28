"use client";

import Help from "@/components/Help";
import type { Raster } from "@/lib/cutout";
import { canvasToBlob, rasterToCanvas } from "@/lib/canvasImage";
import { UPSCALE_TARGETS, upscaleRaster } from "@/lib/upscale";

/**
 * 누끼 조각 업스케일 — 스톡 세트(page.tsx)와 시트 나누기(SheetTool.tsx)가 같이 쓴다.
 */

export type Upscaled = {
  png: Blob;
  width: number;
  height: number;
  /** 누끼만 딴 원본 조각 (키우지 않은 것) */
  origPng: Blob;
  origWidth: number;
  origHeight: number;
};

/** 조각 하나를 PNG 로. target 이 0 이거나 이미 크면 원본을 그대로 쓴다 */
export async function finishPiece(piece: Raster, target: number): Promise<Upscaled> {
  const origPng = await canvasToBlob(rasterToCanvas(piece), "image/png");
  const big = upscaleRaster(piece, target);
  const png = big === piece ? origPng : await canvasToBlob(rasterToCanvas(big), "image/png");
  return { png, width: big.width, height: big.height, origPng, origWidth: piece.width, origHeight: piece.height };
}

/** 카드에 붙일 한 줄. "384→2048px" */
export function sizeLabel(p: { width: number; height: number; origWidth: number; origHeight: number }): string {
  const from = Math.max(p.origWidth, p.origHeight);
  const to = Math.max(p.width, p.height);
  return from === to ? `${p.width}×${p.height}` : `${from}→${to}px`;
}

/** 원본의 몇 배로 키웠는지 */
export const upscaleFactor = (p: { width: number; height: number; origWidth: number; origHeight: number }) =>
  Math.max(p.width, p.height) / Math.max(1, Math.max(p.origWidth, p.origHeight));

export const UPSCALE_HELP =
  "누끼 조각을 긴 변 기준으로 2배씩 단계적으로 키우고(한 번에 키우면 계단·뭉개짐), 가장자리 흰 번짐을 막은 뒤 약하게 샤프닝합니다. " +
  "플랫·라인·스티커·손그림처럼 경계가 단순한 화풍은 잘 버티지만, 클레이·사진풍 질감은 새로 만들어지지 않고 부드러워집니다. " +
  "판매용: 어도비 스톡 등은 보통 최소 4MP(2048×2048 ≈ 4.2MP)를 요구하니 2048 이상을 권장, 미리캔버스 요소로만 쓰면 1024 로 충분합니다 — 정확한 규정은 각 사이트에서 확인하세요.";

export function UpscaleControls({
  target,
  setTarget,
  withOriginal,
  setWithOriginal,
}: {
  target: number;
  setTarget: (n: number) => void;
  withOriginal: boolean;
  setWithOriginal: (b: boolean) => void;
}) {
  return (
    <div className="row" style={{ alignItems: "center" }}>
      <label className="check-inline">
        업스케일
        <Help text={UPSCALE_HELP} />
        <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {UPSCALE_TARGETS.map((t) => (
            <option key={t} value={t}>
              {t ? `긴 변 ${t}px` : "키우지 않음"}
            </option>
          ))}
        </select>
      </label>
      {target > 0 && (
        <label className="check-inline">
          <input type="checkbox" checked={withOriginal} onChange={(e) => setWithOriginal(e.target.checked)} /> ZIP 에 원본 조각도 넣기
        </label>
      )}
    </div>
  );
}
