"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "@remotion/player";
import Help from "@/components/Help";
import { copyText } from "@/lib/clipboard";
import { splitGrid } from "@/lib/cutout";
import { fileToRaster, rasterToCanvas } from "@/lib/canvasImage";
import {
  EXPRESSIONS,
  FPS,
  HEIGHT,
  MAX_FOLLOWUPS,
  LENGTHS,
  MOODS,
  VOICES,
  WIDTH,
  buildTimeline,
  characterSheetPrompt,
  lineKey,
  type ExpressionKey,
  type LengthKey,
  type ReelScript,
  type StoryQA,
  plainText,
} from "@/lib/reelScript";
import { Reel } from "@/remotion/Reel";

/**
 * 썰 릴스 — 내가 겪은 일을 카톡처럼 물어보고, 애니 영상으로 만들어 내려받는다.
 *
 *   0. 주인공   한 번만. 표정 8종 시트를 ChatGPT 로 뽑아 올리면 칸마다 잘라 고정한다
 *   1. 인터뷰   카톡 티키타카. 한 번에 한 질문
 *   2. 대본     GPT 가 장면으로 나누고 가명 처리. 사람이 고친다
 *   3. 목소리   Azure(선히·인준…). 키가 없으면 자막만
 *   4. 미리보기 → MP4   브라우저에서 렌더한다(데스크톱 크롬). 서버는 영상을 만들지 않는다
 *
 * BGM 은 넣지 않는다. 업로드할 때 인스타 앱에서 붙이는 게 저작권도 안전하고 트렌드 음원 노출에도 낫다.
 */

type Character = { look: string; expressions: Partial<Record<ExpressionKey, string>> } | null;

const DRAFT_KEY = "reels:draft";
/** 표정 한 장의 긴 변. 영상에서 520px 로 쓰니 이 정도면 충분하고, 설정 표에 넣기에도 가볍다 */
const EXPR_EDGE = 480;

export default function ReelsPage() {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<{ key: string; msg: string } | null>(null);

  const [character, setCharacter] = useState<Character>(null);
  /*
   * 썰 풀기. 질문을 하드코딩하지 않는다 — 사람이 상황을 쭉 적고(story), AI 가 빠진 것만 되묻는다(followups).
   * pending 은 지금 대답을 기다리는 질문, ready 는 "이제 대본을 만들어도 된다".
   */
  const [story, setStory] = useState("");
  const [followups, setFollowups] = useState<StoryQA[]>([]);
  const [pending, setPending] = useState("");
  const [ready, setReady] = useState(false);
  const [mood, setMood] = useState<string>("웃김");
  const [length, setLength] = useState<LengthKey>("normal");
  const [script, setScript] = useState<ReelScript | null>(null);

  /* 음성 엔진. Fish 키가 있으면 fish, Azure 키만 있으면 azure, 둘 다 없으면 null(자막만) */
  const [engine, setEngine] = useState<"fish" | "azure" | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<{ id: string; label: string }[]>([]);
  const [voiceMe, setVoiceMe] = useState<string>("");
  const [voiceOther, setVoiceOther] = useState<string>("");
  const [audio, setAudio] = useState<Record<string, string>>({});
  const [audioFrames, setAudioFrames] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch("/api/reels/character")
      .then((r) => r.json())
      .then((d) => d.ok && setCharacter(d.character))
      .catch(() => {});
    fetch("/api/reels/tts")
      .then((r) => r.json())
      .then(async (d) => {
        const eng = d.engine === "fish" || d.engine === "azure" ? d.engine : null;
        setEngine(eng);
        if (!eng) return;
        let options: { id: string; label: string }[] = VOICES.map((v) => ({ id: v.id, label: v.label }));
        if (eng === "fish") {
          const v = await (await fetch("/api/reels/voices")).json().catch(() => ({ voices: [] }));
          options = (v.voices ?? []).map((x: { id: string; title: string; uses: number }) => ({
            id: x.id,
            label: `${x.title} · ${x.uses.toLocaleString()}회`,
          }));
        }
        setVoiceOptions(options);
        // 고른 목소리는 이 브라우저에 남긴다. 매번 다시 고르기 번거롭다
        let saved: { me?: string; other?: string } = {};
        try {
          saved = JSON.parse(localStorage.getItem(`reels:voices:${eng}`) ?? "{}");
        } catch {
          /* 없으면 첫 목소리 */
        }
        setVoiceMe(saved.me || options[0]?.id || "");
        setVoiceOther(saved.other || options[1]?.id || options[0]?.id || "");
      })
      .catch(() => {});
    // 인터뷰는 출퇴근길에 나눠서 하기도 한다. 이 브라우저에만 남긴다
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
      if (d) {
        setStory(d.story ?? "");
        setFollowups(d.followups ?? []);
        setPending(d.pending ?? "");
        setReady(Boolean(d.ready));
        setScript(d.script ?? null);
        if (d.mood) setMood(d.mood);
        if (d.length) setLength(d.length);
      }
    } catch {
      /* 없으면 새로 */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ story, followups, pending, ready, script, mood, length }));
    } catch {
      /* 저장 못 해도 지금 화면에는 있다 */
    }
  }, [story, followups, pending, ready, script, mood, length]);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  }

  function resetAll() {
    Object.values(audio).forEach((u) => URL.revokeObjectURL(u));
    setStory("");
    setFollowups([]);
    setPending("");
    setReady(false);
    setScript(null);
    setAudio({});
    setAudioFrames({});
  }

  /** 다음에 물을 것 하나를 받는다. 충분하면 ready */
  async function askNext(nextFollowups: StoryQA[]) {
    setError("");
    setBusy({ key: "followup", msg: "읽고 있어요…" });
    try {
      const d = await (
        await fetch("/api/reels/followup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ story, followups: nextFollowups }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error ?? "다음 질문을 못 받았습니다.");
      if (d.done || nextFollowups.length >= MAX_FOLLOWUPS) {
        setPending("");
        setReady(true);
      } else {
        setPending(d.question);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function answerPending(a: string) {
    const next = [...followups, { q: pending, a: a.trim() }];
    setFollowups(next);
    setPending("");
    askNext(next);
  }

  async function makeScript() {
    setError("");
    setBusy({ key: "script", msg: "장면을 나누고 가명으로 바꾸는 중… 20초쯤" });
    try {
      const d = await (
        await fetch("/api/reels/script", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ story, followups, mood, length }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error ?? "대본을 못 만들었습니다.");
      Object.values(audio).forEach((u) => URL.revokeObjectURL(u));
      setAudio({});
      setAudioFrames({});
      setScript(d.script);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 줄마다 음성을 받아 길이를 잰다. 자막이 이 길이에 맞춰 뜬다 */
  async function makeVoices() {
    if (!script) return;
    setError("");
    const nextAudio: Record<string, string> = {};
    const nextFrames: Record<string, number> = {};
    const ctx = new AudioContext();
    try {
      const jobs = script.scenes.flatMap((s, si) => s.lines.map((l, li) => ({ key: lineKey(si, li), line: l })));
      for (let i = 0; i < jobs.length; i++) {
        setBusy({ key: "voice", msg: `목소리 만드는 중… ${i + 1}/${jobs.length}` });
        const { key, line } = jobs[i];
        const res = await fetch("/api/reels/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // 강조 표시(**)는 읽지 않는다
          body: JSON.stringify({ text: plainText(line.text), voice: line.speaker === "other" ? voiceOther : voiceMe, think: line.mode === "think" }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "음성을 못 만들었습니다.");
        const blob = await res.blob();
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        nextAudio[key] = URL.createObjectURL(blob);
        // 끝에 0.1초만 — 쇼츠는 문장 사이가 촘촘해야 이탈이 적다(조사: 문장 간 0.03~0.15초)
        nextFrames[key] = Math.ceil((buf.duration + 0.1) * FPS);
      }
      Object.values(audio).forEach((u) => URL.revokeObjectURL(u));
      setAudio(nextAudio);
      setAudioFrames(nextFrames);
      flash("목소리를 입혔습니다");
    } catch (e) {
      Object.values(nextAudio).forEach((u) => URL.revokeObjectURL(u));
      setError((e as Error).message);
    } finally {
      ctx.close();
      setBusy(null);
    }
  }

  // 고른 목소리를 엔진별로 기억한다
  useEffect(() => {
    if (!engine || !voiceMe) return;
    try {
      localStorage.setItem(`reels:voices:${engine}`, JSON.stringify({ me: voiceMe, other: voiceOther }));
    } catch {
      /* 저장 못 해도 지금 화면에는 있다 */
    }
  }, [engine, voiceMe, voiceOther]);

  function clearVoices() {
    Object.values(audio).forEach((u) => URL.revokeObjectURL(u));
    setAudio({});
    setAudioFrames({});
  }

  const timeline = useMemo(() => (script ? buildTimeline(script, audioFrames) : null), [script, audioFrames]);
  const inputProps = useMemo(
    () => (script ? { script, audioFrames, audio, character: character?.expressions ?? null } : null),
    [script, audioFrames, audio, character],
  );

  async function exportMp4() {
    if (!inputProps || !timeline) return;
    setError("");
    setBusy({ key: "export", msg: "영상 굽는 중… 0%" });
    try {
      // 렌더러는 무겁다. 누를 때만 불러온다
      const { renderMediaOnWeb, canRenderMediaOnWeb } = await import("@remotion/web-renderer");
      const check = await canRenderMediaOnWeb({ width: WIDTH, height: HEIGHT, container: "mp4" }).catch(() => null);
      if (check && !check.canRender) {
        throw new Error("이 브라우저는 영상을 구울 수 없습니다. PC 크롬에서 열어 주세요.");
      }
      const result = await renderMediaOnWeb({
        composition: {
          component: Reel,
          id: "reel",
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationInFrames: timeline.total,
          defaultProps: inputProps,
        },
        inputProps,
        container: "mp4",
        licenseKey: "free-license",
        onProgress: (p) => setBusy({ key: "export", msg: `영상 굽는 중… ${Math.round(p.progress * 100)}% — 이 탭을 떠나면 느려집니다` }),
      });
      const blob = await result.getBlob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(script?.title || "썰").replace(/[\\/:*?"<>|]/g, "").slice(0, 40)}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      flash("MP4 를 받았습니다");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const isBusy = Boolean(busy);
  const spin = (key: string) => busy?.key === key && <span className="spinner" />;
  const busyNote = (key: string) => (busy?.key === key && busy.msg ? <span className="hint">{busy.msg}</span> : null);
  const hasVoice = Object.keys(audio).length > 0;

  return (
    <div className="main">
      <h1 className="page-title">썰 릴스</h1>
      <p className="page-desc">
        겪은 일을 카톡처럼 물어보고, 애니 영상으로 만들어 줍니다. 받은 MP4 를 인스타에 올리고, 음악은 인스타 앱에서 붙이세요.
      </p>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="toast">{notice}</div>}

      <CharacterCard character={character} onSaved={setCharacter} flash={flash} setError={setError} />

      {/* ---------------- 1. 인터뷰 ---------------- */}
      <div className="card">
        <h2>
          1. 썰 풀기
          <Help text="그때 상황을 편하게 쭉 적으면, 빠진 것만 한두 개씩 되물어요(최대 5번). 상대가 실제로 한 말과 내 속마음을 적을수록 웃기고, 사소한 디테일이 많을수록 주작 소리를 덜 듣습니다. 실명·회사·가게 이름은 대본에서 가명으로 바뀝니다." />
        </h2>
        <StoryChat
          story={story}
          setStory={setStory}
          followups={followups}
          pending={pending}
          ready={ready}
          busy={busy?.key === "followup"}
          disabled={isBusy}
          onStart={() => askNext([])}
          onAnswer={answerPending}
          onSkipAll={() => {
            setPending("");
            setReady(true);
          }}
        />

        {ready && (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <div className="field">
                <label>분위기</label>
                <div className="seg">
                  {MOODS.map((m) => (
                    <button key={m} className={mood === m ? "on" : ""} onClick={() => setMood(m)}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>길이</label>
                <div className="seg">
                  {LENGTHS.map((l) => (
                    <button key={l.key} className={length === l.key ? "on" : ""} onClick={() => setLength(l.key)}>
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="row" style={{ alignItems: "center" }}>
              <button className="primary" onClick={makeScript} disabled={isBusy}>
                {spin("script")}
                {script ? "대본 다시 만들기" : "대본 만들기"}
              </button>
              {busyNote("script")}
              <button className="ghost" onClick={resetAll} disabled={isBusy}>
                새 썰
              </button>
            </div>
          </>
        )}
      </div>

      {/* ---------------- 2. 대본 ---------------- */}
      {script && (
        <div className="card">
          <h2>
            2. 대본
            <Help text="고치면 미리보기에 바로 반영됩니다. 글을 고쳤다면 목소리를 다시 만드세요." />
          </h2>
          {script.masked.length > 0 && (
            <div className="alert warn">
              <strong>가명으로 바꾼 것</strong> — 특정될 만한 게 남았는지 확인하세요
              <ul>
                {script.masked.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="field">
            <label>제목 (영상 위에 계속 떠 있어요)</label>
            <input value={script.title} onChange={(e) => setScript({ ...script, title: e.target.value })} />
          </div>
          <ScriptEditor script={script} setScript={(s) => { setScript(s); clearVoices(); }} />
        </div>
      )}

      {/* ---------------- 3. 목소리 · 미리보기 · 받기 ---------------- */}
      {script && inputProps && timeline && (
        <div className="card">
          <h2>
            3. 미리보기와 받기
            <Help text="목소리는 Fish Audio 한국어 음성입니다(키가 없으면 Azure, 둘 다 없으면 자막만). Fish 는 같은 문장도 매번 조금씩 다르게 나오니 마음에 안 들면 다시 입히세요. AI 음성을 쓰면 업로드할 때 인스타의 'AI 정보' 표시를 켜세요." />
          </h2>

          {engine ? (
            <div className="row" style={{ alignItems: "flex-end" }}>
              <VoicePicker label="내 목소리 (나·자막)" engine={engine} options={voiceOptions} value={voiceMe} onChange={setVoiceMe} setError={setError} />
              <VoicePicker label="상대 목소리" engine={engine} options={voiceOptions} value={voiceOther} onChange={setVoiceOther} setError={setError} />
              <button onClick={makeVoices} disabled={isBusy || !voiceMe}>
                {spin("voice")}
                {hasVoice ? "목소리 다시 입히기" : "목소리 입히기"}
              </button>
              {hasVoice && (
                <button className="ghost" onClick={clearVoices} disabled={isBusy}>
                  자막만으로
                </button>
              )}
              {busyNote("voice")}
            </div>
          ) : (
            <p className="hint">목소리 없이 자막만으로 만듭니다. 설정 → Fish Audio 에 키를 넣으면 목소리를 입힐 수 있어요.</p>
          )}

          <div style={{ maxWidth: 320, margin: "16px auto" }}>
            <Player
              component={Reel}
              inputProps={inputProps}
              durationInFrames={timeline.total}
              fps={FPS}
              compositionWidth={WIDTH}
              compositionHeight={HEIGHT}
              style={{ width: "100%", borderRadius: 16, overflow: "hidden" }}
              controls
              acknowledgeRemotionLicense
            />
          </div>
          <p className="hint" style={{ textAlign: "center" }}>
            {(timeline.total / FPS).toFixed(1)}초 · 장면 {script.scenes.length}개{hasVoice ? " · 목소리 있음" : " · 자막만"}
          </p>

          <div className="row" style={{ alignItems: "center" }}>
            <button className="primary" onClick={exportMp4} disabled={isBusy}>
              {spin("export")}
              MP4 받기
            </button>
            {busyNote("export") ?? <span className="hint">PC 크롬에서 눌러 주세요. 휴대폰은 미리보기만 됩니다.</span>}
          </div>

          <h3>올릴 때</h3>
          <div className="prompt-box">{`${script.caption}\n\n${script.hashtags.join(" ")}`}</div>
          <button onClick={() => copyText(`${script.caption}\n\n${script.hashtags.join(" ")}`).then(() => flash("캡션 복사됨"))}>
            캡션 복사
          </button>
          <ul className="check" style={{ marginTop: 12 }}>
            <li>음악은 인스타 앱에서 붙였는가 (영상에는 BGM 이 없습니다)</li>
            <li>AI 음성을 썼다면 업로드 화면의 &quot;AI 정보&quot; 를 켰는가</li>
            <li>회사·동료가 특정될 만한 디테일이 남지 않았는가</li>
          </ul>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 목소리 고르기
 * ------------------------------------------------------------------ */

/** 목록에서 고르거나(Fish 공개 목소리·Azure 음성), Fish 면 내 클론 ID 를 직접 넣는다. 들어보기로 미리 듣는다 */
function VoicePicker({
  label,
  engine,
  options,
  value,
  onChange,
  setError,
}: {
  label: string;
  engine: "fish" | "azure";
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  setError: (m: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const custom = engine === "fish" && value !== "" && !options.some((o) => o.id === value);

  async function preview() {
    setError("");
    setPlaying(true);
    try {
      const res = await fetch("/api/reels/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "아 진짜 그날 생각하면 아직도 어이가 없어.", voice: value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "미리 듣기에 실패했습니다.");
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlaying(false);
    }
  }

  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ alignItems: "center", gap: 6 }}>
        <select value={custom ? "__custom" : value} onChange={(e) => onChange(e.target.value === "__custom" ? " " : e.target.value)} style={{ maxWidth: 260 }}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          {engine === "fish" && <option value="__custom">내 클론 ID 직접 입력</option>}
        </select>
        <button className="small ghost" onClick={preview} disabled={playing || !value.trim()}>
          {playing && <span className="spinner" />}들어보기
        </button>
      </div>
      {custom && (
        <input
          className="mono"
          style={{ marginTop: 6 }}
          placeholder="fish.audio 목소리 ID (32자리)"
          value={value.trim()}
          onChange={(e) => onChange(e.target.value.trim() || " ")}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 주인공
 * ------------------------------------------------------------------ */

function CharacterCard({
  character,
  onSaved,
  flash,
  setError,
}: {
  character: Character;
  onSaved: (c: Character) => void;
  flash: (m: string) => void;
  setError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [look, setLook] = useState("");
  const [pieces, setPieces] = useState<Partial<Record<ExpressionKey, string>> | null>(null);
  const [busy, setBusy] = useState("");
  const ready = character && Object.keys(character.expressions).length >= EXPRESSIONS.length;

  useEffect(() => {
    if (character?.look) setLook(character.look);
    if (!ready) setOpen(true);
  }, [character, ready]);

  /** 시트 한 장을 2×4 칸으로 잘라 표정마다 누끼를 딴다. 칸 순서가 곧 표정 순서다 */
  async function cut(file: File | undefined) {
    if (!file) return;
    setError("");
    setBusy("cut");
    try {
      const src = await fileToRaster(file);
      const grid = splitGrid(src, 2, 4, 12, { tolerance: 30 });
      if (grid.length !== EXPRESSIONS.length) {
        throw new Error(`칸 ${grid.length}개를 찾았습니다. 8개(2줄 × 4칸)여야 합니다 — 시트를 다시 뽑아 주세요.`);
      }
      const out: Partial<Record<ExpressionKey, string>> = {};
      for (const g of grid) {
        const canvas = rasterToCanvas(g.image);
        const scale = Math.min(1, EXPR_EDGE / Math.max(canvas.width, canvas.height));
        const small = document.createElement("canvas");
        small.width = Math.round(canvas.width * scale);
        small.height = Math.round(canvas.height * scale);
        const ctx = small.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(canvas, 0, 0, small.width, small.height);
        out[EXPRESSIONS[g.cell].key] = small.toDataURL("image/png");
      }
      setPieces(out);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function save() {
    if (!pieces) return;
    setBusy("save");
    try {
      const d = await (
        await fetch("/api/reels/character", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ look, expressions: pieces }),
        })
      ).json();
      if (!d.ok) throw new Error(d.error);
      onSaved(d.character);
      setPieces(null);
      setOpen(false);
      flash("주인공을 저장했습니다");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const shown = pieces ?? character?.expressions ?? null;

  return (
    <div className="card">
      <h2>
        0. 주인공
        <Help text="모든 영상에 같은 생김새로 나옵니다. 주인공이 나오는 장면에만 등장하고, 다른 인물은 이름표 달린 말풍선으로만 나옵니다." />
      </h2>
      {shown && (
        <div className="expr-strip">
          {EXPRESSIONS.map((e) => (
            <figure key={e.key}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {shown[e.key] ? <img src={shown[e.key]} alt={e.label} /> : <div className="expr-empty" />}
              <figcaption>{e.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {!open ? (
        <button className="ghost small" onClick={() => setOpen(true)}>
          주인공 바꾸기
        </button>
      ) : (
        <>
          <div className="field">
            <label>내 모습 (영어·한국어 모두 됨)</label>
            <input placeholder="짧은 단발, 동그란 안경, 회색 후드티" value={look} onChange={(e) => setLook(e.target.value)} />
          </div>
          <pre className="prompt-box">{characterSheetPrompt(look)}</pre>
          <div className="row" style={{ alignItems: "center" }}>
            <button onClick={() => copyText(characterSheetPrompt(look)).then(() => flash("시트 프롬프트 복사됨"))}>프롬프트 복사</button>
            <span className="hint">ChatGPT 에 붙여 넣고 받은 한 장을 아래에 올리세요</span>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>받은 표정 시트</label>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => cut(e.target.files?.[0])} />
          </div>
          {busy === "cut" && (
            <p className="hint">
              <span className="spinner" /> 칸마다 자르는 중…
            </p>
          )}
          <div className="row">
            <button className="primary" onClick={save} disabled={!pieces || Boolean(busy)}>
              {busy === "save" && <span className="spinner" />}이 얼굴로 고정
            </button>
            {ready && (
              <button className="ghost" onClick={() => { setPieces(null); setOpen(false); }}>
                닫기
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 썰 풀기 — 쭉 적고, 빠진 것만 되묻는다
 * ------------------------------------------------------------------ */

function StoryChat({
  story,
  setStory,
  followups,
  pending,
  ready,
  busy,
  disabled,
  onStart,
  onAnswer,
  onSkipAll,
}: {
  story: string;
  setStory: (s: string) => void;
  followups: StoryQA[];
  pending: string;
  ready: boolean;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
  onAnswer: (a: string) => void;
  onSkipAll: () => void;
}) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const started = followups.length > 0 || Boolean(pending) || ready;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [followups.length, pending, ready]);

  // 아직 시작 전: 쭉 적는 칸
  if (!started) {
    return (
      <div className="talk">
        <div className="talk-log">
          <div className="talk-row bot">
            <div className="talk-avatar">썰</div>
            <div className="talk-bubble">
              그때 무슨 일 있었는지 편하게 쭉 적어줘! 누가 뭐라고 했는지, 너는 속으로 뭐라고 생각했는지까지 적으면 최고 🙌
            </div>
          </div>
        </div>
        <div className="talk-input">
          <textarea
            rows={7}
            style={{ width: "100%" }}
            placeholder={"예) 입사 3일차 월요일 아침에 동기한테 팀장님 욕을 카톡으로 보낸다는 게 팀 단톡방에 보냄.\n팀장님이 조용히 부르더니 \"○○씨, 이거 나한테 한 말이야?\" 하심.\n입으로는 \"아 아닙니다!\" 했는데 속으로는 '끝났다' 싶었음…"}
            value={story}
            onChange={(e) => setStory(e.target.value)}
          />
          <div className="row" style={{ alignItems: "center", marginTop: 8 }}>
            <button className="primary" onClick={onStart} disabled={disabled || story.trim().length < 20}>
              {busy && <span className="spinner" />}다 적었어
            </button>
            <span className="hint">{story.trim().length < 20 ? "조금만 더 적어줘 (20자 이상)" : `${story.trim().length}자`}</span>
          </div>
        </div>
      </div>
    );
  }

  const send = () => {
    if (!input.trim()) return;
    onAnswer(input);
    setInput("");
  };

  return (
    <div className="talk">
      <div className="talk-log">
        <div className="talk-row me">
          <div className="talk-bubble">{story}</div>
        </div>
        {followups.map((f, i) => (
          <div key={i}>
            <div className="talk-row bot">
              <div className="talk-avatar">썰</div>
              <div className="talk-bubble">{f.q}</div>
            </div>
            <div className="talk-row me" style={{ marginTop: 8 }}>
              <div className="talk-bubble">{f.a || "(건너뜀)"}</div>
            </div>
          </div>
        ))}
        {pending && (
          <div className="talk-row bot">
            <div className="talk-avatar">썰</div>
            <div className="talk-bubble">{pending}</div>
          </div>
        )}
        {busy && (
          <div className="talk-row bot">
            <div className="talk-avatar">썰</div>
            <div className="talk-bubble">
              <span className="spinner" />
            </div>
          </div>
        )}
        {ready && !busy && (
          <div className="talk-row bot">
            <div className="talk-avatar">썰</div>
            <div className="talk-bubble">좋아, 이 정도면 충분해! 분위기랑 길이 고르고 대본 만들어 보자 🙌</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {pending && !busy && (
        <div className="talk-input">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <textarea
              rows={2}
              style={{ flex: 1, minWidth: 200 }}
              placeholder="편하게 적어줘"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // 한글 조합 중 엔터는 글자를 확정하는 것이지 보내는 게 아니다
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="primary" onClick={send} disabled={!input.trim()}>
              보내기
            </button>
            <button className="ghost" onClick={() => onAnswer("")}>
              기억 안 나
            </button>
          </div>
          <button className="ghost small" onClick={onSkipAll} style={{ marginTop: 6 }}>
            그만 묻고 대본 만들기 →
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 대본 편집
 * ------------------------------------------------------------------ */

const KIND_LABEL: Record<string, string> = { hook: "훅", scene: "장면", chat: "메신저", ending: "엔딩" };
const SPEAKER_LABEL: Record<string, string> = { me: "나", other: "상대", narrator: "자막" };

function ScriptEditor({ script, setScript }: { script: ReelScript; setScript: (s: ReelScript) => void }) {
  const update = (si: number, fn: (s: ReelScript["scenes"][number]) => ReelScript["scenes"][number]) =>
    setScript({ ...script, scenes: script.scenes.map((s, i) => (i === si ? fn(s) : s)) });

  return (
    <div>
      {script.scenes.map((s, si) => (
        <div key={si} className="list-item">
          <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
            <span className="tag">
              {si + 1}. {KIND_LABEL[s.kind]}
            </span>
            {s.place && <span className="hint">📍 {s.place}</span>}
            <select
              value={s.expression}
              onChange={(e) => update(si, (x) => ({ ...x, expression: e.target.value as ExpressionKey | "none" }))}
              style={{ marginLeft: "auto" }}
            >
              <option value="none">주인공 안 나옴</option>
              {EXPRESSIONS.map((e) => (
                <option key={e.key} value={e.key}>
                  주인공: {e.label}
                </option>
              ))}
            </select>
          </div>
          {s.lines.map((l, li) => (
            <div key={li} className="row" style={{ alignItems: "center", marginBottom: 6 }}>
              <span className="hint" style={{ minWidth: 70 }}>
                {l.speaker === "other" ? l.name || "상대" : SPEAKER_LABEL[l.speaker]}
                {l.mode === "think" ? " (속)" : ""}
              </span>
              <input
                style={{ flex: 1, minWidth: 200 }}
                value={l.text}
                onChange={(e) =>
                  update(si, (x) => ({ ...x, lines: x.lines.map((y, j) => (j === li ? { ...y, text: e.target.value } : y)) }))
                }
              />
            </div>
          ))}
          {s.kind === "chat" &&
            s.chat.map((m, mi) => (
              <div key={mi} className="row" style={{ alignItems: "center", marginBottom: 6 }}>
                <span className="hint" style={{ minWidth: 70 }}>
                  💬 {m.from === "me" ? "나" : s.chatWith || "상대"}
                </span>
                <input
                  style={{ flex: 1, minWidth: 200 }}
                  value={m.text}
                  onChange={(e) =>
                    update(si, (x) => ({ ...x, chat: x.chat.map((y, j) => (j === mi ? { ...y, text: e.target.value } : y)) }))
                  }
                />
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
