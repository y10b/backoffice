import type { SerpStats } from "./serp";

export type CompetitionLevel = "good" | "ok" | "warn" | "bad";

export type Keyword = {
  /** 검색어 / 키워드 문자열 */
  keyword: string;
  /** 정렬 후 순위 (1부터) */
  rank: number;
  /** 시드로 직접 넣은 키워드인지 */
  isSeed: boolean;
  /** 월간 검색수 (검색광고 키워드도구) */
  pcSearches: number | null;
  mobileSearches: number | null;
  totalSearches: number | null;
  /** 광고 경쟁정도: 높음 / 중간 / 낮음 */
  adCompetition: string | null;
  /** 월평균 노출 광고수 (0~15) */
  adDepth: number | null;
  /** 월평균 광고 클릭률 % */
  adCtr: number | null;
  /** 모바일 검색 비중 % */
  mobileShare: number | null;
  /** 1위 노출 예상 입찰가(원, 모바일). 애드센스 단가의 대리 지표 */
  bid: number | null;
  /**
   * 수익 잠재력 = 월간 검색수 × 입찰가 ÷ 1000.
   * 트래픽과 단가를 한 축으로 합친 값. 절대 금액이 아니라 비교용 지수다.
   */
  revenueScore: number | null;
  /**
   * 광고 흡수율 % — 월평균 광고 클릭수 ÷ 월간 검색수.
   * 검색 중 몇 %가 광고로 빠지는지. 낮을수록 블로그 등 자연 결과로 갈 여지가 크다.
   */
  adAbsorption: number | null;
  /** 블로그 총 문서수 (검색 API). 조회하지 않았으면 null */
  blogDocs: number | null;
  /** 블로그 문서수 ÷ 월간 검색수. 낮을수록 노출이 쉽다 */
  competitionRatio: number | null;
  /** 블로그 검색 결과 상위권 분석. `경쟁 분석` 버튼으로 조회한 키워드에만 채워진다 */
  serp: SerpStats | null;
  /** 데이터랩 상대지수 추이. 조회한 키워드에만 채워진다 */
  trend: { period: string; ratio: number }[] | null;
  /** 추세 요약 (뒤쪽 1/3 vs 앞쪽 1/3, %) */
  trendDelta: number | null;
  /** 파싱 전 원본 객체 — 디버깅 및 미매핑 필드 확인용 */
  raw: Record<string, unknown>;
};

/** 각 공식 API 소스의 호출 결과. UI 에서 어디까지 성공했는지 보여준다. */
export type SourceStatus = {
  id: "searchad" | "bid" | "search" | "datalab";
  label: string;
  /** 자격증명이 등록돼 있는지 */
  configured: boolean;
  /** 이번 조회에서 실제로 호출했고 성공했는지 */
  ok: boolean;
  /** 이번 조회에서 호출 자체를 하지 않았으면 true */
  skipped: boolean;
  message?: string;
};

export type KeywordFetchResult = {
  ok: boolean;
  seeds: string[];
  keywords: Keyword[];
  sources: SourceStatus[];
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
  /** JSON 문자열. `{question, answer}[]` */
  faq: string;
  /** 티스토리에 함께 붙여넣을 JSON-LD script 태그 */
  json_ld: string;
  /** JSON 문자열. `{title, uri}[]` — 그라운딩 출처 */
  sources: string;
  /** JSON 문자열. `{type, title, html}[]` — 정제된 시각 자료 */
  visuals: string;
  /** 자동 작성으로 만들어졌는지 (1/0) */
  auto_generated: number;
  created_at: string;
  updated_at: string;
};

export type GeneratedDraft = {
  title: string;
  metaDescription: string;
  tags: string[];
  bodyMarkdown: string;
  bodyHtml: string;
  /** 본문 하단 FAQ 섹션 겸 FAQPage 구조화 데이터의 원본. 모델이 안 주면 빈 배열 */
  faq: { question: string; answer: string }[];
  /** 본문을 보조하는 시각 자료. 화이트리스트로 정제된 HTML 만 담긴다 */
  visuals: { type: string; title: string; html: string }[];
  /** 티스토리 HTML 모드에 함께 붙여넣을 JSON-LD (script 태그 포함) */
  jsonLd: string;
  /** 1패스 그라운딩에서 참고한 출처. 그라운딩을 끄거나 실패하면 빈 배열 */
  sources: { title: string; uri: string }[];
  /** 1패스가 실제로 실행된 검색어. 어떤 근거로 썼는지 추적용 */
  searchQueries: string[];
};
