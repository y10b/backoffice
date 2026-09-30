import { getSettings } from "./db";
import { openaiJson } from "./openai";
import { EXPRESSION_KEYS, LENGTHS, MAX_FOLLOWUPS, STORY_CHECKLIST, type LengthKey, type ReelScript, type StoryQA } from "./reelScript";
import { fishCreds } from "./fishAudio";

/**
 * 썰 릴스 — 인터뷰 답을 장면 대본으로 바꾸고, 대사를 음성으로 만든다.
 *
 * 영상은 서버에서 만들지 않는다. 대본(JSON)과 음성 클립만 넘기고, 그림·자막·렌더는 브라우저의
 * Remotion 이 한다. 예전 영상 갈래를 걷어낸 이유가 ffmpeg 워커와 외부 API 네 개의 유지 비용
 * 이었다(DEVLOG 17장) — 이번에는 서버가 하는 일을 LLM 한 번, TTS 몇 번으로 줄였다.
 */

/* ------------------------------------------------------------------ *
 * 대본
 * ------------------------------------------------------------------ */

const LINE = {
  type: "object",
  additionalProperties: false,
  properties: {
    speaker: { type: "string", enum: ["me", "other", "narrator"] },
    name: { type: "string" },
    mode: { type: "string", enum: ["say", "think"] },
    text: { type: "string" },
  },
  required: ["speaker", "name", "mode", "text"],
};

const SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    mood: { type: "string", enum: ["웃김", "억울", "설렘", "소름"] },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["hook", "scene", "chat", "ending"] },
          place: { type: "string" },
          expression: { type: "string", enum: [...EXPRESSION_KEYS, "none"] },
          lines: { type: "array", items: LINE },
          chatWith: { type: "string" },
          chat: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { from: { type: "string", enum: ["me", "other"] }, text: { type: "string" } },
              required: ["from", "text"],
            },
          },
          effect: { type: "string", enum: ["none", "shake", "zoom", "flash"] },
          sfx: { type: "string" },
        },
        required: ["kind", "place", "expression", "lines", "chatWith", "chat", "effect", "sfx"],
      },
    },
    caption: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
    masked: { type: "array", items: { type: "string" } },
  },
  required: ["title", "mood", "scenes", "caption", "hashtags", "masked"],
};

export type ScriptInput = {
  /** 사람이 쭉 적은 상황 */
  story: string;
  /** AI 가 되물은 것과 답 */
  followups: StoryQA[];
  mood: string;
  length: LengthKey;
};

/* ------------------------------------------------------------------ *
 * 되묻기 — 쭉 적은 썰에서 빠진 재료만 묻는다
 * ------------------------------------------------------------------ */

const FOLLOWUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    done: { type: "boolean" },
    question: { type: "string" },
    missing: { type: "array", items: { type: "string" } },
  },
  required: ["done", "question", "missing"],
};

/**
 * 다음에 물을 것 하나. 충분하면 done.
 *
 * 한 번에 하나만 묻는다 — 카톡처럼 짧게 주고받아야 답하기 쉽다. 이미 쓴 내용을 다시 묻거나,
 * 없던 일을 유도하는 질문("그때 싸웠죠?")은 하지 않는다. 반전이 없으면 없는 대로 둔다.
 */
export async function nextFollowup(story: string, followups: StoryQA[]): Promise<{ done: boolean; question: string; missing: string[] }> {
  if (followups.length >= MAX_FOLLOWUPS) return { done: true, question: "", missing: [] };
  const d = await openaiJson<{ done: boolean; question: string; missing: string[] }>({
    user: `너는 썰(실제로 겪은 웃픈 일)을 애니 릴스 대본으로 만들기 전에, 빠진 재료만 짧게 되묻는 친구다.

# 사용자가 쭉 적은 썰
${story.trim()}

# 지금까지 되물은 것과 답
${followups.map((f) => `- Q: ${f.q}\n  A: ${f.a || "(건너뜀)"}`).join("\n") || "(아직 없음)"}

# 좋은 썰의 재료
${STORY_CHECKLIST.map((c) => `- ${c.label} — ${c.why}`).join("\n")}

# 할 일
- 위 재료 중 **썰과 답에 아직 없는 것**을 missing 에 적는다
- 그중 영상에 가장 필요한 것 **하나만** question 으로 묻는다. 우선순위: 상대가 실제로 한 말 > 겉말/속마음 > 끝·마지막 한마디 > 언제·어디 > 나머지
- 말투: 친구한테 카톡하듯 반말, 한두 문장. 예) "그때 팀장님이 정확히 뭐라고 했어? 말투 그대로 적어줘!"
- 이미 적힌 걸 다시 묻지 않는다. 건너뛴 질문은 다시 묻지 않는다
- 없었던 일을 유도하지 않는다(반전·싸움·복수를 만들어 내게 하지 않기). 반전은 없어도 된다
- 핵심 재료(상대가 한 말 또는 내 반응, 결말)가 있으면 done=true, question 은 빈 문자열
- 지금까지 ${followups.length}번 물었다. ${MAX_FOLLOWUPS}번이 한도다`,
    schema: FOLLOWUP_SCHEMA,
    schemaName: "story_followup",
  });
  return { done: Boolean(d.done) || !d.question?.trim(), question: String(d.question ?? "").trim(), missing: d.missing ?? [] };
}

export function buildScriptPrompt(o: ScriptInput): string {
  const qa = [
    `## 사용자가 쭉 적은 썰\n${o.story.trim()}`,
    o.followups.length
      ? `## 되물은 것과 답\n${o.followups.map((f) => `- ${f.q}\n  → ${f.a || "(건너뜀 — 모른다는 뜻. 지어내지 마라)"}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const len = LENGTHS.find((l) => l.key === o.length) ?? LENGTHS[1];

  return `인스타그램 릴스용 **애니메이션 썰 영상**의 장면 대본을 만든다. 아래는 주인공(영상 주인)이 실제로 겪은 일을
카톡으로 풀어 놓은 글과 되물은 답이다. 사실은 여기서만 가져온다.

# 주인공
20대 중반 회사원, 서울 관악구 자취. 영상 속에서는 1인칭("나")으로 말한다.

# 썰
${qa}

# 분위기
${o.mood || "웃김"}

# 길이
${len.label}. 장면 ${len.scenes}개 안팎.

# 구조 (썰툰 상위 계정 공통: 훅 → 전개 → 반전·펀치라인 → 여운)
1. hook (첫 장면, 2~3초): 인사 없이 바로 던진다. 썰에서 가장 센 것을 고르고, 공식 하나를 쓴다
   - 결과 먼저: "입사 3일 만에 팀장님한테 욕 보냄"
   - 대사 먼저: 상대의 결정적 한마디를 그대로("○○씨, 잠깐 나 좀 볼까?")
   - 숫자: "회의 3시간, 내 발언 0초"
   - 질문: "이거 제가 잘못한 거임?"
   narrator 1줄, 14자 이내
2. scene: 설정(언제·어디서·내 상태) → 발단(상대의 첫 대사) → 반응(겉말 say / 속마음 think 를 나란히)
   → 악화 → 반전 → 펀치라인(마지막 대사)
3. chat: 썰에 카톡·메시지 대화가 **적혀 있을 때만** 한 장면. 적힌 메시지만 3~6개. 없으면 chat 장면을 만들지 않는다
4. ending (마지막 장면): 두 줄, 둘 다 narrator.
   첫 줄은 여운 — 설명하지 말고 속마음 한 줄이나 후일담 한 줄로 끊는다("(그날 나는 어른이 되었다)")
   둘째 줄은 댓글·공유를 부르는 질문 — "여러분이면 뭐라고 함?", "이거 나만 억울함?", "비슷한 썰 있으면 댓글로"

# 말투 (이삼십·박두기류 상위 계정)
- 내레이션은 1인칭 **음슴체·반말**("~했음", "~인 거임", "~했는데"). 담담하게 말하는데 상황이 웃긴 톤. 과장하지 않는다
- 상대 대사는 썰에 적힌 말투 그대로. 상대 존댓말과 내 반말 속마음의 대비가 웃음 포인트다
- **무해한 유머**: 상대를 악마로 만들지 않는다. 나의 서툰 순간이 웃음의 중심이다
- 이모지·특수문자는 대사에 쓰지 않는다(말풍선과 음성이 이상해진다)

# 장면 규칙
- 장면 하나에 lines 는 최대 2개. 한 줄은 8~20자, 길어도 25자 — 한 호흡에 읽히게
- 한 줄에서 가장 센 단어 하나만 \`**단어**\` 로 감싸 강조할 수 있다(영상에서 노란색). 줄마다 쓰지 말고 장면 절반 이하에만
- think 는 주인공 속마음에만 쓴다. 겉말과 속마음이 어긋날수록 웃기다
- expression: 감정 흐름을 따라 표정을 바꾼다(처음 기본·멍 → 당황·식은땀 → 분노·울음 → 해탈·웃음 같은 곡선).
  같은 표정을 세 장면 연속 쓰지 않는다. 주인공이 말하거나 생각하는 줄이 없는 장면은 none 으로 둘 수 있다
  (${EXPRESSION_KEYS.join(", ")})
- 숫자·금액·시간은 읽는 그대로 한글로 쓴다("3만원" → "삼만 원", "9시" → "아홉 시"). 음성이 숫자를 잘못 읽는다
  단, hook 의 숫자 공식은 예외 — 화면에서 숫자가 더 세게 보인다
- 상대(other)는 그림이 없다. name 에 "팀장님", "동기", "집주인" 처럼 직급·관계를 넣는다. narrator·me 는 name 을 빈 문자열로
- place: 장소·시간이 바뀌는 장면에만 짧게("월요일 오전 9시 · 사무실"). 아니면 빈 문자열
- effect: 충격(shake), 강조(zoom), 반전(flash)에 한두 번만. 나머지는 none
- sfx: 효과음 글자. 충격·반전·깨달음 순간에만 "쾅", "띠용", "두둥", "정적…", "빠직", "움찔" 같은 짧은 말. **한 편에 2~4개**, 나머지 장면은 빈 문자열
- chatWith 와 chat 은 chat 장면이 아니면 빈 문자열·빈 배열

# 지어내지 마라
- 썰에 없는 사건, 대사, 인물을 만들지 않는다. 극적으로 보이려고 부풀리지 않는다
- 반전이 없으면 반전 장면을 만들지 않는다 — 소박한 실화가 주작 소리를 덜 듣는다
- 완벽한 복수·참교육으로 끝내지 않는다. 결말은 답에 있는 그대로

# 가명 처리 (명예훼손 방지 — 반드시)
- 사람 실명 → 직급·관계("김 팀장" → "팀장님"), 회사·부서·브랜드·가게·학교 이름 → 일반명사("OO전자" → "회사")
- 특정될 만한 디테일(층수, 특이한 사건 조합)은 흐린다
- 바꾼 것을 masked 에 "원래 → 바꾼 것" 으로 적는다. 없으면 빈 배열

# 제목·캡션
- title: "~한 썰" 형식, 20자 이내. 결론이나 가장 센 장면이 드러나게
- caption: 인스타 캡션. 훅 대사 한 줄 + 공감 질문 한 줄. 이모지 0~2개
- hashtags: 4~6개(#회사썰 #직장인공감 처럼 소재 + #인스타툰 #애니메이션). # 기호 포함

JSON 으로만 낸다.`;
}

export async function generateReelScript(o: ScriptInput): Promise<ReelScript> {
  const d = await openaiJson<ReelScript>({
    user: buildScriptPrompt(o),
    schema: SCRIPT_SCHEMA,
    schemaName: "reel_script",
  });
  // 모델이 규칙을 어겨도 영상이 깨지지 않게 최소한만 다듬는다
  const scenes = (d.scenes ?? [])
    .map((s) => ({
      ...s,
      lines: (s.lines ?? []).filter((l) => l.text?.trim()).slice(0, 2),
      chat: s.kind === "chat" ? (s.chat ?? []).filter((m) => m.text?.trim()).slice(0, 8) : [],
      sfx: String(s.sfx ?? "").trim().slice(0, 8),
    }))
    .filter((s) => s.lines.length || s.chat.length);
  if (!scenes.length) throw new Error("대본에 장면이 없습니다. 인터뷰 답을 조금 더 채워 주세요.");
  return {
    title: String(d.title ?? "").trim(),
    mood: d.mood ?? "웃김",
    scenes,
    caption: String(d.caption ?? "").trim(),
    hashtags: (d.hashtags ?? []).map((h) => (h.startsWith("#") ? h : `#${h}`)).slice(0, 8),
    masked: d.masked ?? [],
  };
}

/**
 * 쓸 음성 엔진. Fish Audio 키가 있으면 Fish, 없으면 Azure, 둘 다 없으면 null(자막만).
 * 사용자가 Fish 로 정했다 — Azure 는 키를 넣어 둔 경우를 위한 대안으로 남긴다.
 */
export async function ttsEngine(): Promise<"fish" | "azure" | null> {
  if (await fishCreds()) return "fish";
  if (await azureCreds()) return "azure";
  return null;
}

/* ------------------------------------------------------------------ *
 * 음성 — Azure Speech
 *
 * Edge '소리 내어 읽기' 와 같은 한국어 음성(선히·인준…)을 공식 API 로 쓴다. Edge 의 비공식
 * 엔드포인트는 막혀 있고(403), 우회는 하지 않는다.
 * 줄 하나 = 클립 하나. 자막은 클립 길이로 맞추므로 단어 타이밍이 필요 없다.
 * ------------------------------------------------------------------ */

export async function azureCreds(): Promise<{ key: string; region: string } | null> {
  const s = await getSettings(["azure_speech_key", "azure_speech_region"]);
  const key = s.azure_speech_key || process.env.AZURE_SPEECH_KEY || "";
  const region = s.azure_speech_region || process.env.AZURE_SPEECH_REGION || "";
  return key && region ? { key, region } : null;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 한 줄을 mp3 로. 속마음은 조금 작고 빠르게 — 혼잣말처럼 들리게 */
export async function speak(o: { text: string; voice: string; think?: boolean; rate?: number }): Promise<ArrayBuffer> {
  const creds = await azureCreds();
  if (!creds) throw new Error("Azure Speech 키·지역이 없습니다. 설정 화면에서 등록하세요. 없으면 자막만으로 만들 수 있습니다.");
  const rate = `${Math.round((o.rate ?? 1.2) * 100 - 100 + (o.think ? 5 : 0))}%`;
  const volume = o.think ? "-15%" : "+0%";
  const ssml =
    `<speak version="1.0" xml:lang="ko-KR"><voice name="${escapeXml(o.voice)}">` +
    `<prosody rate="${rate.startsWith("-") ? rate : `+${rate}`}" volume="${volume}">${escapeXml(o.text)}</prosody>` +
    `</voice></speak>`;

  const res = await fetch(`https://${creds.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": creds.key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "backoffice-reels",
    },
    body: ssml,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    const hint =
      res.status === 401 ? " 키가 틀렸거나 지역이 리소스와 다릅니다." : res.status === 429 ? " 호출 한도를 넘었습니다. 잠시 뒤 다시 하세요." : "";
    throw new Error(`Azure 음성 오류 (HTTP ${res.status}).${hint} ${detail}`);
  }
  return res.arrayBuffer();
}
