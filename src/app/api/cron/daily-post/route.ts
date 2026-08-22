import { NextResponse } from "next/server";
import { pickSubKeyword, researchKeywords } from "@/lib/research";
import { geminiKeys, generateDraft, suggestSubKeywords } from "@/lib/gemini";
import { insertDraft, listPosts } from "@/lib/db";
import { seedForDate } from "@/lib/seeds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 키워드 조회 + 그라운딩 + 본문 생성이 이어 돌아 오래 걸린다 (Hobby 상한이 300초) */
export const maxDuration = 300;

/**
 * 매일 한 편 자동 생성.
 *
 * GitHub Actions 가 하루 한 번 호출한다. 러너에 소스를 체크아웃하고 빌드할 필요가 없도록
 * 판단 로직을 전부 서버에 두고, 워크플로는 curl 한 줄만 남긴다.
 *
 * SERP 경쟁 분석은 하지 않는다. 그건 네이버 검색 페이지를 읽는 건데 실패해도 글은 나와야
 * 하고, 자동 실행에서는 사람이 결과를 보고 판단할 수도 없다. 대신 검색광고 데이터
 * (검색량 · 입찰가)만으로 고른다.
 */

function unauthorized() {
  return NextResponse.json(
    { ok: false, error: "인증이 필요합니다." },
    { status: 401 },
  );
}

export async function POST(req: Request) {
  /*
   * 미들웨어가 세션 쿠키로 막지만, 자동화는 브라우저가 아니라 쿠키를 못 만든다.
   * 그래서 이 경로만 별도 시크릿으로 연다. 없으면(로컬) 그냥 통과시킨다.
   */
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get("authorization") ?? "";
    if (header !== `Bearer ${secret}`) return unauthorized();
  }

  const body = await req.json().catch(() => ({}));
  const seed = String(body.seed ?? "").trim() || seedForDate(new Date());

  try {
    /* 1. 수익 잠재력 높은 키워드를 고른다 */
    const research = await researchKeywords({
      seeds: [seed],
      limit: 20,
      minSearches: 1000,
      includeDocs: false,
      includeTrend: false,
      sort: "revenue",
    });
    if (!research.ok || !research.keywords.length) {
      return NextResponse.json({
        ok: false,
        step: "keywords",
        seed,
        error: research.error ?? "키워드를 찾지 못했습니다.",
      });
    }

    /*
     * 최근에 쓴 주제는 건너뛴다. 같은 키워드로 이어 쓰면 자기 글끼리 경쟁하고
     * (cannibalization) 목록도 지저분해진다.
     */
    const recent = new Set(
      (await listPosts(60)).map((p) => String(p.main_keyword ?? "").trim()),
    );

    /*
     * 키 하나당 글 하나.
     *
     * 예전에는 키를 예비용으로 뒀다 — 첫 키가 429 를 뱉으면 다음 키로 넘겼다.
     * 그러면 첫 키가 다 마를 때까지 나머지 키의 무료 할당이 놀고, 넘어가는 순간은
     * 이미 그 키를 한 번 쓴 뒤라 순수한 낭비다.
     *
     * 키마다 다른 키워드로 따로 만들면 할당을 남김없이 쓰고 하루 결과물도 키 수만큼
     * 늘어난다. 한 키가 막혀도 나머지는 그대로 나온다 — 예전에는 한 번 실패하면
     * 그날 치가 통째로 없었다.
     */
    const keys = await geminiKeys();
    if (!keys.length) {
      return NextResponse.json({ ok: false, seed, error: "Gemini API 키가 없습니다." });
    }

    const picked: typeof research.keywords = [];
    for (const k of research.keywords) {
      if (picked.length >= keys.length) break;
      // 최근에 쓴 주제와, 이번 회차에서 이미 고른 주제를 함께 피한다
      if (recent.has(k.keyword) || picked.some((p) => p.keyword === k.keyword)) continue;
      picked.push(k);
    }
    // 후보가 모자라면 있는 만큼만 만든다. 같은 키워드로 두 편 쓰면 자기끼리 경쟁한다
    if (!picked.length) picked.push(research.keywords[0]);

    /*
     * 부제는 병렬 루프에 들어가기 전에 정한다. 안에서 각자 고르면 모두가 검색량
     * 최댓값을 집어 같은 부제를 달게 된다 — 실측으로 두 편 다 '아파트'였다.
     */
    const usedSubs = new Set<string>();
    const subs = picked.map((c) => {
      const s = pickSubKeyword(c.keyword, research.keywords, { exclude: usedSubs });
      if (s) usedSubs.add(s.keyword);
      return s;
    });

    const results = await Promise.all(
      picked.map(async (candidate, i) => {
        const apiKey = keys[i];
        const mainKeyword = candidate.keyword;

        /*
         * 부제로 쓸 서브 키워드.
         *
         * 검색광고 키워드도구가 준 연관 키워드에서 검색량이 가장 많은 것을 고른다.
         * 같은 시드에서 나왔으니 주제는 이미 비슷하고, 실제로 그만큼 검색된다는
         * 근거가 숫자로 남는다.
         *
         * 모델에게 물어보는 건 데이터가 안 나올 때만이다. 그 답은 그럴듯한 조합이지
         * 검색된다는 근거가 없고, 실패하면 빈 값이 된다.
         */
        const bySearches = subs[i];
        let subKeyword = bySearches?.keyword ?? "";
        let subSearches = bySearches?.searches ?? null;

        if (!subKeyword) {
          const context = research.keywords
            .map((k) => k.keyword)
            .filter((k) => k !== mainKeyword)
            .slice(0, 30);
          try {
            const suggestions = await suggestSubKeywords(mainKeyword, context, { apiKey });
            subKeyword = suggestions[0]?.subKeyword ?? "";
          } catch {
            // 제안이 실패해도 메인 키워드만으로 쓴다. 한 편을 거르는 것보다 낫다
          }
        }

        try {
          /*
           * 재시도를 넉넉히 준다. 이 경로는 새벽에 혼자 돌고 실패하면 다음 기회가
           * 24시간 뒤라, 몇십 초 기다리는 값이 하루를 버리는 값보다 훨씬 싸다.
           * 실제로 최근 실패가 전부 Gemini 503(일시 과부하) 하나였다.
           */
          const draft = await generateDraft({
            mainKeyword,
            subKeyword,
            targetChars: 2000,
            retries: 4,
            apiKey,
          });
          const postId = await insertDraft({ mainKeyword, subKeyword, draft, auto: true });
          return {
            ok: true as const,
            postId,
            mainKeyword,
            subKeyword,
            subSearches,
            title: draft.title,
            bid: candidate.bid,
            searches: candidate.totalSearches,
            sources: draft.sources?.length ?? 0,
            grounded: (draft.sources?.length ?? 0) > 0,
          };
        } catch (e) {
          // 한 키가 막혀도 나머지 결과는 살린다
          return { ok: false as const, mainKeyword, error: (e as Error).message };
        }
      }),
    );

    const made = results.filter((r) => r.ok);
    const first = made[0];

    return NextResponse.json({
      // 워크플로 요약이 읽는 필드들. 첫 결과를 대표로 펼친다
      ...(first ?? {}),
      // 한 편이라도 나왔으면 성공이다. 전멸일 때만 액션을 빨갛게 만든다.
      // 펼친 뒤에 둬야 first.ok 에 덮이지 않는다
      ok: made.length > 0,
      seed,
      keys: keys.length,
      created: made.length,
      results,
      error: made.length ? undefined : results[0]?.error,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, seed, error: (e as Error).message });
  }
}
