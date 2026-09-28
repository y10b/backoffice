"use client";

import { useEffect, useState } from "react";
import Help from "@/components/Help";
import { copyText } from "@/lib/clipboard";
import {
  opaqueBox,
  cropPadded,
  removeBackground,
  splitByGutters,
  splitElements,
  splitGrid,
  type Raster,
} from "@/lib/cutout";
import { makeZip, type ZipEntry } from "@/lib/zip";
import { canvasToBlob, fileToRaster, slug } from "@/lib/canvasImage";
import {
  bestGrid,
  cellSize,
  gridSheetPrompt,
  itemDescription,
  GRID_COUNTS,
  STOCK_STYLES,
  type StockStyle,
} from "@/lib/stockPrompt";
import { DEFAULT_UPSCALE } from "@/lib/upscale";
import SheetTool from "./SheetTool";
import { finishPiece, sizeLabel, upscaleFactor, UpscaleControls } from "./Upscale";

/**
 * AI 스톡 이미지 — 부수입 갈래.
 *
 *   1. 주제   지금 만들어 둘 시즌 주제 (석 달 안에 수요가 몰리는 것)
 *   2. 프롬프트   ChatGPT 에 붙여 넣을 문장 + 판매용 제목·키워드
 *      "한 장으로"(기본): 아이템 N개를 격자 한 장에 그리는 프롬프트 하나. ChatGPT 요청이 1번이다
 *      "하나씩": 아이템마다 프롬프트 하나
 *   3. 누끼   ChatGPT 가 준 이미지를 올리면 흰 배경을 걷어내고 요소별로 자른다.
 *            한 장이면 격자 칸 순서 = 아이템 순서로 이름을 붙인다. 작은 칸은 업스케일한다
 *   4. 받기   미리캔버스용 PNG, Adobe 용 JPG, 메타데이터 CSV 를 ZIP 하나로
 *
 * 이미지 생성과 플랫폼 업로드는 사람이 한다. 업로드할 때 두 플랫폼 모두 "AI 로 만든 콘텐츠"
 * 체크가 필수다 — 미리캔버스는 빠뜨리면 로열티 환수까지 걸린다.
 */

type Topic = {
  name: string;
  hints: string;
  monthsAhead: number;
  delta: number | null;
  searches: number | null;
};

type PromptItem = {
  subject: string;
  prompt: string;
  titleKo: string;
  titleEn: string;
  keywordsKo: string[];
  keywordsEn: string[];
  adobeCategory: number;
};

type Output = {
  id: string;
  /** 어느 프롬프트로 만든 이미지인지. 제목·키워드를 여기서 가져온다 */
  promptIdx: number;
  source: string;
  /** 업스케일한 PNG (키우지 않았으면 원본과 같다) */
  png: Blob;
  url: string;
  width: number;
  height: number;
  origPng: Blob;
  origWidth: number;
  origHeight: number;
  keep: boolean;
  warnings: string[];
};

const STYLES: { key: string; label: string }[] = [
  { key: "flat", label: "플랫" },
  { key: "sticker", label: "스티커" },
  { key: "clay", label: "3D 클레이" },
  { key: "doodle", label: "손그림" },
  { key: "line", label: "라인 아이콘" },
];

/** Adobe Stock 최소 4MP. 조금 여유를 둔다 */
const ADOBE_MIN_PIXELS = 4_200_000;
/** 이보다 크게 늘리면 뭉개진 게 보인다. Adobe 도 과한 업스케일을 반려 사유로 든다 */
const MAX_UPSCALE = 2.5;
/** 우리 업스케일(upscale.ts)로 이보다 많이 키운 조각은 100% 로 확인하라고 표시한다 */
const WARN_UPSCALE = 2.5;
const SAVED_KEY = "stock:last-prompts";

/**
 * Adobe 용 JPG. 투명 요소를 흰 정사각형 가운데에 두고 4MP 를 넘게 키운다.
 * 너무 많이 키워야 하면 null — 뭉개진 이미지를 올려 반려되는 것보다 안 올리는 게 낫다.
 */
async function adobeJpg(png: Blob, origMaxEdge: number): Promise<{ blob: Blob; upscale: number } | null> {
  const bitmap = await createImageBitmap(png);
  const side = Math.ceil(Math.sqrt(ADOBE_MIN_PIXELS));
  // 요소가 정사각형의 80% 를 차지하게. 여백이 있어야 디자이너가 쓰기 좋다
  const fit = (side * 0.8) / Math.max(bitmap.width, bitmap.height);
  /*
   * 판매 자격은 우리가 키우기 전의 **원래 칸 크기**로 판단한다. 업스케일(upscale.ts)은 경계를
   * 매끈하게 할 뿐 디테일을 만들지 않는다. 키운 PNG 기준으로 재면 384px 칸이 통과해
   * 반려되는 이미지를 올리게 된다.
   */
  const total = (side * 0.8) / Math.max(1, origMaxEdge);
  if (total > MAX_UPSCALE) {
    bitmap.close();
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, side, side);
  ctx.imageSmoothingQuality = "high";
  const w = bitmap.width * fit;
  const h = bitmap.height * fit;
  ctx.drawImage(bitmap, (side - w) / 2, (side - h) / 2, w, h);
  bitmap.close();
  return { blob: await canvasToBlob(canvas, "image/jpeg", 0.92), upscale: fit };
}

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

export default function StockPage() {
  const [error, setError] = useState("");
  /* 세트: 주제 → 프롬프트 여러 개 → 누끼. 시트: 아이템 하나를 한 장에 여러 개 → 칸마다 누끼 */
  const [tab, setTab] = useState<"set" | "sheet">("set");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<{ key: string; msg: string } | null>(null);

  /* 1. 주제 */
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicErrors, setTopicErrors] = useState<string[]>([]);
  const [topic, setTopic] = useState("");
  const [hints, setHints] = useState("");

  /* 2. 프롬프트 */
  /* one: 아이템 N개를 격자 한 장으로 (프롬프트 하나). each: 아이템마다 프롬프트 하나 */
  const [promptMode, setPromptMode] = useState<"one" | "each">("one");
  const [style, setStyle] = useState<StockStyle>("flat");
  /* 프롬프트를 만들 때의 스타일. 격자 프롬프트는 이걸로 조립한다 (지금 고른 스타일과 다를 수 있다) */
  const [promptStyle, setPromptStyle] = useState<StockStyle>("flat");
  const [count, setCount] = useState(8);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [promptTopic, setPromptTopic] = useState("");

  /* 3. 누끼 */
  const [files, setFiles] = useState<File[]>([]);
  /* 올린 이미지가 몇 번 프롬프트로 만든 것인지. 기본은 올린 순서 */
  const [assign, setAssign] = useState<number[]>([]);
  const [split, setSplit] = useState(false);
  const [holes, setHoles] = useState(false);
  const [tolerance, setTolerance] = useState(30);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [upscale, setUpscale] = useState<number>(DEFAULT_UPSCALE);
  const [withOriginal, setWithOriginal] = useState(false);

  /* 4. 받기 */
  const [withAdobe, setWithAdobe] = useState(true);

  // 프롬프트를 만든 뒤 ChatGPT 에서 이미지를 뽑다 보면 화면을 닫기도 한다. 이 브라우저에만 남긴다
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "null");
      if (saved?.prompts?.length) {
        setPrompts(saved.prompts);
        setPromptTopic(saved.topic ?? "");
        if (saved.style in STOCK_STYLES) setPromptStyle(saved.style);
      }
    } catch {
      /* 저장소를 못 쓰면 그냥 빈 채로 시작한다 */
    }
  }, []);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  }

  async function loadTopics() {
    setError("");
    setBusy({ key: "topics", msg: "검색 추세를 보는 중…" });
    try {
      const d = await (await fetch("/api/stock/topics", { method: "POST" })).json();
      if (!d.ok) throw new Error(d.error ?? "주제를 못 불러왔습니다.");
      setTopics(d.topics ?? []);
      setTopicErrors(d.errors ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function makePrompts() {
    setError("");
    setBusy({ key: "prompts", msg: "프롬프트와 키워드를 만드는 중… 20초쯤" });
    try {
      const d = await (
        await fetch("/api/stock/prompts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic, hints, style, count }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error ?? "프롬프트를 못 만들었습니다.");
      setPrompts(d.items ?? []);
      setPromptTopic(topic);
      setPromptStyle(style);
      setAssign([]);
      try {
        localStorage.setItem(SAVED_KEY, JSON.stringify({ topic, style, prompts: d.items ?? [] }));
      } catch {
        /* 저장 못 해도 지금 화면에는 있다 */
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function pickFiles(list: FileList | null) {
    // 한 장 모드는 격자 이미지 하나만 받는다
    const next = Array.from(list ?? []).slice(0, promptMode === "one" ? 1 : undefined);
    setFiles(next);
    setAssign([]);
    outputs.forEach((o) => URL.revokeObjectURL(o.url));
    setOutputs([]);
  }

  /** 조각 하나를 업스케일해 카드로 만든다. 두 모드가 같이 쓴다 */
  async function toOutput(piece: Raster, id: string, promptIdx: number, source: string, warnings: string[]): Promise<Output> {
    const up = await finishPiece(piece, upscale);
    const factor = upscaleFactor(up);
    return {
      id,
      promptIdx,
      source,
      ...up,
      url: URL.createObjectURL(up.png),
      keep: true,
      warnings: [
        ...warnings,
        ...(Math.max(up.width, up.height) < 500 ? ["500px 보다 작습니다. 미리캔버스에서 흐리게 쓰일 수 있어요"] : []),
        ...(factor > WARN_UPSCALE
          ? [`원본의 ${factor.toFixed(1)}배로 키움 — 100% 로 확대해 뭉개짐을 확인하세요`]
          : []),
      ],
    };
  }

  /**
   * 한 장 모드: 격자 이미지 한 장 → 칸마다 누끼 → 칸 순서대로 아이템에 짝짓는다.
   *
   * 먼저 균등 격자(splitGrid)로 자른다 — 칸 번호가 그대로 아이템 번호라 순서가 확실하다.
   * 빈 칸이 있거나 그림이 칸 경계에 닿았으면(모델이 격자를 삐뚤게 그렸으면) 빈 줄로 격자를
   * 찾는 splitByGutters 를 시도하고, 조각 수가 아이템 수와 맞을 때만 그쪽을 쓴다.
   */
  async function cutoutGrid(done: Output[]) {
    const file = files[0];
    setBusy({ key: "cutout", msg: `${grid.rows}×${grid.cols} 격자로 나누는 중…` });
    await new Promise((r) => setTimeout(r, 0));
    const src = await fileToRaster(file);
    const n = prompts.length;
    const pad = Math.max(4, Math.round(Math.min(src.width / grid.cols, src.height / grid.rows) * 0.04));

    type Cut = { image: Raster; idx: number; warnings: string[] };
    const byGrid: Cut[] = splitGrid(src, grid.rows, grid.cols, pad, { tolerance, holes })
      .filter((g) => g.cell < n)
      .map((g) => ({
        image: g.image,
        idx: g.cell,
        warnings: [
          ...(g.touchesEdge ? ["칸 경계에 닿음 — 옆 칸에 잘렸을 수 있어요"] : []),
          ...(g.uniform ? [] : ["배경이 단색이 아님"]),
        ],
      }));
    let cut = byGrid;
    let how = "균등 격자";
    if (byGrid.length < n || byGrid.some((c) => c.warnings.length)) {
      const r = removeBackground(src, { tolerance, holes });
      const byGutter = splitByGutters(r.image, pad);
      if (byGutter.length === n) {
        cut = byGutter.map((g, i) => ({ image: g.image, idx: i, warnings: r.uniform ? [] : ["배경이 단색이 아님"] }));
        how = "빈 줄 격자";
      }
    }

    for (let i = 0; i < cut.length; i++) {
      setBusy({ key: "cutout", msg: `${i + 1}/${cut.length}개 업스케일 중…` });
      await new Promise((r) => setTimeout(r, 0));
      done.push(await toOutput(cut[i].image, `g-${cut[i].idx}`, cut[i].idx, file.name, cut[i].warnings));
      setOutputs([...done]);
    }
    const missing = n - cut.length;
    return missing > 0
      ? `${cut.length}/${n}개 (${how}) — ${missing}칸이 비었습니다. 번호를 확인하세요`
      : `${cut.length}개를 ${how}로 나눴습니다`;
  }

  async function cutout() {
    setError("");
    outputs.forEach((o) => URL.revokeObjectURL(o.url));
    setOutputs([]);
    const done: Output[] = [];
    try {
      if (promptMode === "one" && prompts.length) {
        flash(await cutoutGrid(done));
        return;
      }
      for (let fi = 0; fi < files.length; fi++) {
        setBusy({ key: "cutout", msg: `${fi + 1}/${files.length}장 누끼 따는 중…` });
        // 한 장 끝날 때마다 화면이 숨을 쉬게 한다. 안 그러면 진행 표시가 멈춰 보인다
        await new Promise((r) => setTimeout(r, 0));

        const file = files[fi];
        const src = await fileToRaster(file);
        const r = removeBackground(src, { tolerance, holes });
        const warnings: string[] = [];
        if (!r.uniform) warnings.push("배경이 단색이 아닙니다. 그림자나 바닥이 남았을 수 있어요");

        const pad = Math.round(Math.min(src.width, src.height) * 0.02);
        let pieces: Raster[];
        if (split) {
          pieces = splitElements(r.image, Math.round(Math.min(src.width, src.height) * 0.015), pad);
        } else {
          const box = opaqueBox(r.image);
          pieces = box ? [cropPadded(r.image, box, pad)] : [];
        }
        if (!pieces.length) warnings.push("남은 게 없습니다. 허용 오차를 낮춰 보세요");

        for (let pi = 0; pi < pieces.length; pi++) {
          done.push(await toOutput(pieces[pi], `${fi}-${pi}`, assignOf(fi), file.name, warnings));
        }
        setOutputs([...done]);
      }
      flash(`${done.length}개 요소를 잘랐습니다`);
    } catch (e) {
      setError(`${(e as Error).message} — HEIC 라면 JPEG/PNG 로 바꿔 올려주세요.`);
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setError("");
    setBusy({ key: "zip", msg: "파일을 묶는 중…" });
    try {
      const kept = outputs.filter((o) => o.keep);
      const entries: ZipEntry[] = [];
      const csv = ["Filename,Title,Keywords,Category,Releases"];
      const miri: string[] = [];
      const skipped: string[] = [];
      const used = new Map<string, number>();

      for (const o of kept) {
        const p = prompts[o.promptIdx];
        const base = slug(p?.titleEn || promptTopic || "element");
        // 한 장 모드는 격자 순서(= 아이템 번호)를 앞에 붙인다: 01-relay-baton
        const stem = o.id.startsWith("g-") ? `${String(o.promptIdx + 1).padStart(2, "0")}-${base}` : base;
        const n = (used.get(stem) ?? 0) + 1;
        used.set(stem, n);
        const name = o.id.startsWith("g-") && n === 1 ? stem : `${stem}-${n}`;

        entries.push({ name: `miricanvas/${name}.png`, data: new Uint8Array(await o.png.arrayBuffer()) });
        if (withOriginal && o.origPng !== o.png) {
          entries.push({ name: `original/${name}.png`, data: new Uint8Array(await o.origPng.arrayBuffer()) });
        }
        miri.push(
          [`${name}.png`, `제목: ${p?.titleKo ?? ""}`, `태그: ${(p?.keywordsKo ?? []).join(", ")}`, "AI 생성 콘텐츠 체크: 필수"].join("\n"),
        );

        if (withAdobe) {
          const jpg = await adobeJpg(o.png, Math.max(o.origWidth ?? o.width, o.origHeight ?? o.height));
          if (!jpg) {
            skipped.push(name);
            continue;
          }
          entries.push({ name: `adobe/${name}.jpg`, data: new Uint8Array(await jpg.blob.arrayBuffer()) });
          csv.push(
            [`${name}.jpg`, p?.titleEn ?? "", (p?.keywordsEn ?? []).join(", "), String(p?.adobeCategory ?? 8), ""]
              .map(csvCell)
              .join(","),
          );
        }
      }

      const enc = new TextEncoder();
      entries.push({ name: "miricanvas.txt", data: enc.encode(miri.join("\n\n") + "\n") });
      if (withAdobe) entries.push({ name: "adobe.csv", data: enc.encode(csv.join("\n") + "\n") });

      const blob = new Blob([makeZip(entries)], { type: "application/zip" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `stock-${slug(prompts[0]?.titleEn || "set")}-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);

      flash(
        skipped.length
          ? `받았습니다. ${skipped.length}개는 너무 작아 Adobe 용에서 뺐습니다`
          : `${kept.length}개 요소를 받았습니다`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** i 번째 이미지의 프롬프트. 사람이 고치지 않았으면 올린 순서 그대로 짝짓는다 */
  const assignOf = (i: number) => assign[i] ?? (prompts.length ? Math.min(i, prompts.length - 1) : -1);

  const isBusy = Boolean(busy);
  const spin = (key: string) => busy?.key === key && <span className="spinner" />;
  const busyNote = (key: string) =>
    busy?.key === key && busy.msg ? <span className="hint">{busy.msg}</span> : null;
  const keptCount = outputs.filter((o) => o.keep).length;

  /* 한 장 모드 격자. 만든 프롬프트 수로 정하고, 만들기 전에는 고른 개수로 미리 보여준다 */
  const grid = bestGrid(prompts.length || count);
  const cell = cellSize(grid.rows, grid.cols);
  const plannedGrid = bestGrid(count);
  const plannedCell = cellSize(plannedGrid.rows, plannedGrid.cols);
  const gridPrompt = prompts.length
    ? gridSheetPrompt({
        items: prompts.map((p) => itemDescription(p.prompt, promptStyle) || p.titleEn || p.subject),
        style: promptStyle,
        rows: grid.rows,
        cols: grid.cols,
      })
    : "";

  return (
    <div className="main">
      <h1 className="page-title">AI 스톡 이미지</h1>
      <p className="page-desc">
        시즌 주제로 프롬프트를 만들고, ChatGPT 로 뽑은 이미지를 올리면 누끼를 따서 판매용
        파일로 묶어 줍니다. 업로드할 때 <strong>AI 생성 콘텐츠 체크는 필수</strong>입니다.
      </p>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="toast">{notice}</div>}

      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={tab === "set" ? "on" : ""} onClick={() => setTab("set")}>
          스톡 세트
        </button>
        <button className={tab === "sheet" ? "on" : ""} onClick={() => setTab("sheet")}>
          시트 나누기
        </button>
      </div>

      {tab === "sheet" ? (
        <SheetTool flash={flash} setError={setError} />
      ) : (
        <>
          {/* ---------------- 1. 주제 ---------------- */}
          <div className="card">
            <h2>
              1. 주제
              <Help text="스톡은 수요가 몰리기 1~2달 전에 올라가 있어야 팔립니다. 앞으로 석 달 안의 시즌을, 업로드 적기와 검색 추세 순으로 보여줍니다." />
            </h2>
            <div className="row" style={{ alignItems: "center" }}>
              <button onClick={loadTopics} disabled={isBusy}>
                {spin("topics")}
                {topics.length ? "다시 보기" : "지금 만들 주제 보기"}
              </button>
              {busyNote("topics")}
            </div>
            {topicErrors.map((e, i) => (
              <div className="alert warn" key={i}>
                {e}
              </div>
            ))}
            {topics.length > 0 && (
              <div className="title-picks" style={{ marginTop: 10 }}>
                {topics.map((t) => (
                  <button
                    key={t.name}
                    className={`title-pick${topic === t.name ? " on" : ""}`}
                    onClick={() => {
                      setTopic(t.name);
                      setHints(t.hints);
                    }}
                  >
                    <strong>{t.name}</strong>
                    <span className="dim">
                      {" "}
                      · {t.monthsAhead === 0 ? "지금 한창(늦음)" : `${t.monthsAhead}달 뒤 수요`}
                      {t.delta !== null && ` · 검색 ${t.delta > 0 ? "▲" : "▼"}${Math.abs(t.delta)}%`}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>주제 (직접 적어도 됩니다)</label>
                <input placeholder="운동회" value={topic} onChange={(e) => setTopic(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 2, minWidth: 220 }}>
                <label>소재 힌트 (선택)</label>
                <input placeholder="박 터뜨리기, 계주 바통, 만국기" value={hints} onChange={(e) => setHints(e.target.value)} />
              </div>
            </div>
          </div>

          {/* ---------------- 2. 프롬프트 ---------------- */}
          <div className="card">
            <h2>
              2. 프롬프트
              <Help text="한 세트는 같은 스타일, 서로 다른 소재로 만듭니다. 미리캔버스는 스타일이 통일된 세트가 잘 쓰이고, 같은 물건의 색만 바꾼 변형은 스팸으로 반려됩니다. '한 장으로'는 아이템 전부를 격자 한 장에 그리게 해 ChatGPT 요청이 한 번이면 됩니다. 대신 칸이 작아 3번에서 업스케일합니다." />
            </h2>
            <div className="row">
              <div className="field">
                <label>방식</label>
                <div className="seg">
                  <button className={promptMode === "one" ? "on" : ""} onClick={() => setPromptMode("one")}>
                    한 장으로
                  </button>
                  <button className={promptMode === "each" ? "on" : ""} onClick={() => setPromptMode("each")}>
                    하나씩
                  </button>
                </div>
              </div>
              <div className="field">
                <label>스타일</label>
                <div className="seg">
                  {STYLES.map((s) => (
                    <button key={s.key} className={style === s.key ? "on" : ""} onClick={() => setStyle(s.key as StockStyle)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>개수</label>
                <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {GRID_COUNTS.map((n) => {
                    const g = bestGrid(n);
                    return (
                      <option key={n} value={n}>
                        {n}개{promptMode === "one" ? ` (${g.cols}×${g.rows})` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
            {promptMode === "one" && (
              <p className="hint">
                격자 {plannedGrid.cols}×{plannedGrid.rows} (가로×세로) · 칸당 약 {plannedCell.w}×{plannedCell.h}px — 3번에서 키웁니다
              </p>
            )}
            <div className="row" style={{ alignItems: "center" }}>
              <button className="primary" onClick={makePrompts} disabled={isBusy || !topic.trim()}>
                {spin("prompts")}
                프롬프트 만들기
              </button>
              {busyNote("prompts")}
            </div>

            {prompts.length > 0 && promptMode === "one" && (
              <>
                <p className="hint" style={{ marginTop: 12 }}>
                  {promptTopic} · {prompts.length}개를 {grid.cols}×{grid.rows} 격자 한 장으로 · 칸당 약 {cell.w}×{cell.h}px.
                  ChatGPT 에 한 번 붙여 넣고, 받은 이미지 한 장을 아래 3번에 올리세요. 번호가 곧 격자 위치입니다
                  (왼쪽 위부터 가로로).
                </p>
                <pre className="prompt-box">{gridPrompt}</pre>
                <button className="primary" onClick={() => copyText(gridPrompt).then(() => flash("격자 프롬프트 복사됨"))}>
                  프롬프트 복사
                </button>
                {prompts.map((p, i) => (
                  <div key={i} className="list-item entry">
                    <div className="entry-main">
                      <strong className="entry-title">
                        {i + 1}. {p.subject}
                      </strong>
                      <div className="entry-sub">
                        {p.titleKo} · {Math.floor(i / grid.cols) + 1}행 {(i % grid.cols) + 1}열
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {prompts.length > 0 && promptMode === "each" && (
              <>
                <p className="hint" style={{ marginTop: 12 }}>
                  {promptTopic} · {prompts.length}개. ChatGPT 에 하나씩 붙여 넣어 이미지를 만들고, 받은
                  순서대로 아래 3번에 올리세요.
                </p>
                {prompts.map((p, i) => (
                  <div key={i} className="list-item entry">
                    <div className="entry-main">
                      <strong className="entry-title">
                        {i + 1}. {p.subject}
                      </strong>
                      <div className="entry-sub">{p.titleKo}</div>
                    </div>
                    <div className="entry-side">
                      <button className="small" onClick={() => copyText(p.prompt).then(() => flash(`${i + 1}번 프롬프트 복사됨`))}>
                        프롬프트 복사
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* ---------------- 3. 누끼 ---------------- */}
          <div className="card">
            <h2>
              3. 올리기 · 누끼
              <Help text="흰 배경을 가장자리부터 걷어냅니다. 그림 안쪽의 흰색(눈 흰자, 반사광)은 남습니다. 도넛처럼 안에 갇힌 배경까지 지우려면 '안쪽 구멍'을 켜세요. 한 장 모드는 균등 격자로 먼저 자르고, 칸이 비거나 경계에 닿으면 빈 줄을 찾아 다시 나눕니다. 사진은 브라우저에서만 처리하고 서버로 보내지 않습니다." />
            </h2>
            <div className="field">
              <label>
                {promptMode === "one" && prompts.length
                  ? `ChatGPT 로 만든 격자 이미지 한 장 (${grid.cols}×${grid.rows}, ${prompts.length}개)`
                  : "ChatGPT 로 만든 이미지"}
              </label>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple={promptMode === "each"}
                onChange={(e) => pickFiles(e.target.files)}
              />
            </div>

            {promptMode === "each" && files.length > 0 && prompts.length > 0 && (
              <details style={{ marginBottom: 10 }}>
                <summary>이미지 ↔ 프롬프트 짝 ({files.length}장) — 순서가 다르면 여기서 고치세요</summary>
                {files.map((f, i) => (
                  <div key={i} className="row" style={{ alignItems: "center", marginTop: 6 }}>
                    <span className="hint" style={{ flex: 1, minWidth: 140 }}>
                      {f.name}
                    </span>
                    <select
                      value={assignOf(i)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setAssign(files.map((_, j) => (j === i ? v : assignOf(j))));
                      }}
                    >
                      {prompts.map((p, pi) => (
                        <option key={pi} value={pi}>
                          {pi + 1}. {p.subject}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </details>
            )}

            <div className="row" style={{ alignItems: "center" }}>
              {promptMode === "each" && (
                <label className="check-inline">
                  <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> 한 장에 여러 개면 나누기
                </label>
              )}
              <label className="check-inline">
                <input type="checkbox" checked={holes} onChange={(e) => setHoles(e.target.checked)} /> 안쪽 구멍도 지우기
              </label>
              <label className="check-inline">
                허용 오차 {tolerance}
                <input type="range" min={10} max={80} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
              </label>
            </div>
            <UpscaleControls
              target={upscale}
              setTarget={setUpscale}
              withOriginal={withOriginal}
              setWithOriginal={setWithOriginal}
            />
            <div className="row" style={{ alignItems: "center" }}>
              <button className="primary" onClick={cutout} disabled={isBusy || !files.length}>
                {spin("cutout")}
                누끼 따기
              </button>
              {busyNote("cutout")}
            </div>

            {outputs.length > 0 && (
              <div className="cutout-grid">
                {outputs.map((o) => (
                  <div key={o.id} className={`cutout-item${o.keep ? "" : " off"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={o.url} alt={o.source} />
                    <div className="hint">
                      {sizeLabel(o)}
                      {o.promptIdx >= 0 && ` · ${o.promptIdx + 1}번`}
                      {o.id.startsWith("g-") && prompts[o.promptIdx] && ` ${prompts[o.promptIdx].subject}`}
                    </div>
                    {o.warnings.map((w, i) => (
                      <div key={i} className="hint warn-text">
                        {w}
                      </div>
                    ))}
                    <button
                      className="small ghost"
                      onClick={() => setOutputs((xs) => xs.map((x) => (x.id === o.id ? { ...x, keep: !x.keep } : x)))}
                    >
                      {o.keep ? "빼기" : "다시 넣기"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---------------- 4. 받기 ---------------- */}
          {outputs.length > 0 && (
            <div className="card">
              <h2>
                4. 받기
                <Help text="미리캔버스: miricanvas 폴더의 PNG 를 '요소'로 올리고, miricanvas.txt 의 제목·태그를 붙여 넣으세요. Adobe Stock: adobe 폴더의 JPG 를 올린 뒤 adobe.csv 를 'Upload CSV' 로 넣으면 제목·키워드가 한 번에 들어갑니다. 원본 조각도 넣기를 켰으면 키우기 전 조각이 original 폴더에 들어갑니다." />
              </h2>
              <label className="check-inline">
                <input type="checkbox" checked={withAdobe} onChange={(e) => setWithAdobe(e.target.checked)} /> Adobe Stock 용
                JPG·CSV 도 만들기 (흰 배경, 4MP)
              </label>
              <div className="row" style={{ alignItems: "center", marginTop: 10 }}>
                <button className="primary" onClick={download} disabled={isBusy || !keptCount}>
                  {spin("zip")}
                  {keptCount}개 ZIP 받기
                </button>
                {busyNote("zip")}
              </div>
              <ul className="check" style={{ marginTop: 12 }}>
                <li>결함(손가락, 깨진 무늬, 남은 배경)이 없는지 100% 확대해서 봤는가</li>
                <li>업로드할 때 &quot;생성형 AI 로 만든 콘텐츠&quot; 를 체크했는가</li>
                <li>미리캔버스에는 사진이 아니라 &quot;요소&quot; 로 올렸는가</li>
                <li>브랜드·캐릭터·실존 인물이 들어가지 않았는가</li>
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
