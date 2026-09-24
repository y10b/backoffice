import { getSettings } from "./db";

/**
 * 자동 생성·키워드 수집이 돌려 쓰는 시드 키워드. 티스토리 전용이다.
 *
 * 네이버는 방문 후기 레인(visit_posts)이 담당하므로 키워드 시드는 티스토리뿐이다.
 * posts.channel · keyword_pool.channel 컬럼은 남아 있지만 값은 늘 'tistory' 다.
 *
 * 라우트 파일은 Next 가 정한 이름(GET/POST/dynamic …)만 export 할 수 있어서 여기로 뺐다.
 *
 * 예전에는 코드 상수 하나(보험·법률·정부지원금 12개)였다. 단가만 보고 서로 다른 주제를
 * 섞었더니 블로그가 한 주제로 읽히지 않았고, 검색량 순으로 뽑힌 키워드는 전부 레드오션이라
 * 티스토리 유입이 0 이었다. 이제 한 주제로 묶고, 값은 설정(DB settings `seeds_tistory`)에서
 * 읽는다. 여기 있는 것은 설정이 비었을 때의 기본값이다.
 */

/*
 * 주제: n잡러·프리랜서의 돈 관리.
 * 매년 수치가 바뀌어 새 글 수요가 계속 있고, 개인 블로그가 1차 정리로 인용될 여지가 있다.
 */
export const DEFAULT_SEEDS: string[] = [
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
];

/** 설정 키. 값은 쉼표·줄바꿈 구분 문자열 */
export const SEED_SETTING_KEY = "seeds_tistory";

/** 쉼표·줄바꿈으로 나누고, 빈 칸과 중복을 뺀다 */
export function parseSeeds(raw: string): string[] {
  const out: string[] = [];
  for (const s of raw.split(/[,\n]/)) {
    const v = s.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 시드 풀. 설정에 값이 있으면 그것, 비었으면 기본값 */
export async function seedPool(): Promise<string[]> {
  const s = await getSettings([SEED_SETTING_KEY]);
  const stored = parseSeeds(s[SEED_SETTING_KEY] ?? "");
  return stored.length ? stored : [...DEFAULT_SEEDS];
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
