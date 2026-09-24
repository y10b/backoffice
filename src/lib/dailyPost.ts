/**
 * 매일 티스토리 초안 한 편.
 *
 * 네이버는 방문 후기 레인(visit_posts)이 담당하므로 키워드 기반 자동 초안은 티스토리뿐이다.
 *
 * 원래 `/api/cron/daily-post` 라우트 안에 있었다. 워크플로가 배포본 API 를 curl 로 부르던
 * 시절이라 로직이 서버에 있어야 했는데, 이제 러너가 scripts/daily-post.mjs 로 이 함수를
 * 직접 돌린다. 라우트는 이 함수를 부르는 얇은 껍데기다.
 *
 * 예전과 달라진 것:
 * - 하루 1편. Gemini 키 수만큼 여러 편 만들던 루프를 뺐다. 사람이 매일 손질해 올릴 수
 *   있는 양은 한 편이고, 안 올린 초안이 쌓이기만 했다. 키 로테이션은 geminiCall 이 한다.
 * - 키워드 고르는 기준. 월 검색 1,000 이상 · 수익 잠재력 순으로 뽑으면 레드오션만 나와
 *   유입이 0 이었다. 이제 월 검색 300 이상에서 광고 흡수율 낮은 순(정보성)으로 조회하고,
 *   그중 긴 키워드(롱테일)부터 고른다.
 *
 * SERP 경쟁 분석은 하지 않는다. 네이버 검색 페이지를 읽는 건데 실패해도 글은 나와야 하고,
 * 자동 실행에서는 사람이 결과를 보고 판단할 수도 없다.
 */
import { pickSubKeyword, researchKeywords } from "./research";
import { generateDraft, suggestSubKeywords } from "./gemini";
import { insertDraft, listPosts } from "./db";
import { seedForDate, seedPool } from "./seeds";
import { wordCount } from "./keywordPool";
import type { Keyword } from "./types";

/** 이 기간 안에 쓴 main_keyword 는 다시 고르지 않는다 */
const RECENT_DAYS = 60;
const MIN_SEARCHES = 300;

export type DailyPostResult = {
  ok: true;
  seed: string;
  postId: number;
  mainKeyword: string;
  subKeyword: string;
  subSearches: number | null;
  title: string;
  searches: number | null;
  bid: number | null;
  /** 광고 흡수율 % */
  absorption: number | null;
  sources: number;
  grounded: boolean;
};

/** 긴 키워드 먼저, 같으면 흡수율 낮은 것 먼저 (흡수율 없는 건 뒤로) */
function byLongThenAbsorption(a: Keyword, b: Keyword): number {
  const w = wordCount(b.keyword) - wordCount(a.keyword);
  if (w) return w;
  const av = a.adAbsorption;
  const bv = b.adAbsorption;
  if (av === null && bv === null) return (b.totalSearches ?? 0) - (a.totalSearches ?? 0);
  if (av === null) return 1;
  if (bv === null) return -1;
  return av - bv;
}

export async function writeDailyPost(
  opts: { seed?: string } = {},
): Promise<DailyPostResult> {
  const seed = opts.seed?.trim() || seedForDate(new Date(), await seedPool());

  /* 1. 정보성 키워드 후보 */
  const research = await researchKeywords({
    seeds: [seed],
    limit: 50,
    minSearches: MIN_SEARCHES,
    includeDocs: false,
    includeTrend: false,
    sort: "absorption",
  });
  if (!research.ok || !research.keywords.length) {
    throw new Error(`[키워드] ${seed}: ${research.error ?? "키워드를 찾지 못했습니다."}`);
  }

  /*
   * 최근에 쓴 주제는 건너뛴다. 같은 키워드로 이어 쓰면 자기 글끼리 경쟁하고
   * (cannibalization) 목록도 지저분해진다.
   */
  const since = Date.now() - RECENT_DAYS * 86_400_000;
  const recent = new Set(
    (await listPosts(300))
      .filter((p) => new Date(String(p.created_at)).getTime() >= since)
      .map((p) => String(p.main_keyword ?? "").trim()),
  );

  // 시드는 검색수 하한을 무시하고 붙어 오므로 여기서 다시 거른다
  const candidates = research.keywords
    .filter((k) => (k.totalSearches ?? 0) >= MIN_SEARCHES)
    .sort(byLongThenAbsorption);
  const picked =
    candidates.find((k) => !recent.has(k.keyword)) ?? candidates[0] ?? research.keywords[0];
  const mainKeyword = picked.keyword;

  /*
   * 부제는 같은 시드의 연관 키워드 중 검색량 최댓값. 실제로 그만큼 검색된다는 근거가
   * 숫자로 남는다. 모델에게 묻는 건 데이터가 안 나올 때만이다.
   */
  const bySearches = pickSubKeyword(mainKeyword, research.keywords);
  let subKeyword = bySearches?.keyword ?? "";
  const subSearches = bySearches?.searches ?? null;
  if (!subKeyword) {
    const context = research.keywords
      .map((k) => k.keyword)
      .filter((k) => k !== mainKeyword)
      .slice(0, 30);
    try {
      subKeyword = (await suggestSubKeywords(mainKeyword, context))[0]?.subKeyword ?? "";
    } catch {
      // 제안이 실패해도 메인 키워드만으로 쓴다. 한 편을 거르는 것보다 낫다
    }
  }

  /*
   * 재시도를 넉넉히 준다. 새벽에 혼자 돌고 실패하면 다음 기회가 24시간 뒤라,
   * 몇십 초 기다리는 값이 하루를 버리는 값보다 훨씬 싸다 (최근 실패는 전부 503 이었다).
   */
  const draft = await generateDraft({
    mainKeyword,
    subKeyword,
    targetChars: 2000,
    retries: 4,
  });
  const postId = await insertDraft({ channel: "tistory", mainKeyword, subKeyword, draft, auto: true });

  return {
    ok: true,
    seed,
    postId,
    mainKeyword,
    subKeyword,
    subSearches,
    title: draft.title,
    searches: picked.totalSearches,
    bid: picked.bid,
    absorption: picked.adAbsorption,
    sources: draft.sources?.length ?? 0,
    grounded: (draft.sources?.length ?? 0) > 0,
  };
}
