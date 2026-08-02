import type { CompetitionLevel } from "./types";

/**
 * 문서수 ÷ 월간 검색수로 노출 난이도를 가늠한다.
 * 정식 지표가 아니라 블로그 SEO 에서 통용되는 경험칙이라 구간도 넉넉하게 잡았다.
 *
 * 서버(집계)와 클라이언트(표시) 양쪽에서 쓰므로 순수 함수만 둔다.
 */
export function competitionLevel(ratio: number | null): CompetitionLevel | null {
  if (ratio === null) return null;
  if (ratio < 1) return "good";
  if (ratio < 3) return "ok";
  if (ratio < 10) return "warn";
  return "bad";
}

export const COMPETITION_LABEL: Record<CompetitionLevel, string> = {
  good: "매우 좋음",
  ok: "좋음",
  warn: "보통",
  bad: "어려움",
};
