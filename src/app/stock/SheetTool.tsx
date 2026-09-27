"use client";

import { useState } from "react";
import Help from "@/components/Help";
import { copyText } from "@/lib/clipboard";
import { removeBackground, splitElements, splitGrid, type Raster } from "@/lib/cutout";
import { canvasToBlob, fileToRaster, rasterToCanvas, slug } from "@/lib/canvasImage";
import { sheetPrompt, STOCK_STYLES, type StockStyle } from "@/lib/stockPrompt";
import { makeZip } from "@/lib/zip";

/**
 * 시트 나누기 — 아이템 하나를 16·25개 변형으로 한 장에 뽑고, 칸마다 누끼를 따서 ZIP 으로.
 *
 * 프롬프트 한 번에 요소가 수십 개 나오니 ChatGPT 요청 수가 크게 준다. 대신 칸 하나가 작아서
 * (1024px 시트의 5×5 면 한 칸 약 200px) 스톡 판매보다 직접 쓸 요소·아이콘 세트에 맞는다.
 * 크기가 부족한 조각은 표시한다.
 */

type Piece = { id: string; url: string; png: Blob; width: number; height: number; keep: boolean; warnings: string[] };

const GRIDS = [
  { label: "9개 (3×3)", rows: 3, cols: 3 },
  { label: "16개 (4×4)", rows: 4, cols: 4 },
  { label: "25개 (5×5)", rows: 5, cols: 5 },
  { label: "36개 (6×6)", rows: 6, cols: 6 },
];

const STYLE_LABELS: Record<StockStyle, string> = {
  flat: "플랫",
  sticker: "스티커",
  clay: "3D 클레이",
  doodle: "손그림",
  line: "라인 아이콘",
};

export default function SheetTool({ flash, setError }: { flash: (m: string) => void; setError: (m: string) => void }) {
  const [item, setItem] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [grid, setGrid] = useState(1);
  const [style, setStyle] = useState<StockStyle>("sticker");

  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<"grid" | "auto">("grid");
  const [holes, setHoles] = useState(false);
  const [tolerance, setTolerance] = useState(30);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [busy, setBusy] = useState<{ key: string; msg: string } | null>(null);

  const { rows, cols } = GRIDS[grid];
  const prompt = item.trim() ? sheetPrompt({ item: item.trim(), rows, cols, style }) : "";

  function clearPieces() {
    pieces.forEach((p) => URL.revokeObjectURL(p.url));
    setPieces([]);
  }

  async function run() {
    setError("");
    clearPieces();
    const done: Piece[] = [];
    try {
      for (let fi = 0; fi < files.length; fi++) {
        setBusy({ key: "run", msg: `${fi + 1}/${files.length}장 나누는 중…` });
        await new Promise((r) => setTimeout(r, 0));

        const src = await fileToRaster(files[fi]);
        const pad = Math.max(4, Math.round(Math.min(src.width / cols, src.height / rows) * 0.04));
        let cut: { image: Raster; warnings: string[] }[];

        if (mode === "grid") {
          cut = splitGrid(src, rows, cols, pad, { tolerance, holes }).map((g) => ({
            image: g.image,
            warnings: [
              ...(g.touchesEdge ? ["칸 경계에 닿음 — 옆 칸에 잘렸을 수 있어요"] : []),
              ...(g.uniform ? [] : ["배경이 단색이 아님"]),
            ],
          }));
        } else {
          const r = removeBackground(src, { tolerance, holes });
          const gap = Math.round(Math.min(src.width, src.height) * 0.01);
          cut = splitElements(r.image, gap, pad).map((image) => ({
            image,
            warnings: r.uniform ? [] : ["배경이 단색이 아님"],
          }));
        }

        for (let i = 0; i < cut.length; i++) {
          const { image, warnings } = cut[i];
          const png = await canvasToBlob(rasterToCanvas(image), "image/png");
          done.push({
            id: `${fi}-${i}`,
            url: URL.createObjectURL(png),
            png,
            width: image.width,
            height: image.height,
            keep: true,
            warnings: [...warnings, ...(Math.max(image.width, image.height) < 300 ? ["300px 미만 — 작게만 쓰세요"] : [])],
          });
        }
        setPieces([...done]);
      }
      const expected = rows * cols * files.length;
      flash(
        mode === "grid" && done.length < expected
          ? `${done.length}개 (빈 칸 ${expected - done.length}개는 건너뜀)`
          : `${done.length}개로 나눴습니다`,
      );
    } catch (e) {
      setError(`${(e as Error).message} — HEIC 라면 JPEG/PNG 로 바꿔 올려주세요.`);
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy({ key: "zip", msg: "" });
    try {
      const kept = pieces.filter((p) => p.keep);
      const base = slug(nameEn) === "element" ? "item" : slug(nameEn);
      const digits = String(kept.length).length;
      const entries = await Promise.all(
        kept.map(async (p, i) => ({
          name: `${base}-${String(i + 1).padStart(Math.max(2, digits), "0")}.png`,
          data: new Uint8Array(await p.png.arrayBuffer()),
        })),
      );
      const blob = new Blob([makeZip(entries)], { type: "application/zip" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${base}-${kept.length}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      flash(`${kept.length}개를 받았습니다`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const isBusy = Boolean(busy);
  const spin = (key: string) => busy?.key === key && <span className="spinner" />;
  const kept = pieces.filter((p) => p.keep).length;

  return (
    <>
      <div className="card">
        <h2>
          1. 시트 프롬프트
          <Help text="아이템 하나를 여러 변형으로 격자에 그리게 합니다. ChatGPT 에 붙여 넣고, 받은 시트를 아래 2번에 올리세요. 격자가 흐트러지면 '자동' 으로 나누면 됩니다." />
        </h2>
        <div className="row">
          <div className="field" style={{ flex: 2, minWidth: 180 }}>
            <label>아이템</label>
            <input placeholder="도토리" value={item} onChange={(e) => setItem(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label>
              영문 이름 (파일명)
              <Help text="ZIP 안의 파일 이름에 씁니다. 비우면 item-01.png 처럼 나갑니다." />
            </label>
            <input placeholder="acorn" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>개수</label>
            <div className="seg">
              {GRIDS.map((g, i) => (
                <button key={g.label} className={grid === i ? "on" : ""} onClick={() => setGrid(i)}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>스타일</label>
            <div className="seg">
              {(Object.keys(STOCK_STYLES) as StockStyle[]).map((k) => (
                <button key={k} className={style === k ? "on" : ""} onClick={() => setStyle(k)}>
                  {STYLE_LABELS[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        {prompt && (
          <>
            <pre className="prompt-box">{prompt}</pre>
            <button className="primary" onClick={() => copyText(prompt).then(() => flash("시트 프롬프트 복사됨"))}>
              프롬프트 복사
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h2>
          2. 나누고 누끼 따기
          <Help text="격자: 칸을 그대로 잘라 칸마다 누끼를 땁니다. 조각이 여러 개로 그려진 요소도 한 칸이면 하나로 남습니다. 자동: 떨어진 덩어리를 요소로 봅니다. 모델이 격자를 안 지켰을 때 쓰세요." />
        </h2>
        <div className="field">
          <label>시트 이미지</label>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              clearPieces();
            }}
          />
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <div className="seg">
            <button className={mode === "grid" ? "on" : ""} onClick={() => setMode("grid")}>
              격자 {rows}×{cols}
            </button>
            <button className={mode === "auto" ? "on" : ""} onClick={() => setMode("auto")}>
              자동
            </button>
          </div>
          <label className="check-inline">
            <input type="checkbox" checked={holes} onChange={(e) => setHoles(e.target.checked)} /> 안쪽 구멍도 지우기
          </label>
          <label className="check-inline">
            허용 오차 {tolerance}
            <input type="range" min={10} max={80} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
          </label>
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <button className="primary" onClick={run} disabled={isBusy || !files.length}>
            {spin("run")}
            나누기
          </button>
          {busy?.key === "run" && <span className="hint">{busy.msg}</span>}
        </div>

        {pieces.length > 0 && (
          <>
            <div className="cutout-grid">
              {pieces.map((p) => (
                <div key={p.id} className={`cutout-item${p.keep ? "" : " off"}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt="" />
                  <div className="hint">
                    {p.width}×{p.height}
                  </div>
                  {p.warnings.map((w, i) => (
                    <div key={i} className="hint warn-text">
                      {w}
                    </div>
                  ))}
                  <button
                    className="small ghost"
                    onClick={() => setPieces((xs) => xs.map((x) => (x.id === p.id ? { ...x, keep: !x.keep } : x)))}
                  >
                    {p.keep ? "빼기" : "다시 넣기"}
                  </button>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" onClick={download} disabled={isBusy || !kept}>
                {spin("zip")}
                {kept}개 ZIP 받기
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

