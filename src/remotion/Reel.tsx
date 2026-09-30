"use client";

import { AbsoluteFill, Img, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { loadFont as loadNoto } from "@remotion/google-fonts/NotoSansKR";
import { loadFont as loadBlackHan } from "@remotion/google-fonts/BlackHanSans";
import { loadFont as loadJua } from "@remotion/google-fonts/Jua";
import { loadFont as loadGaegu } from "@remotion/google-fonts/Gaegu";
import { loadFont as loadBagel } from "@remotion/google-fonts/BagelFatOne";
import {
  CHAT_STEP,
  buildTimeline,
  type ExpressionKey,
  type ReelLine,
  type ReelScript,
  type TimedScene,
} from "@/lib/reelScript";

/**
 * 썰 릴스 한 편. 미리보기(@remotion/player)와 브라우저 렌더(@remotion/web-renderer)가 같은 컴포넌트를 쓴다.
 *
 * 브라우저 렌더의 제약 안에서 짰다 — z-index·backdrop-filter·mix-blend-mode 를 쓰지 않고, 겹침은
 * DOM 순서로 정한다. 글꼴은 CSS @font-face 가 아니라 @remotion/google-fonts 로 불러야 영상에 박힌다.
 *
 * 화면 배치는 릴스 세이프존(위 약 250px, 아래 약 480px, 오른쪽 약 150px 을 UI 가 덮는다) 안에 둔다.
 * 핵심 자막·말풍선은 y 300~1450, x 60~930.
 */

/*
 * 글꼴은 썰툰·쇼츠에서 많이 쓰는 조합(2026-10 조사). 전부 OFL 이라 영상에 넣어도 된다.
 *   제목  검은고딕(Black Han Sans)   자막·말풍선  주아(Jua)   속마음  개구(Gaegu, 손글씨)
 *   효과음 베이글(Bagel Fat One)     메신저 화면  Noto Sans KR
 */
const opt = { ignoreTooManyRequestsWarning: true } as const;
const NOTO = loadNoto("normal", { weights: ["500", "700"], ...opt }).fontFamily;
const TITLE_FONT = loadBlackHan("normal", opt).fontFamily;
const CAPTION_FONT = loadJua("normal", opt).fontFamily;
const THINK_FONT = loadGaegu("normal", { weights: ["700"], ...opt }).fontFamily;
const SFX_FONT = loadBagel("normal", opt).fontFamily;
const fontFamily = CAPTION_FONT;

/** 강조색. 대본에서 **단어** 로 감싼 곳만 */
const HIGHLIGHT = "#FFE14D";

/** "**단어**" 를 강조 조각으로 나눈다 */
function Emph({ text, color }: { text: string; color: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <span key={i} style={{ color }}>
            {p.slice(2, -2)}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export type ReelProps = {
  script: ReelScript;
  /** 줄 키 → 음성 프레임 수. 비면 글자 수로 길이를 정한다 */
  audioFrames: Record<string, number>;
  /** 줄 키 → 음성 주소(blob:). 비면 무음 */
  audio: Record<string, string>;
  /** 표정 → PNG. 없으면 주인공 자리를 비운다 */
  character: Partial<Record<ExpressionKey, string>> | null;
};

/** 분위기마다 배경 두 색. 밝은 파스텔 위에 어두운 글자가 기본이다 */
const PALETTE: Record<string, [string, string]> = {
  웃김: ["#FFF4D6", "#FFD9E0"],
  억울: ["#E3ECFF", "#D7D2FF"],
  설렘: ["#FFE3EF", "#FFF0D9"],
  소름: ["#2B2D42", "#4A3F6B"],
};

const INK = "#1B1B1F";

/** 흰 글자에 두르는 검은 외곽선. 16방향 그림자를 겹쳐 두께 약 7px 로 만든다 */
const ring = (r: number) =>
  Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return `${(Math.cos(a) * r).toFixed(1)}px ${(Math.sin(a) * r).toFixed(1)}px 0 #111`;
  }).join(", ");
const OUTLINE = ring(6);
/** 효과음 글자는 더 두껍게 */
const OUTLINE_THICK = ring(10);

export function Reel({ script, audioFrames, audio, character }: ReelProps) {
  const { scenes } = buildTimeline(script, audioFrames);
  const [c1, c2] = PALETTE[script.mood] ?? PALETTE["웃김"];
  const dark = script.mood === "소름";

  return (
    <AbsoluteFill style={{ fontFamily, background: `linear-gradient(180deg, ${c1} 0%, ${c2} 100%)`, color: dark ? "#fff" : INK }}>
      {scenes.map((ts) => (
        <Sequence key={ts.index} from={ts.from} durationInFrames={ts.frames} layout="none">
          <SceneView ts={ts} audio={audio} character={character} dark={dark} />
        </Sequence>
      ))}
      {/* 제목은 영상 내내. 상위 썰툰 계정들이 쓰는 방식이다 — 중간에 들어온 사람도 무슨 얘기인지 안다 */}
      <TitleBar title={script.title} />
    </AbsoluteFill>
  );
}

function TitleBar({ title }: { title: string }) {
  if (!title) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 290,
        left: 70,
        right: 170,
        padding: "22px 34px",
        borderRadius: 36,
        background: "rgba(20,20,24,0.88)",
        color: "#fff",
        fontFamily: TITLE_FONT,
        fontSize: 60,
        lineHeight: 1.2,
        textAlign: "center",
        wordBreak: "keep-all",
      }}
    >
      {title.replace(/\*\*/g, "")}
    </div>
  );
}

function SceneView({
  ts,
  audio,
  character,
  dark,
}: {
  ts: TimedScene;
  audio: Record<string, string>;
  character: ReelProps["character"];
  dark: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scene } = ts;

  // 장면 들어올 때 살짝 튀어 오른다. 1.5~3초마다 화면이 바뀌어야 이탈이 적다(조사)
  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 160 } });
  const shake = scene.effect === "shake" && frame < 12 ? Math.sin(frame * 2.3) * 14 * (1 - frame / 12) : 0;
  const zoom = scene.effect === "zoom" ? interpolate(frame, [0, ts.frames], [1, 1.08], { extrapolateRight: "clamp" }) : 1;

  const showMe = scene.expression !== "none" && character?.[scene.expression as ExpressionKey];
  const current = ts.lines.find((l) => frame >= l.from && frame < l.from + l.frames) ?? ts.lines[ts.lines.length - 1];
  const meTalking = current?.line.speaker === "me" && frame < (current?.from ?? 0) + (current?.frames ?? 0);

  return (
    <AbsoluteFill style={{ transform: `translateX(${shake}px) scale(${zoom})` }}>
      {scene.place && <PlaceChip text={scene.place} dark={dark} />}

      {/* 주인공. 말하는 동안 살짝 들썩인다 — 입 모양 대신 몸짓으로 "말하는 중" 을 보인다 */}
      {showMe && (
        <Img
          src={character![scene.expression as ExpressionKey]!}
          style={{
            position: "absolute",
            left: 540 - 270,
            top: 760,
            width: 540,
            height: 540,
            objectFit: "contain",
            transform: `translateY(${(1 - enter) * 120 + (meTalking ? Math.abs(Math.sin(frame / 3)) * -10 : 0)}px) scale(${0.9 + enter * 0.1})`,
          }}
        />
      )}

      {scene.kind === "chat" ? (
        <Sequence from={ts.chatFrom} layout="none">
          <ChatView withName={scene.chatWith} messages={scene.chat} />
        </Sequence>
      ) : null}

      {ts.lines.map((tl, i) => {
        // 마지막 줄은 장면이 끝날 때까지 남긴다. 안 그러면 엔딩의 여운 구간이 빈 화면이 된다
        const last = i === ts.lines.length - 1;
        return (
          <Sequence key={tl.key} from={tl.from} durationInFrames={last ? ts.frames - tl.from : tl.frames} layout="none">
            {audio[tl.key] && <Audio src={audio[tl.key]} />}
            <LineView line={tl.line} kind={scene.kind} hasCharacter={Boolean(showMe)} dark={dark} />
          </Sequence>
        );
      })}

      {scene.sfx && <SfxPop text={scene.sfx} />}

      {scene.effect === "flash" && (
        <AbsoluteFill style={{ background: "#fff", opacity: interpolate(frame, [0, 8], [0.9, 0], { extrapolateRight: "clamp" }) }} />
      )}
    </AbsoluteFill>
  );
}

function PlaceChip({ text, dark }: { text: string; dark: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 440,
        left: 0,
        right: 150,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          padding: "10px 26px",
          borderRadius: 999,
          background: dark ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.75)",
          fontSize: 38,
          fontWeight: 700,
        }}
      >
        📍 {text}
      </div>
    </div>
  );
}

/** 대사 한 줄. 누가 말하느냐에 따라 자리·모양이 다르다 */
function LineView({ line, kind, hasCharacter, dark }: { line: ReelLine; kind: string; hasCharacter: boolean; dark: boolean }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 220 } });

  /*
   * 내레이션은 화면 아래쪽(세로 68~75%) 자막 — 썰 쇼츠의 표준 자리다. 캐릭터와 겹치지 않고,
   * 그 아래 릴스 버튼·캡션 영역(하단 약 20%)에도 걸리지 않는다. 훅·엔딩은 주인공이 없으면
   * 가운데에 더 크게 띄운다.
   */
  if (line.speaker === "narrator" || kind === "hook" || kind === "ending") {
    const big = kind === "hook" || kind === "ending";
    const center = big && !hasCharacter;
    return (
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 170,
          top: center ? 780 : 1310,
          textAlign: "center",
          fontFamily: CAPTION_FONT,
          fontSize: center ? 96 : big ? 80 : 70,
          lineHeight: 1.25,
          letterSpacing: -2,
          color: "#fff",
          // 외곽선. -webkit-text-stroke 는 브라우저 렌더에서 글자 안쪽까지 덮어 지저분해져서, 그림자를 둘러 만든다
          textShadow: `${OUTLINE}, 0 6px 0 rgba(0,0,0,0.35)`,
          wordBreak: "keep-all",
          transform: `scale(${0.85 + pop * 0.15})`,
        }}
      >
        <Emph text={line.text} color={HIGHLIGHT} />
      </div>
    );
  }

  const me = line.speaker === "me";
  const think = line.mode === "think";
  return (
    <div
      style={{
        position: "absolute",
        top: hasCharacter ? 520 : 700,
        left: me ? 200 : 70,
        right: me ? 170 : 300,
        display: "flex",
        flexDirection: "column",
        alignItems: me ? "flex-end" : "flex-start",
        transform: `translateY(${(1 - pop) * 40}px)`,
        opacity: pop,
      }}
    >
      {!me && line.name && (
        <div
          style={{
            fontFamily: NOTO,
            fontSize: 32,
            fontWeight: 700,
            marginBottom: 10,
            padding: "6px 18px",
            borderRadius: 999,
            background: "#5B5BD6",
            color: "#fff",
          }}
        >
          {line.name}
        </div>
      )}
      <div
        style={{
          padding: "26px 34px",
          borderRadius: think ? 60 : 40,
          background: think ? "rgba(255,255,255,0.7)" : me ? "#FFF3B8" : "#fff",
          border: think ? "4px dashed rgba(0,0,0,0.4)" : "4px solid #111",
          color: INK,
          // 속마음은 손글씨로 살짝 기울여 — 만화에서 속으로 하는 말의 관습이다
          fontFamily: think ? THINK_FONT : CAPTION_FONT,
          fontSize: think ? 64 : 58,
          fontWeight: think ? 700 : 400,
          lineHeight: 1.3,
          wordBreak: "keep-all",
          boxShadow: think ? "none" : "0 8px 0 #111",
          transform: think ? "rotate(-3deg)" : undefined,
        }}
      >
        {think ? "(" : ""}
        <Emph text={line.text} color={think ? "#C2410C" : "#E8590C"} />
        {think ? ")" : ""}
      </div>
    </div>
  );
}

/**
 * 메신저 화면. 카카오톡을 그대로 따라 하지 않는다 — 노란 헤더·로고·기본 프로필을 베끼면 상표·
 * 트레이드드레스 위험이 있어, "메신저 느낌" 만 주는 자체 디자인(라벤더 헤더, 민트 말풍선)으로 간다.
 */
function ChatView({ withName, messages }: { withName: string; messages: { from: "me" | "other"; text: string }[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shown = Math.min(messages.length, Math.floor(frame / CHAT_STEP) + 1);
  const typing = shown < messages.length && messages[shown]?.from === "other";

  return (
    <div
      style={{
        position: "absolute",
        left: 80,
        right: 170,
        top: 470,
        height: 940,
        borderRadius: 48,
        background: "#F4F2FA",
        border: "5px solid #111",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        fontFamily: NOTO,
      }}
    >
      <div style={{ padding: "26px 32px", background: "#CFC6F2", fontSize: 44, fontWeight: 900, color: INK }}>
        ‹ {withName || "대화"}
      </div>
      <div style={{ flex: 1, padding: "26px 28px", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 18 }}>
        {messages.slice(0, shown).map((m, i) => {
          const pop = spring({ frame: frame - i * CHAT_STEP, fps, config: { damping: 14, stiffness: 240 } });
          const me = m.from === "me";
          return (
            <div key={i} style={{ display: "flex", justifyContent: me ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 12 }}>
              {!me && (
                <div
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 22,
                    background: "#B8B0E0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 32,
                    fontWeight: 900,
                  }}
                >
                  {(withName || "상")[0]}
                </div>
              )}
              <div
                style={{
                  maxWidth: 560,
                  padding: "18px 26px",
                  borderRadius: 30,
                  background: me ? "#BFEFDC" : "#fff",
                  color: INK,
                  fontSize: 44,
                  fontWeight: 700,
                  lineHeight: 1.3,
                  wordBreak: "keep-all",
                  transform: `scale(${0.6 + pop * 0.4})`,
                  opacity: pop,
                }}
              >
                {m.text}
              </div>
            </div>
          );
        })}
        {typing && (
          <div style={{ fontSize: 44, fontWeight: 900, opacity: 0.5 }}>{".".repeat((Math.floor(frame / 6) % 3) + 1)}</div>
        )}
      </div>
    </div>
  );
}

/**
 * 효과음 글자("쾅", "띠용"). 장면이 시작될 때 크게 튀어나왔다 사라진다 — 0.5초 안에 0→1.2→1, 1초 뒤 사라짐.
 * 한 편에 2~4번만 쓰도록 대본이 정한다.
 */
function SfxPop({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 8, stiffness: 260 } });
  const fade = interpolate(frame, [fps * 1.1, fps * 1.4], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (fade <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        right: 190,
        top: 690,
        fontFamily: SFX_FONT,
        fontSize: 150,
        color: HIGHLIGHT,
        textShadow: OUTLINE_THICK,
        transform: `rotate(-10deg) scale(${pop * 1.1})`,
        opacity: fade,
      }}
    >
      {text}
    </div>
  );
}
