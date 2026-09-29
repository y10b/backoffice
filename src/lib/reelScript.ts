/**
 * 썰 릴스 — 화면·서버·영상(Remotion)이 함께 쓰는 형식과 규칙.
 *
 * 서버 의존성이 없어야 한다. 인터뷰 화면, 대본을 만드는 API, 브라우저에서 도는 Remotion
 * 컴포지션이 모두 이 파일을 import 한다.
 *
 *   카톡식 인터뷰(INTERVIEW) → 대본(ReelScript, GPT) → 음성(Azure, 줄마다 한 클립)
 *   → 타임라인(buildTimeline) → 미리보기(Player) → MP4(브라우저 렌더)
 *
 * 형식과 길이 규칙은 2026-09 조사(썰툰 계정 15곳)를 따른다: 20~40초, 첫 2초 훅, 1.5~3초마다
 * 화면 변화, 자막 한 줄 12~16자·최대 2줄, 겉말/속마음 대비, 자조 섞인 엔딩 + 참여 질문.
 */

/* ------------------------------------------------------------------ *
 * 주인공 표정
 * ------------------------------------------------------------------ */

/** 표정 8종. 캐릭터 시트는 이 순서대로 2행 × 4열로 그린다 */
export const EXPRESSIONS = [
  { key: "neutral", label: "기본", prompt: "neutral calm face" },
  { key: "flustered", label: "당황", prompt: "flustered, wide eyes, small sweat drop" },
  { key: "angry", label: "분노", prompt: "angry, puffed cheeks, furrowed brows" },
  { key: "blank", label: "멍", prompt: "blank stare, dot eyes, spaced out" },
  { key: "crying", label: "울음", prompt: "crying with tears streaming" },
  { key: "laughing", label: "웃음", prompt: "laughing with eyes closed" },
  { key: "sweating", label: "식은땀", prompt: "nervous, cold sweat, forced smile" },
  { key: "zen", label: "해탈", prompt: "resigned, peaceful half-closed eyes, soul leaving" },
] as const;
export type ExpressionKey = (typeof EXPRESSIONS)[number]["key"];
export const EXPRESSION_KEYS = EXPRESSIONS.map((e) => e.key) as ExpressionKey[];

/**
 * 주인공 표정 시트 프롬프트. ChatGPT 에 붙여 넣고 받은 한 장을 칸마다 잘라 쓴다.
 * 격자선을 그리면 선이 같이 잘려 나오니 막고, 누끼가 되게 흰 배경을 강제한다.
 */
export function characterSheetPrompt(look: string): string {
  const cells = EXPRESSIONS.map((e, i) => `${i + 1}. ${e.prompt}`).join("; ");
  return (
    `A character expression sheet of ONE original chibi anime-style character, upper body, facing the viewer. ` +
    `Character: ${look.trim() || "a Korean office worker in their mid-20s"}. ` +
    `Draw exactly 8 expressions of the SAME character in a 2-row by 4-column grid, left to right, top to bottom: ${cells}. ` +
    "Identical hairstyle, outfit, colors and proportions in every cell; only the face and small effects change. " +
    "Flat 2D cel shading, clean thick dark outline, soft pastel colors. " +
    "Each drawing sits alone in the center of its own equal cell with wide empty white gaps; nothing touches or crosses into a neighboring cell. " +
    "Solid pure white background (#FFFFFF) everywhere. No grid lines, no borders, no text, no labels, no numbers, no speech bubbles, no shadows on the ground. " +
    "Do not resemble any existing anime, webtoon or celebrity. Wide landscape image at the highest resolution available."
  );
}

/* ------------------------------------------------------------------ *
 * 인터뷰
 * ------------------------------------------------------------------ */

export type InterviewQuestion = {
  id: string;
  ask: string;
  /** 누르면 그대로 답이 되는 버튼 */
  chips?: string[];
  /** 버튼이 답이 아니라 머리말이다 — 누르면 입력칸에 "회사: " 처럼 채우고 이어 쓰게 한다 */
  chipsPrefix?: boolean;
  /** 건너뛰어도 되는 질문 */
  optional?: boolean;
  /** 입력칸 예시 */
  example?: string;
};

/**
 * 카톡 티키타카 인터뷰. 한 번에 하나씩, 3~5분이면 끝나게.
 *
 * 핵심은 "실제로 한 말" 과 "속으로 한 생각" 을 따로 받는 것 — 이 대비가 썰의 웃음 포인트이고,
 * 사소하고 구체적인 디테일일수록 주작 소리를 덜 듣는다(조사: 소박한 실화가 신뢰를 얻는다).
 */
export const INTERVIEW: InterviewQuestion[] = [
  { id: "topic", ask: "요즘 제일 어이없었던 일, 한 줄로 말해줘!", chips: ["회사", "자취", "연애", "알바", "가족"], chipsPrefix: true, example: "신입 때 팀장님 앞에서 메일 전체답장 누름" },
  { id: "whenWhere", ask: "그게 언제, 어디서였어?", example: "월요일 아침 9시, 사무실" },
  { id: "cast", ask: "등장인물은 누구누구야? 한 단어씩 소개해줘", example: "팀장님-말 느림, 동기-눈치 빠름" },
  { id: "myState", ask: "그때 너는 어떤 상태였어?", chips: ["피곤", "설렘", "쫄아있음", "배고픔", "멍함"] },
  { id: "goal", ask: "원래 뭘 하려던 참이었어?", example: "동기한테만 몰래 투덜대려고 했음" },
  { id: "firstLine", ask: "처음 일이 꼬인 순간, 상대가 실제로 한 말 그대로 적어줘", example: "○○씨, 이거 나한테 보낸 거 맞아?" },
  { id: "sayThink", ask: "그때 너는 입으로 뭐라고 했고, 속으로는 뭐라고 생각했어?", example: "입: 아 네 확인해볼게요! / 속: 끝났다" },
  { id: "worst", ask: "일이 더 커진 순간 있어? 제일 최악이었던 장면은?", optional: true },
  { id: "chat", ask: "혹시 그 대화가 카톡으로도 오갔어? 기억나는 메시지 3~6개 적어줘", chips: ["없음"], optional: true, example: "동기: 너 괜찮냐 / 나: 아니 / 동기: ㅋㅋㅋㅋ" },
  { id: "twist", ask: "결말에 예상 못 한 반전이 있었어?", chips: ["없음"], optional: true },
  { id: "lastLine", ask: "마지막에 누가 무슨 말 했어? 그 한마디가 영상 마지막 대사야" },
  { id: "feeling", ask: "지금 돌아보면 한 줄 소감은?", example: "그 뒤로 전체답장 버튼 가려놓고 삼" },
  { id: "hook", ask: "이 얘기 친구한테 할 때 첫 마디가 뭐야?", example: "야 나 입사 3일 만에 팀장님한테 욕 보냄" },
  { id: "tagWho", ask: "이거 보고 누가 '이거 너잖아' 하고 태그할 것 같아?", chips: ["신입", "직장인", "자취러", "커플", "알바생"], optional: true },
  { id: "safety", ask: "실명·회사·가게 이름은 가명으로 바꿀게. 더 바꾸고 싶은 디테일 있어?", chips: ["없음"], optional: true },
];

export const MOODS = ["웃김", "억울", "설렘", "소름"] as const;
export const LENGTHS = [
  { key: "short", label: "짧게 (25~30초)", scenes: 7 },
  { key: "normal", label: "보통 (35~45초)", scenes: 9 },
  { key: "long", label: "길게 (55~60초)", scenes: 12 },
] as const;
export type LengthKey = (typeof LENGTHS)[number]["key"];

/* ------------------------------------------------------------------ *
 * 대본
 * ------------------------------------------------------------------ */

export type ReelLine = {
  /** me: 주인공, other: 상대(이름표로만 나온다), narrator: 화면 자막 */
  speaker: "me" | "other" | "narrator";
  /** 상대 이름표. "팀장님", "동기" 처럼 직급·관계로 */
  name: string;
  /** say: 입으로 한 말, think: 속마음(회색 말풍선) */
  mode: "say" | "think";
  text: string;
};

export type ChatMessage = { from: "me" | "other"; text: string };

export type ReelScene = {
  /** hook: 첫 2~3초, scene: 본편, chat: 메신저 화면, ending: 마무리 */
  kind: "hook" | "scene" | "chat" | "ending";
  /** 장소·시간 자막. 없으면 빈 문자열 */
  place: string;
  /** 주인공 표정. none 이면 이 장면에 주인공이 안 나온다 */
  expression: ExpressionKey | "none";
  lines: ReelLine[];
  /** kind 가 chat 일 때만 */
  chatWith: string;
  chat: ChatMessage[];
  effect: "none" | "shake" | "zoom" | "flash";
};

export type ReelScript = {
  /** 영상 내내 위에 떠 있는 제목. "입사 3일 만에 팀장님한테 욕 보낸 썰" */
  title: string;
  mood: (typeof MOODS)[number];
  scenes: ReelScene[];
  /** 인스타 캡션 */
  caption: string;
  hashtags: string[];
  /** 가명으로 바꾼 것. 사람이 확인한다 */
  masked: string[];
};

/* ------------------------------------------------------------------ *
 * 타임라인
 * ------------------------------------------------------------------ */

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

/** 줄 하나를 가리키는 키. 음성 클립도 이 키로 찾는다 */
export const lineKey = (scene: number, line: number) => `${scene}-${line}`;

/**
 * 음성이 없을 때 자막이 떠 있을 시간. 조사 기준 max(1.2초, 글자수 × 0.12초).
 * 읽는 속도보다 조금 길게 두어야 한 번에 읽힌다.
 */
export function silentFrames(text: string): number {
  return Math.round(Math.max(1.2, text.replace(/\s/g, "").length * 0.12) * FPS);
}

/** 메신저 말풍선 하나가 뜨는 간격 */
export const CHAT_STEP = Math.round(1.1 * FPS);
/** 장면 끝에 두는 숨 */
const SCENE_PAD = 8;
/** 엔딩은 마지막 줄이 끝나도 잠깐 더 둔다 */
const ENDING_HOLD = Math.round(1.2 * FPS);

export type TimedLine = { key: string; from: number; frames: number; line: ReelLine };
export type TimedScene = { index: number; from: number; frames: number; scene: ReelScene; lines: TimedLine[]; chatFrom: number };

/**
 * 줄마다 길이(음성 길이 또는 글자 수)를 쌓아 장면 시작 프레임을 정한다.
 * 미리보기(Player)와 렌더가 같은 값을 써야 영상 길이가 어긋나지 않는다.
 */
export function buildTimeline(script: ReelScript, audioFrames: Record<string, number> = {}): { scenes: TimedScene[]; total: number } {
  let t = 0;
  const scenes: TimedScene[] = script.scenes.map((scene, si) => {
    const from = t;
    const lines: TimedLine[] = [];
    let cursor = 0;
    scene.lines.forEach((line, li) => {
      const key = lineKey(si, li);
      const frames = Math.max(audioFrames[key] ?? 0, silentFrames(line.text));
      lines.push({ key, from: cursor, frames, line });
      cursor += frames;
    });
    const chatFrom = cursor;
    if (scene.kind === "chat") cursor += scene.chat.length * CHAT_STEP + FPS;
    if (scene.kind === "ending") cursor += ENDING_HOLD;
    const frames = Math.max(cursor, FPS) + SCENE_PAD;
    t += frames;
    return { index: si, from, frames, scene, lines, chatFrom };
  });
  return { scenes, total: Math.max(t, FPS) };
}

/* ------------------------------------------------------------------ *
 * 목소리
 * ------------------------------------------------------------------ */

/** Azure 한국어 신경망 음성. Edge '소리 내어 읽기' 와 같은 목소리들이다 */
export const VOICES = [
  { id: "ko-KR-SunHiNeural", label: "선히 (여, 밝음)" },
  { id: "ko-KR-InJoonNeural", label: "인준 (남, 차분)" },
  { id: "ko-KR-HyunsuMultilingualNeural", label: "현수 (남, 자연스러움)" },
  { id: "ko-KR-JiMinNeural", label: "지민 (여)" },
  { id: "ko-KR-SeoHyeonNeural", label: "서현 (여, 어림)" },
  { id: "ko-KR-BongJinNeural", label: "봉진 (남, 중년)" },
  { id: "ko-KR-GookMinNeural", label: "국민 (남)" },
  { id: "ko-KR-SoonBokNeural", label: "순복 (여, 어르신)" },
] as const;
