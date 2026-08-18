import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./db";

/**
 * 유아 채널 영상 기획 — Claude.
 *
 * 블로그 본문은 Gemini 가 계속 담당한다. 여기는 영상 기획·대본·장면 프롬프트 전용이라
 * 두 파이프라인이 서로를 건드리지 않는다.
 *
 * 이 모듈은 **기획만** 한다. 실제 영상 생성은 seedance.ts 가 맡는다.
 */

/**
 * 기본 모델.
 *
 * 이 모듈이 하는 일은 대본 한 편이다 — 스키마가 정해진 JSON 을 한 번 받아오는
 * 유계 작업이지, 도구를 물고 길게 도는 에이전트 작업이 아니다. 출력이 비싼 쪽인데
 * (Sonnet 5 는 100만 토큰당 입력 $3 / 출력 $15, Opus 5 는 $5 / $25) 기획안은
 * 장면 수만큼 길어져서 출력이 늘어난다. 여기서 Opus 를 쓰면 값의 대부분을
 * 출력에 낸다.
 *
 * 품질이 아쉬우면 설정 화면에서 claude-opus-5 로 올리면 된다.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

export async function anthropicKey(): Promise<string | null> {
  const s = await getSettings(["anthropic_api_key"]);
  return s.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null;
}

export async function claudeModel(): Promise<string> {
  const s = await getSettings(["claude_model"]);
  return s.claude_model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

async function client(): Promise<Anthropic> {
  const key = await anthropicKey();
  if (!key) {
    throw new Error("Anthropic API 키가 없습니다. 설정 화면에서 등록하세요.");
  }
  return new Anthropic({ apiKey: key });
}

export type Scene = {
  /** 1부터 */
  index: number;
  seconds: number;
  /** 화면에 깔릴 한국어 가사/내레이션 */
  korean: string;
  /** 영상 생성 모델에 넣을 영어 프롬프트 (캐릭터 시트는 렌더 단계에서 앞에 붙인다) */
  videoPrompt: string;
  /** 이 장면에서 강조할 단어 (자막 크게) */
  onScreenText: string;
};

export type KidsVideoPlan = {
  /** 참고 영상에서 읽어낸 구성. 왜 이 기획이 나왔는지 근거가 된다 */
  analysis: string;
  /** 모델이 정한(또는 사용자가 넣은) 주제 */
  theme: string;
  title: string;
  description: string;
  concept: string;
  /**
   * 캐릭터 고정 묘사(영문).
   *
   * 전적으로 AI 로 생성하면 장면마다 캐릭터가 달라지는 게 가장 큰 문제다. 매 장면
   * 프롬프트 앞에 이 문장을 그대로 붙여 외형을 고정한다.
   */
  characterSheet: string;
  /** 전체 영상 공통 화풍 (영문) */
  styleSheet: string;
  scenes: Scene[];
  tags: string[];
  /** 기획자가 확인해야 할 안전·저작권 체크 포인트 */
  safetyNotes: string[];
  /**
   * 이번 호출이 쓴 토큰과 그 값.
   *
   * 대본은 장면 수를 올릴수록 출력이 길어지고, 값은 출력 쪽이 다섯 배 비싸다.
   * 숫자를 화면에 띄워야 "장면을 몇 개까지 둘까"를 감이 아니라 값으로 정한다.
   */
  usage: PlanUsage;
};

export type PlanUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 달러. 공개 정가 기준이라 실제 청구액과는 다를 수 있다 */
  costUsd: number;
};

/** 100만 토큰당 정가(입력, 출력). 목록에 없는 모델은 값을 0 으로 둔다 */
const PRICING: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const [inRate, outRate] = PRICING[model] ?? [0, 0];
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    analysis: { type: "string" },
    theme: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    concept: { type: "string" },
    characterSheet: { type: "string" },
    styleSheet: { type: "string" },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          seconds: { type: "integer" },
          korean: { type: "string" },
          videoPrompt: { type: "string" },
          onScreenText: { type: "string" },
        },
        required: ["index", "seconds", "korean", "videoPrompt", "onScreenText"],
      },
    },
    tags: { type: "array", items: { type: "string" } },
    safetyNotes: { type: "array", items: { type: "string" } },
  },
  required: [
    "analysis",
    "theme",
    "title",
    "description",
    "concept",
    "characterSheet",
    "styleSheet",
    "scenes",
    "tags",
    "safetyNotes",
  ],
} as const;

/** 분석해 모티브로 삼을 참고 영상 */
export type SourceVideo = {
  title: string;
  channel: string;
  description: string;
  durationSec: number | null;
  views: number | null;
};

export type PlanOptions = {
  /** 모티브로 삼을 인기 영상 제목들 */
  motifs: string[];
  /**
   * 주제. 참고 영상을 주면 비워도 된다 — 모델이 영상 구성을 읽고 직접 정한다.
   */
  theme: string;
  /**
   * 분석할 참고 영상 하나.
   *
   * 제목만 넘기는 것과 다르다. 설명란과 길이까지 주면 "몇 개 항목을 어떤 순서로 다루고
   * 후렴을 어디서 반복하는지" 같은 구성을 읽어낼 수 있다.
   */
  source?: SourceVideo;
  /** 대상 연령 */
  targetAge?: string;
  sceneCount?: number;
  secondsPerScene?: number;
  /** 추가 지시 */
  notes?: string;
};

/**
 * 시스템 프롬프트.
 *
 * 저작권 경계가 이 프롬프트의 핵심이다. "인기 영상을 모티브로" 는 포맷·구성을 따라가라는
 * 뜻이지 캐릭터를 닮게 만들라는 뜻이 아니다. 모델이 이 선을 넘지 않게 명시한다.
 */
const SYSTEM = [
  "당신은 유아용(2~5세) 영상 채널의 기획자입니다. AI 영상 생성 모델로 만들 짧은 영상의 기획안을 작성합니다.",
  "",
  "## 저작권 — 가장 중요",
  "- 기존 캐릭터를 닮게 만들지 마세요. 핑크퐁, 아기상어, 코코멜론, 뽀로로, 타요, 디즈니, 산리오 등 실존 IP 의",
  "  캐릭터 디자인·이름·로고·시그니처 색조합을 연상시키는 요소를 넣으면 안 됩니다.",
  "- 포맷과 구성(반복 후렴, 색깔 소개 순서, 카운팅 구조)은 저작권 대상이 아니므로 참고해도 됩니다.",
  "- 캐릭터는 완전히 새로 설계하고, characterSheet 에 그 외형을 구체적으로 못 박으세요.",
  "- 전래동요·공개 도메인이 아닌 기존 노래의 멜로디나 가사를 쓰지 마세요. 가사는 새로 씁니다.",
  "",
  "## 아동 안전",
  "- 무서운 장면, 어두운 분위기, 갑작스러운 큰 변화, 빠른 점멸을 넣지 마세요.",
  "- 폭력·위험행동(높은 곳에 오르기, 불, 날붙이)을 묘사하지 마세요.",
  "- 어휘는 2~5세 수준. 한 문장은 짧게, 반복을 많이.",
  "",
  "## 캐릭터 일관성",
  "- AI 영상 모델은 장면마다 외형이 흔들립니다. characterSheet 는 그걸 막는 장치입니다.",
  "- 색, 형태, 크기 비율, 눈·입 모양, 입은 옷을 수치와 색상명으로 구체적으로 쓰세요.",
  "- characterSheet 와 styleSheet 는 **영어**로 쓰세요. 영상 생성 모델이 영어에 훨씬 강합니다.",
  "- 각 장면의 videoPrompt 도 **영어**로, 카메라·동작·배경만 씁니다. 캐릭터 외형은 반복하지 마세요",
  "  (렌더 단계에서 characterSheet 가 자동으로 앞에 붙습니다).",
  "",
  "## 장면 프롬프트",
  "- 한 장면은 한 동작만. 여러 일이 동시에 일어나면 모델이 뭉갭니다.",
  "- 카메라는 고정 또는 아주 느린 이동. 유아용에서 빠른 카메라 워크는 금물입니다.",
  "- 화면에 글자를 넣으라고 지시하지 마세요. AI 영상 모델은 글자를 제대로 못 씁니다.",
  "  자막은 onScreenText 로 따로 받아 편집 단계에서 얹습니다.",
  "",
  "JSON 으로만 응답하세요.",
].join("\n");

function buildPrompt(o: PlanOptions): string {
  const sceneCount = o.sceneCount ?? 8;
  const secondsPerScene = o.secondsPerScene ?? 5;

  const source = o.source;
  return [
    source
      ? [
          "## 분석할 참고 영상",
          `제목: ${source.title}`,
          `채널: ${source.channel}`,
          source.durationSec ? `길이: ${Math.round(source.durationSec)}초` : "",
          source.views ? `조회수: ${source.views.toLocaleString()}` : "",
          // 설명란은 길면 프롬프트를 잡아먹는다. 구성 파악에는 앞부분으로 충분하다
          source.description.trim()
            ? `설명란:\n${source.description.trim().slice(0, 1200)}`
            : "",
          "",
          "이 영상이 **왜 먹혔는지** 구성을 먼저 분석하세요 — 몇 개 항목을 어떤 순서로 다루는지,",
          "후렴이나 반복이 어디서 들어가는지, 길이를 어떻게 배분했는지. 그 분석을 analysis 에 적고,",
          "**같은 구성으로 완전히 새로운 캐릭터와 소재**의 기획을 만드세요.",
          "제목·캐릭터·가사를 베끼는 게 아니라 구조만 가져옵니다.",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    o.theme?.trim()
      ? `## 주제\n${o.theme}`
      : "## 주제\n참고 영상의 구성에 맞는 주제를 직접 정해서 theme 에 적으세요.",
    o.motifs.length
      ? `## 참고할 인기 영상 제목 (구성만 참고, 캐릭터는 새로 설계)\n${o.motifs
          .slice(0, 20)
          .map((m) => `- ${m}`)
          .join("\n")}`
      : "",
    `## 대상\n${o.targetAge ?? "2~5세"}`,
    `## 분량\n장면 ${sceneCount}개, 장면당 ${secondsPerScene}초 (총 ${sceneCount * secondsPerScene}초)`,
    o.notes?.trim() ? `## 추가 지시\n${o.notes.trim()}` : "",
    "",
    "위 조건으로 기획안을 만드세요.",
    `- scenes 는 정확히 ${sceneCount}개, 각 seconds 는 ${secondsPerScene}.`,
    "- title 은 한국어. 부모가 검색할 만한 말로.",
    "- tags 는 10개.",
    "- safetyNotes 에는 이 기획에서 사람이 직접 확인해야 할 항목을 적으세요 (예: 특정 표현이 기존 IP 와",
    "  겹칠 여지, 연령 적합성 재확인 지점).",
    "- analysis 는 한국어로, 참고 영상에서 읽어낸 구성과 그것을 어떻게 바꿔 적용했는지 적으세요.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function planKidsVideo(o: PlanOptions): Promise<KidsVideoPlan> {
  if (!o.theme?.trim() && !o.source) {
    throw new Error("주제를 입력하거나 참고 영상을 고르세요.");
  }

  const anthropic = await client();
  const model = await claudeModel();

  /*
   * 장면이 많으면 출력이 길어져 논스트리밍은 HTTP 타임아웃에 걸린다.
   * 스트리밍으로 받고 finalMessage() 로 합친다.
   */
  const stream = anthropic.messages.stream({
    model,
    max_tokens: 32000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: {
      /*
       * 대본은 형식이 스키마로 고정돼 있어 모델이 구성을 헤맬 여지가 적다.
       * high 는 그만큼을 생각에 더 쓰는데, 여기서는 값에 비해 남는 게 적었다.
       * 결과가 얕으면 설정에서 모델을 올리는 편이 이 값을 올리는 것보다 낫다.
       */
      effort: "medium",
      format: { type: "json_schema", schema: PLAN_SCHEMA },
    },
    messages: [{ role: "user", content: buildPrompt(o) }],
  } as Anthropic.MessageStreamParams);

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(
      `Claude 가 요청을 거절했습니다 (${message.stop_details?.category ?? "사유 미상"}). 주제를 바꿔 다시 시도하세요.`,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("응답이 잘렸습니다. 장면 수를 줄이고 다시 시도하세요.");
  }

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text.trim()) throw new Error("Claude 가 기획안을 반환하지 않았습니다.");

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Claude 가 반환한 기획안 JSON 을 파싱하지 못했습니다.");
  }

  const scenes: Scene[] = Array.isArray(parsed.scenes)
    ? parsed.scenes.map((s: any, i: number) => ({
        index: Number(s.index) || i + 1,
        seconds: Number(s.seconds) || (o.secondsPerScene ?? 5),
        korean: String(s.korean ?? ""),
        videoPrompt: String(s.videoPrompt ?? ""),
        onScreenText: String(s.onScreenText ?? ""),
      }))
    : [];

  if (!scenes.length) throw new Error("기획안에 장면이 없습니다.");

  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;

  return {
    usage: {
      model,
      inputTokens,
      outputTokens,
      costUsd: estimateCost(model, inputTokens, outputTokens),
    },
    analysis: String(parsed.analysis ?? "").trim(),
    theme: String(parsed.theme ?? o.theme ?? "").trim(),
    title: String(parsed.title ?? "").trim(),
    description: String(parsed.description ?? "").trim(),
    concept: String(parsed.concept ?? "").trim(),
    characterSheet: String(parsed.characterSheet ?? "").trim(),
    styleSheet: String(parsed.styleSheet ?? "").trim(),
    scenes,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((t: unknown) => String(t).replace(/^#/, "").trim()).filter(Boolean)
      : [],
    safetyNotes: Array.isArray(parsed.safetyNotes)
      ? parsed.safetyNotes.map((n: unknown) => String(n)).filter(Boolean)
      : [],
  };
}

/**
 * 장면 프롬프트 조립.
 *
 * 캐릭터 시트를 매 장면 앞에 붙이는 게 일관성의 전부다. 렌더 직전에 한 곳에서 조립해야
 * 장면마다 다른 형태로 붙는 사고가 안 난다.
 */
export function composeScenePrompt(plan: KidsVideoPlan, scene: Scene): string {
  return [plan.characterSheet, plan.styleSheet, scene.videoPrompt]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}
