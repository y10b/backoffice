"use client";

import { AbsoluteFill, Img, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { loadFont } from "@remotion/google-fonts/NotoSansKR";
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

const { fontFamily } = loadFont("normal", { weights: ["700", "900"], ignoreTooManyRequestsWarning: true });

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
const OUTLINE = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  return `${(Math.cos(a) * 7).toFixed(1)}px ${(Math.sin(a) * 7).toFixed(1)}px 0 #111`;
}).join(", ");

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
        fontSize: 54,
        fontWeight: 900,
        lineHeight: 1.25,
        textAlign: "center",
        wordBreak: "keep-all",
      }}
    >
      {title}
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
            left: 540 - 260,
            top: 900,
            width: 520,
            height: 520,
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
        top: 470,
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

  // 훅·엔딩·내레이션은 화면 가운데 큰 자막. 흰 글자 + 검은 외곽선이 썰툰 자막의 표준이다
  if (line.speaker === "narrator" || kind === "hook" || kind === "ending") {
    const big = kind === "hook" || kind === "ending";
    return (
      <div
        style={{
          position: "absolute",
          left: 70,
          right: 170,
          top: hasCharacter ? 640 : big ? 820 : 760,
          textAlign: "center",
          fontSize: big ? 92 : 70,
          fontWeight: 900,
          lineHeight: 1.25,
          color: "#fff",
          // 외곽선. -webkit-text-stroke 는 브라우저 렌더에서 글자 안쪽까지 덮어 지저분해져서, 그림자를 둘러 만든다
          textShadow: OUTLINE,
          wordBreak: "keep-all",
          transform: `scale(${0.85 + pop * 0.15})`,
        }}
      >
        {line.text}
      </div>
    );
  }

  const me = line.speaker === "me";
  const think = line.mode === "think";
  return (
    <div
      style={{
        position: "absolute",
        top: hasCharacter ? 610 : 760,
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
        <div style={{ fontSize: 36, fontWeight: 900, marginBottom: 10, color: dark ? "#fff" : INK }}>{line.name}</div>
      )}
      {me && think && <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 8, opacity: 0.7 }}>(속마음)</div>}
      <div
        style={{
          padding: "26px 34px",
          borderRadius: 40,
          background: think ? "rgba(255,255,255,0.55)" : me ? "#C9F2E3" : "#fff",
          border: think ? "4px dashed rgba(0,0,0,0.35)" : "4px solid #111",
          color: INK,
          fontSize: 60,
          fontWeight: think ? 700 : 900,
          fontStyle: think ? "italic" : "normal",
          lineHeight: 1.3,
          wordBreak: "keep-all",
          boxShadow: think ? "none" : "0 8px 0 #111",
        }}
      >
        {line.text}
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
