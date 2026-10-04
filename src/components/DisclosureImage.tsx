"use client";

import { useEffect, useState } from "react";
import Help from "@/components/Help";

/**
 * 대가성 문구 이미지 — 네이버 글 맨 위에 넣는다.
 *
 * 공정위 추천·보증 심사지침(2024-12 개정)은 블로그의 경제적 이해관계 표시를 "제목 또는 첫 부분" 에,
 * 본문보다 크게 하거나 색을 달리해 쉽게 알아보게 두라고 한다. 텍스트 첫 줄로 두면 네이버 검색
 * 미리보기가 "이 포스팅은 … 수수료를" 로 시작해 클릭이 줄어든다. 맨 위 이미지면 위치·크기 조건은
 * 지키면서 미리보기는 그다음 문장부터 나온다.
 *
 * 캔버스로 PNG 를 만든다. 가로 860px(네이버 본문 폭), 높이는 문구 길이에 맞춘다. 서버에 올리지 않고
 * data URL 로 보여 준다 — 아이폰은 이미지를 길게 눌러 사진 앱에 저장할 수 있다.
 */

const W = 860;
const BAR = 14;
const PAD_L = BAR + 40;
const PAD_R = 44;
const PAD_Y = 36;
const FONT_SIZE = 30;
const LINE_H = Math.round(FONT_SIZE * 1.5);
const CHIP_FONT = 22;
const CHIP_H = 40;
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';

const BG = "#FFF4D6";
const ACCENT = "#F2A900";
const INK = "#3A2E00";

/** 폭에 맞춰 줄을 나눈다. 띄어쓰기에서 먼저 끊고, 한 어절이 너무 길면 글자 단위로 끊는다 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = "";
  const push = (word: string) => {
    const next = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(next).width <= maxW) {
      cur = next;
      return;
    }
    if (cur) lines.push(cur);
    cur = "";
    if (ctx.measureText(word).width <= maxW) {
      cur = word;
      return;
    }
    for (const ch of word) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        lines.push(cur);
        cur = ch;
      } else cur += ch;
    }
  };
  for (const w of text.split(/\s+/).filter(Boolean)) push(w);
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawDisclosure(text: string, label: string): string {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.font = `700 ${FONT_SIZE}px ${FONT_FAMILY}`;
  const lines = wrap(ctx, text, W - PAD_L - PAD_R);
  const textTop = PAD_Y + CHIP_H + 18;
  const H = textTop + lines.length * LINE_H + PAD_Y - (LINE_H - FONT_SIZE) / 2;

  canvas.width = W;
  canvas.height = Math.ceil(H);

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, BAR, canvas.height);

  // 라벨 칩
  ctx.font = `800 ${CHIP_FONT}px ${FONT_FAMILY}`;
  const chipW = ctx.measureText(label).width + 32;
  ctx.fillStyle = ACCENT;
  roundRect(ctx, PAD_L, PAD_Y, chipW, CHIP_H, CHIP_H / 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(label, PAD_L + 16, PAD_Y + CHIP_H / 2 + 1);

  // 문구
  ctx.font = `700 ${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, PAD_L, textTop + i * LINE_H));

  return canvas.toDataURL("image/png");
}

export default function DisclosureImage({
  text,
  label = "광고",
  onReady,
}: {
  /** disclosureText() 결과 그대로 */
  text: string;
  label?: "광고" | "제휴";
  /** 만든 이미지(data URL). 본문 복사 때 맨 앞 자리에 넣는 데 쓴다 */
  onReady?: (dataUrl: string) => void;
}) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    if (!text) return;
    let alive = true;
    // 웹폰트가 늦게 오면 기본 글꼴로 그려진다. 글꼴이 준비된 뒤 그린다
    const ready = (document as Document & { fonts?: FontFaceSet }).fonts?.ready ?? Promise.resolve();
    ready.then(() => {
      if (!alive) return;
      const url = drawDisclosure(text, label);
      setSrc(url);
      if (url) onReady?.(url);
    });
    return () => {
      alive = false;
    };
    // onReady 는 부모가 매 렌더 새로 만들 수 있다. 문구가 바뀔 때만 다시 그린다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, label]);

  if (!text) return null;
  return (
    <div className="field" style={{ marginTop: 12 }}>
      <label>
        대가성 문구 이미지
        <Help text="공정위 지침상 대가성 표시는 글의 제목 또는 첫 부분에 크게·눈에 띄게 둬야 합니다. 하단에 두면 위반입니다. 이미지로 맨 위에 두면 검색 미리보기는 그다음 문장부터 나옵니다." />
      </label>
      <p className="hint">네이버 에디터 맨 위에 이 이미지를 먼저 넣고 본문을 붙여넣으세요. 아이폰은 이미지를 길게 눌러 사진에 저장할 수 있습니다.</p>
      {src ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL 이라 next/image 를 쓸 이유가 없다 */}
          <img src={src} alt={`${label}: ${text}`} style={{ display: "block", width: "100%", maxWidth: W, height: "auto", borderRadius: 8 }} />
          <div className="row" style={{ marginTop: 6 }}>
            <a className="link-btn" href={src} download="대가성-문구.png">
              이미지 저장
            </a>
          </div>
        </>
      ) : (
        <p className="hint">이미지를 만드는 중…</p>
      )}
    </div>
  );
}
