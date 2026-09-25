/**
 * 매일 티스토리 초안 한 편.
 *
 * 네이버는 방문 후기 레인(visit_posts)이 담당하므로 키워드 기반 자동 초안은 티스토리뿐이다.
 *
 * 원래 `/api/cron/daily-post` 라우트 안에 있었다. 워크플로가 배포본 API 를 curl 로 부르던
 * 시절이라 로직이 서버에 있어야 했는데, 이제 러너가 scripts/daily-post.mjs 로 이 함수를
 * 직접 돌린다. 라우트는 이 함수를 부르는 얇은 껍데기다. 발행은 사람이 한다.
 *
 * 키워드 고르는 순서 (앞에서 나오면 뒤는 안 본다):
 *  1. 글감 큐(post_queue)에서 done 이 아닌 첫 항목 — 사람이 아는 맥락(계산기·시즌)이 먼저다.
 *     쓰고 나면 done·postId 를 기록한다. note 는 본문 생성 추가 지시로 넘긴다.
 *  2. 유입 신호(topicSignals) — 서치콘솔에서 노출은 되는데 5~30위에 머무는 검색어 중 안 쓴 것.
 *     이미 구글이 이 블로그를 그 질문의 후보로 보고 있다는 뜻이라 가장 빨리 유입이 생긴다.
 *  3. 키워드 풀 — 광고 흡수율 2% 미만 · 단가 2,000원 이상 중 월 검색 × 단가 큰 순.
 *     한 단어짜리는 뒤로 민다(너무 넓어 개인 블로그가 못 뜬다).
 *  4. 셋 다 비면 예전 방식 — 날짜 시드로 연관 키워드를 조회해 같은 기준으로 고른다.
 *     `seed` 를 넘기면 1~3 을 건너뛰고 바로 이 경로다(수동 실행용).
 *
 * 예전 기준("흡수율 낮은 순 + 긴 키워드")은 유입은 조금 생겨도 단가가 낮아 수익이 0 에
 * 가까웠다. 정보성(흡수율 낮음)은 유지하되 단가 하한을 두고 검색×단가로 줄 세운다.
 *
 * 이미 올라간 글과 겹치면 (tistory_posts 제목에 키워드 핵심 토큰이 다 들어 있으면):
 *  - 큐 항목은 사람이 고른 것이라 그대로 쓰되 "기존 글 보강" 초안으로 만든다(rewrite_of = 그 글 URL).
 *    새 글로 또 올리면 같은 키워드 글이 둘이 되어 순위를 나눠 먹는다 — 기존 글 본문을 교체하라는 뜻이다.
 *  - 유입 신호·키워드 풀·시드 후보는 겹치는 것을 건너뛰고 다음 후보를 본다.
 *
 * SERP 경쟁 분석은 하지 않는다. 네이버 검색 페이지를 읽는 건데 실패해도 글은 나와야 하고,
 * 자동 실행에서는 사람이 결과를 보고 판단할 수도 없다.
 */
import { pickSubKeyword, researchKeywords } from "./research";
import { generateDraft, suggestSubKeywords } from "./gemini";
import { insertDraft, listKeywordPool, listPosts } from "./db";
import { seedForDate, seedPool } from "./seeds";
import { wordCount } from "./keywordPool";
import { topicSignals } from "./insights";
import { getQueue, setQueue, wantsCalculator } from "./postQueue";
import { insertCalculatorHtml, insertCalculatorMarkdown, pickCalculator } from "./calculators";
import { classifyCategory, loadTistoryTitles, overlapsIn, type Overlap } from "./tistory";
import type { Keyword } from "./types";

/** 이 기간 안에 쓴 main_keyword 는 다시 고르지 않는다 */
const RECENT_DAYS = 60;
const MIN_SEARCHES = 300;
/** 키워드 풀 기준: 광고 흡수율 상한(%) · 단가 하한(원) */
const MAX_ABSORPTION = 2;
const MIN_BID = 2000;
/** 풀에서 볼 기간 (last_seen) */
const POOL_DAYS = 30;

const bare = (s: string) => s.replace(/\s+/g, "");

export type DailyPostResult = {
  ok: true;
  /** 키워드를 어디서 골랐나 */
  source: "queue" | "signal" | "pool" | "seed";
  /** seed 경로일 때만 시드, 나머지는 빈 문자열 */
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
  /** 본문에 끼운 계산기 (없으면 null) */
  calculator: string | null;
  /** 초안이 들어갈 카테고리 추정 (classifyCategory) */
  category: string;
  /** 기존 글 보강 초안이면 그 글 — 새 글로 올리지 말고 이 글을 고친다 */
  rewriteOf?: { url: string; title: string };
};

/**
 * 검색 × 단가 큰 순. 한 단어짜리는 뒤로. 흡수율·단가 기준을 못 넘는 것은 호출 전에 거른다.
 */
function byValue(a: { searches: number | null; bid: number | null; word_count: number }, b: typeof a): number {
  const oneA = a.word_count <= 1 ? 1 : 0;
  const oneB = b.word_count <= 1 ? 1 : 0;
  if (oneA !== oneB) return oneA - oneB;
  return (b.searches ?? 0) * (b.bid ?? 0) - (a.searches ?? 0) * (a.bid ?? 0);
}

function passesValue(k: { adAbsorption: number | null; bid: number | null }): boolean {
  return k.adAbsorption !== null && k.adAbsorption < MAX_ABSORPTION && (k.bid ?? 0) >= MIN_BID;
}

type Choice = {
  source: DailyPostResult["source"];
  seed: string;
  keyword: string;
  note?: string;
  /** 풀·시드에서 고르면 수치를 이미 안다 */
  stats?: { searches: number | null; bid: number | null; absorption: number | null };
};

/** 최근에 쓴 main_keyword (공백 제거). 같은 키워드로 이어 쓰면 자기 글끼리 경쟁한다 */
async function recentKeywords(): Promise<Set<string>> {
  const since = Date.now() - RECENT_DAYS * 86_400_000;
  return new Set(
    (await listPosts(300))
      .filter((p) => new Date(String(p.created_at)).getTime() >= since)
      .map((p) => bare(String(p.main_keyword ?? ""))),
  );
}

async function pickFromQueue(): Promise<Choice | null> {
  const queue = await getQueue();
  const item = queue.find((q) => !q.done && q.keyword.trim());
  return item ? { source: "queue", seed: "", keyword: item.keyword, note: item.note } : null;
}

/** 이미 올라간 글과 겹치는 키워드인가. 글 목록을 못 읽었으면(표 없음) 겹침 없음으로 본다 */
type OverlapCheck = (keyword: string) => boolean;

async function pickFromSignals(recent: Set<string>, overlaps: OverlapCheck): Promise<Choice | null> {
  const signals = await topicSignals({ limit: 10 });
  const hit = signals.find((s) => !recent.has(bare(s.query)) && !overlaps(s.query));
  return hit ? { source: "signal", seed: "", keyword: hit.query } : null;
}

async function pickFromPool(recent: Set<string>, overlaps: OverlapCheck): Promise<Choice | null> {
  const rows = (await listKeywordPool({ days: POOL_DAYS, sort: "value", limit: 500 }))
    .filter((r) => (r.bid ?? 0) >= MIN_BID && !recent.has(bare(r.keyword)) && !overlaps(r.keyword))
    .sort(byValue);
  const r = rows[0];
  return r
    ? {
        source: "pool",
        seed: r.seed,
        keyword: r.keyword,
        stats: { searches: r.searches, bid: r.bid, absorption: r.ad_absorption },
      }
    : null;
}

/** 예전 경로: 날짜 시드 → 연관 키워드 → 같은 기준(흡수·단가·검색×단가)으로 고른다 */
async function pickFromSeed(
  seed: string,
  recent: Set<string>,
  overlaps: OverlapCheck,
): Promise<{ pick: Choice; related: Keyword[] }> {
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
  // 시드는 검색수 하한을 무시하고 붙어 오므로 여기서 다시 거른다
  const all = research.keywords.filter((k) => (k.totalSearches ?? 0) >= MIN_SEARCHES);
  const asRow = (k: Keyword) => ({ searches: k.totalSearches, bid: k.bid, word_count: wordCount(k.keyword) });
  const strict = all.filter(passesValue).sort((a, b) => byValue(asRow(a), asRow(b)));
  // 기준을 넘는 게 없으면 흡수율 낮은 순으로라도 한 편은 쓴다 — 하루를 거르는 것보다 낫다
  const loose = [...all].sort(
    (a, b) => (a.adAbsorption ?? Infinity) - (b.adAbsorption ?? Infinity),
  );
  // 겹치는 후보는 건너뛴다. 전부 겹치면 아래 all[0] 로 떨어져 보강 초안이 된다
  const fresh = (k: Keyword) => !recent.has(bare(k.keyword)) && !overlaps(k.keyword);
  const picked =
    strict.find(fresh) ??
    loose.find(fresh) ??
    all[0] ??
    research.keywords[0];
  return {
    pick: {
      source: "seed",
      seed,
      keyword: picked.keyword,
      stats: { searches: picked.totalSearches, bid: picked.bid, absorption: picked.adAbsorption },
    },
    related: research.keywords,
  };
}

/** 고른 키워드 자체로 연관 키워드를 조회한다 — 부제 후보와 검색량·단가를 얻으려고. 실패해도 글은 쓴다 */
async function relatedOf(keyword: string): Promise<Keyword[]> {
  try {
    const r = await researchKeywords({
      seeds: [keyword],
      limit: 50,
      minSearches: 0,
      includeDocs: false,
      includeTrend: false,
      sort: "searches",
    });
    return r.ok ? r.keywords : [];
  } catch {
    return [];
  }
}

export async function writeDailyPost(
  opts: { seed?: string } = {},
): Promise<DailyPostResult> {
  const recent = await recentKeywords();
  const explicitSeed = opts.seed?.trim();

  // 올라간 글 제목. 표가 없거나(마이그레이션 전) 비어 있으면 겹침 검사 없이 예전처럼 간다
  let existing: Overlap[] = [];
  try {
    existing = await loadTistoryTitles();
  } catch {
    existing = [];
  }
  const overlaps: OverlapCheck = (k) => overlapsIn(k, existing).length > 0;

  /* 1. 키워드 고르기 — 큐 → 유입 신호 → 키워드 풀 → 시드 */
  let pick: Choice | null = null;
  let related: Keyword[] | null = null;
  const skipped: string[] = [];

  if (!explicitSeed) {
    try {
      pick = await pickFromQueue();
    } catch (e) {
      skipped.push(`큐: ${(e as Error).message}`);
    }
    // 신호·풀은 표가 없거나(마이그레이션 전) 비어 있을 수 있다. 실패는 다음 단계로 넘긴다
    if (!pick) {
      try {
        pick = await pickFromSignals(recent, overlaps);
      } catch (e) {
        skipped.push(`유입 신호: ${(e as Error).message}`);
      }
    }
    if (!pick) {
      try {
        pick = await pickFromPool(recent, overlaps);
      } catch (e) {
        skipped.push(`키워드 풀: ${(e as Error).message}`);
      }
    }
  }
  if (!pick) {
    const seed = explicitSeed || seedForDate(new Date(), await seedPool());
    try {
      const r = await pickFromSeed(seed, recent, overlaps);
      pick = r.pick;
      related = r.related;
    } catch (e) {
      const why = skipped.length ? ` (앞 단계: ${skipped.join(" / ")})` : "";
      throw new Error(`${(e as Error).message}${why}`);
    }
  }

  const mainKeyword = pick.keyword;
  // 큐 항목(사람이 고른 것)이거나 시드 후보가 전부 겹쳤을 때만 여기 걸린다 — 새 글 대신 개정판
  const rewrite = overlapsIn(mainKeyword, existing)[0];
  if (!related) related = await relatedOf(mainKeyword);
  // 큐·신호에서 고르면 수치를 모른다. 키워드도구가 그 키워드 자체를 돌려주면 거기서 채운다
  const self = related.find((k) => bare(k.keyword) === bare(mainKeyword));
  const stats = pick.stats ?? {
    searches: self?.totalSearches ?? null,
    bid: self?.bid ?? null,
    absorption: self?.adAbsorption ?? null,
  };

  /*
   * 2. 부제는 연관 키워드 중 검색량 최댓값. 실제로 그만큼 검색된다는 근거가
   * 숫자로 남는다. 모델에게 묻는 건 데이터가 안 나올 때만이다.
   */
  const bySearches = pickSubKeyword(mainKeyword, related);
  let subKeyword = bySearches?.keyword ?? "";
  const subSearches = bySearches?.searches ?? null;
  if (!subKeyword) {
    const context = related
      .map((k) => k.keyword)
      .filter((k) => k !== mainKeyword)
      .slice(0, 30);
    try {
      subKeyword = (await suggestSubKeywords(mainKeyword, context))[0]?.subKeyword ?? "";
    } catch {
      // 제안이 실패해도 메인 키워드만으로 쓴다. 한 편을 거르는 것보다 낫다
    }
  }

  /* 3. 본문 */
  const calculator = wantsCalculator(pick.note) ? pickCalculator(mainKeyword) : null;
  const extraInstruction = [
    rewrite
      ? `이 글은 기존 글 "${rewrite.title}"을 대체할 개정판이다. 최신 기준으로 더 충실하게, 같은 주제를 한 편으로.`
      : "",
    pick.note?.trim() ?? "",
    // 계산기는 생성 뒤에 코드가 끼운다. 모델이 표나 가짜 입력칸으로 계산기를 흉내 내지 않게 막는다
    calculator
      ? "본문 첫 소제목 앞에 실제로 동작하는 계산기가 자동으로 삽입된다. 계산기를 직접 만들지 말고, 계산 방법·예시 숫자·결과 해석을 설명할 것."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  /*
   * 재시도를 넉넉히 준다. 새벽에 혼자 돌고 실패하면 다음 기회가 24시간 뒤라,
   * 몇십 초 기다리는 값이 하루를 버리는 값보다 훨씬 싸다 (최근 실패는 전부 503 이었다).
   */
  const draft = await generateDraft({
    mainKeyword,
    subKeyword,
    targetChars: 2000,
    retries: 4,
    extraInstruction: extraInstruction || undefined,
  });
  if (calculator) {
    draft.bodyHtml = insertCalculatorHtml(draft.bodyHtml, calculator);
    draft.bodyMarkdown = insertCalculatorMarkdown(draft.bodyMarkdown, calculator);
  }
  const category = classifyCategory(mainKeyword, draft.title);
  const postId = await insertDraft({
    channel: "tistory",
    mainKeyword,
    subKeyword,
    draft,
    auto: true,
    category,
    rewriteOf: rewrite?.url ?? "",
  });

  /*
   * 4. 큐 항목 완료 표시. 초안이 저장된 뒤에만 한다 — 먼저 표시하면 생성 실패 시 항목이 사라진다.
   * 생성하는 동안 화면에서 큐를 고쳤을 수 있어 다시 읽어 키워드로 찾는다.
   */
  if (pick.source === "queue") {
    try {
      const latest = await getQueue();
      const i = latest.findIndex((q) => !q.done && bare(q.keyword) === bare(mainKeyword));
      if (i >= 0) {
        latest[i] = { ...latest[i], done: true, postId };
        await setQueue(latest);
      }
    } catch {
      // 표시가 실패하면 다음 날 같은 항목을 또 쓴다 (큐는 사람이 고른 것이라 60일 중복 검사를 걸지 않는다).
      // 초안은 이미 저장됐으니 여기서 던져 결과까지 버리지는 않는다
    }
  }

  return {
    ok: true,
    source: pick.source,
    seed: pick.seed,
    postId,
    mainKeyword,
    subKeyword,
    subSearches,
    title: draft.title,
    searches: stats.searches,
    bid: stats.bid,
    absorption: stats.absorption,
    sources: draft.sources?.length ?? 0,
    grounded: (draft.sources?.length ?? 0) > 0,
    calculator,
    category,
    ...(rewrite ? { rewriteOf: { url: rewrite.url, title: rewrite.title } } : {}),
  };
}
