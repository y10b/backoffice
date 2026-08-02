export type Keyword = {
  /** 검색어 / 키워드 문자열 */
  keyword: string;
  /** 순위 (1부터). 응답에 없으면 배열 index + 1 */
  rank: number | null;
  /** 조회수·유입수 등 원본 지표 (있을 때만) */
  metric: number | null;
  /** 전일 대비 순위 변동 (있을 때만) */
  rankDelta: number | null;
  /** 파싱 전 원본 객체 — 디버깅 및 미매핑 필드 확인용 */
  raw: Record<string, unknown>;
};

export type KeywordFetchResult = {
  ok: boolean;
  status: number;
  /** 실제로 호출한 URL — 문제 생겼을 때 그대로 DevTools 와 비교 가능 */
  requestUrl: string;
  keywords: Keyword[];
  /** 원본 JSON (또는 오류 본문). UI 디버그 패널에 그대로 노출한다 */
  raw: unknown;
  error?: string;
};

export type Post = {
  id: number;
  main_keyword: string;
  sub_keyword: string;
  title: string;
  body_html: string;
  body_markdown: string;
  tags: string;
  meta_desc: string;
  status: string;
  posted_naver: number;
  posted_tistory: number;
  created_at: string;
  updated_at: string;
};

export type GeneratedDraft = {
  title: string;
  metaDescription: string;
  tags: string[];
  bodyMarkdown: string;
  bodyHtml: string;
};
