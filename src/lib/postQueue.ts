/**
 * 글감 큐 — 다음에 쓸 티스토리 키워드를 사람이 직접 줄 세워 두는 곳 (설정 키 `post_queue`).
 *
 * 자동 선택(유입 신호·키워드 풀)은 숫자로만 고른다. 그런데 "계산기를 붙일 글", "5월 전에
 * 나가야 할 글"처럼 사람이 아는 맥락이 있다. 그런 건 큐에 넣고, writeDailyPost 는 큐를
 * 가장 먼저 본다. note 는 본문 생성 프롬프트에 추가 지시로 넘어간다.
 *
 * 표를 따로 만들지 않고 설정 한 칸(JSON)에 둔다. 몇 개~몇십 개짜리 목록이고, 화면에서
 * 통째로 편집해 통째로 저장하는 게 전부라 행 단위 갱신이 필요 없다.
 */
import { getSetting, hasSupabase, setSetting } from "./db";

export const QUEUE_SETTING_KEY = "post_queue";

export type QueueItem = {
  keyword: string;
  /** 본문 생성 추가 지시. "계산기" 가 들어 있으면 본문에 계산기를 끼운다 */
  note?: string;
  done?: boolean;
  /** 이 항목으로 만든 초안 posts.id */
  postId?: number;
};

/** 설정이 비어 있을 때 넣는 초기 큐. 키워드 풀·서치콘솔을 보고 사람이 고른 것이다 */
export const DEFAULT_QUEUE: QueueItem[] = [
  { keyword: "프리랜서 종합소득세", note: "신고 방법 + 경비율" },
  { keyword: "3.3% 환급 계산기", note: "계산기" },
  { keyword: "지역가입자 건강보험료", note: "프리랜서 전환 시 얼마 오르나" },
  { keyword: "퇴직금중간정산", note: "조건과 세금" },
  { keyword: "종합소득세신고", note: "5월 전 체크리스트" },
  { keyword: "세금계산기", note: "계산기 — 부가세·종합소득세 한 페이지" },
  { keyword: "양도세기본세율", note: "표 정리" },
];

const MAX_ITEMS = 200;
const MAX_KEYWORD = 100;
const MAX_NOTE = 500;

/**
 * 형식 검증 + 정리. 틀리면 무엇이 틀렸는지 한국어로 던진다 (POST /api/queue 가 400 으로 돌려준다).
 * 빈 키워드 줄은 버리고, 같은 키워드가 두 번이면 처음 것만 남긴다.
 */
export function parseQueue(input: unknown): QueueItem[] {
  if (!Array.isArray(input)) throw new Error("queue 는 배열이어야 합니다.");
  if (input.length > MAX_ITEMS) throw new Error(`큐는 ${MAX_ITEMS}개까지입니다.`);
  const out: QueueItem[] = [];
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`${i + 1}번째 항목이 객체가 아닙니다.`);
    const o = raw as Record<string, unknown>;
    if (typeof o.keyword !== "string") throw new Error(`${i + 1}번째 항목에 keyword(문자열)가 없습니다.`);
    const keyword = o.keyword.trim();
    if (!keyword) return;
    if (keyword.length > MAX_KEYWORD) throw new Error(`${i + 1}번째 키워드가 너무 깁니다 (${MAX_KEYWORD}자).`);
    if (o.note !== undefined && o.note !== null && typeof o.note !== "string") {
      throw new Error(`${i + 1}번째 note 는 문자열이어야 합니다.`);
    }
    if (o.done !== undefined && o.done !== null && typeof o.done !== "boolean") {
      throw new Error(`${i + 1}번째 done 은 true/false 여야 합니다.`);
    }
    if (o.postId !== undefined && o.postId !== null && !Number.isInteger(o.postId)) {
      throw new Error(`${i + 1}번째 postId 는 정수여야 합니다.`);
    }
    const bare = keyword.replace(/\s+/g, "");
    if (seen.has(bare)) return;
    seen.add(bare);

    const item: QueueItem = { keyword };
    const note = typeof o.note === "string" ? o.note.trim().slice(0, MAX_NOTE) : "";
    if (note) item.note = note;
    if (o.done === true) item.done = true;
    if (typeof o.postId === "number") item.postId = o.postId;
    out.push(item);
  });
  return out;
}

/**
 * 큐. 설정이 한 번도 저장된 적 없으면(null·빈 문자열) 초기값을 저장하고 돌려준다.
 * 사람이 전부 지워 `[]` 로 저장한 것은 비운 것으로 존중한다 — 초기값으로 되살리지 않는다.
 * 저장값이 깨졌으면 던진다. 조용히 초기값으로 덮으면 사람이 짠 큐가 사라진다.
 */
export async function getQueue(): Promise<QueueItem[]> {
  if (!hasSupabase()) return DEFAULT_QUEUE.map((q) => ({ ...q }));
  const raw = (await getSetting(QUEUE_SETTING_KEY))?.trim();
  if (!raw) {
    const init = DEFAULT_QUEUE.map((q) => ({ ...q }));
    await setSetting(QUEUE_SETTING_KEY, JSON.stringify(init));
    return init;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`설정 ${QUEUE_SETTING_KEY} 의 JSON 이 깨졌습니다. 화면에서 큐를 다시 저장하세요.`);
  }
  return parseQueue(parsed);
}

export async function setQueue(queue: unknown): Promise<QueueItem[]> {
  const clean = parseQueue(queue);
  await setSetting(QUEUE_SETTING_KEY, JSON.stringify(clean));
  return clean;
}

/** 큐 note 에 "계산기" 가 있으면 본문에 계산기를 끼운다 */
export function wantsCalculator(note?: string): boolean {
  return Boolean(note && note.includes("계산기"));
}
