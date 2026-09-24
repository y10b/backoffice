import { getSettings } from "./db";

/**
 * 자동 생성·키워드 수집이 돌려 쓰는 시드 키워드. 블로그 채널마다 따로다.
 *
 * 라우트 파일은 Next 가 정한 이름(GET/POST/dynamic …)만 export 할 수 있어서 여기로 뺐다.
 *
 * 예전에는 코드 상수 하나(보험·법률·정부지원금 12개)였다. 단가만 보고 서로 다른 주제를
 * 섞었더니 블로그가 한 주제로 읽히지 않았고, 검색량 순으로 뽑힌 키워드는 전부 레드오션이라
 * 티스토리 유입이 0 이었다. 이제 채널마다 한 주제로 묶고, 값은 설정(DB settings)에서 읽는다.
 * 여기 있는 것은 설정이 비었을 때의 기본값이다.
 */

export type Channel = "naver" | "tistory";

export const CHANNELS: Channel[] = ["naver", "tistory"];

export function isChannel(v: unknown): v is Channel {
  return v === "naver" || v === "tistory";
}

export const DEFAULT_SEEDS: Record<Channel, string[]> = {
  /*
   * 주제: n잡러·프리랜서의 돈 관리.
   * 매년 수치가 바뀌어 새 글 수요가 계속 있고, 개인 블로그가 1차 정리로 인용될 여지가 있다.
   */
  tistory: [
    "프리랜서 종합소득세",
    "3.3% 환급",
    "프리랜서 부가세",
    "프리랜서 사업자등록",
    "지역가입자 건강보험료",
    "프리랜서 국민연금",
    "프리랜서 실업급여",
    "근로장려금",
    "부업 소득 신고",
    "프리랜서 지원금",
    "간이과세자",
    "홈택스 신고",
  ],
  /*
   * 임시. 네이버 블로그는 맛집 후기 위주라 결이 맞는 정보성 여행·데이트 주제로 채웠다.
   * 2주 동안 모은 키워드를 보고 다시 정한다.
   */
  naver: [
    "제주도 여행 코스",
    "여수 여행",
    "강릉 여행",
    "부산 여행 코스",
    "서울 데이트 코스",
    "캠핑 준비물",
    "국내 여행지 추천",
    "당일치기 여행",
    "기념일 레스토랑",
    "브런치 카페",
    "야경 명소",
    "맛집 예약 앱",
  ],
};

/** 설정 키. 값은 쉼표·줄바꿈 구분 문자열 */
export function seedSettingKey(channel: Channel): string {
  return `seeds_${channel}`;
}

/** 쉼표·줄바꿈으로 나누고, 빈 칸과 중복을 뺀다 */
export function parseSeeds(raw: string): string[] {
  const out: string[] = [];
  for (const s of raw.split(/[,\n]/)) {
    const v = s.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 채널의 시드 풀. 설정에 값이 있으면 그것, 비었으면 기본값 */
export async function seedPool(channel: Channel): Promise<string[]> {
  const key = seedSettingKey(channel);
  const s = await getSettings([key]);
  const stored = parseSeeds(s[key] ?? "");
  return stored.length ? stored : [...DEFAULT_SEEDS[channel]];
}

/**
 * 날짜로 시드를 고른다.
 *
 * 무작위로 뽑으면 같은 날 두 번 돌렸을 때 다른 주제가 나와 중복 글이 쌓인다.
 * 날짜를 나눗셈해 쓰면 하루 안에서는 항상 같은 시드가 나오고, 풀 크기만큼의 주기로 돈다.
 */
export function seedForDate(d: Date, pool: string[]): string {
  const days = Math.floor(d.getTime() / 86_400_000);
  return pool[days % pool.length];
}
