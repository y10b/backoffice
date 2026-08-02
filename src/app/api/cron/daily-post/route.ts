import { NextResponse } from "next/server";
import { researchKeywords } from "@/lib/research";
import { generateDraft, suggestSubKeywords } from "@/lib/gemini";
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
    const candidate =
      research.keywords.find((k) => !recent.has(k.keyword)) ?? research.keywords[0];
    const mainKeyword = candidate.keyword;

    /* 2. 서브 키워드 */
    const context = research.keywords
      .map((k) => k.keyword)
      .filter((k) => k !== mainKeyword)
      .slice(0, 30);
    let subKeyword = "";
    try {
      const suggestions = await suggestSubKeywords(mainKeyword, context);
      subKeyword = suggestions[0]?.subKeyword ?? "";
    } catch {
      // 제안이 실패해도 메인 키워드만으로 쓴다. 하루 한 편을 거르는 것보다 낫다
    }

    /* 3. 본문 (그라운딩 포함) */
    const draft = await generateDraft({ mainKeyword, subKeyword, targetChars: 2000 });

    const postId = await insertDraft({ mainKeyword, subKeyword, draft, auto: true });

    return NextResponse.json({
      ok: true,
      seed,
      postId,
      mainKeyword,
      subKeyword,
      title: draft.title,
      bid: candidate.bid,
      searches: candidate.totalSearches,
      sources: draft.sources?.length ?? 0,
      grounded: (draft.sources?.length ?? 0) > 0,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, seed, error: (e as Error).message });
  }
}
