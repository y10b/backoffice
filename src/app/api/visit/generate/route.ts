import { NextResponse } from "next/server";
import { getVisitPost, updateVisitPost } from "@/lib/db";
import { generateVisitDraft, researchVisit, type Interview, type PhotoAnalysis, type Revision } from "@/lib/visit";
import type { Place } from "@/lib/kakao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 3단계 — 인터뷰 답을 받아 본문을 쓴다.
 *
 * 사진에서 읽은 사실은 1단계에서 모였다. 여기서 두 가지가 더해진다.
 *  - 사람만 아는 것 — 누구랑 갔고, 뭐가 기억에 남고, 또 갈 건지
 *  - 검색으로 찾는 것 — 가게 소개, 메뉴가 어떤 음식인지, 위치. Gemini 가 조사하고
 *    GPT 는 그 결과를 받아 글만 쓴다
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  }

  const iv = (body.interview ?? {}) as Partial<Interview>;
  if (!iv.memorable?.trim()) {
    return NextResponse.json(
      { ok: false, error: "\"제일 기억나는 것\" 은 비울 수 없습니다. 이게 없으면 사실 나열이 됩니다." },
      { status: 400 },
    );
  }

  try {
    const post = await getVisitPost(id);
    if (!post) return NextResponse.json({ ok: false, error: "없는 초안입니다." }, { status: 404 });

    const interview: Interview = {
      company: String(iv.company ?? "혼자"),
      mealTime: String(iv.mealTime ?? "점심"),
      memorable: String(iv.memorable).trim(),
      revisit: String(iv.revisit ?? "근처 오면"),
      downside: String(iv.downside ?? "").trim(),
    };

    // 화면이 상황을 고쳐 보냈으면 그것을 쓴다. 안 보냈으면 분석 때 넣은 값 그대로
    const situation = typeof body.situation === "string" ? body.situation.trim() : post.situation;

    const analysis = post.analysis as unknown as PhotoAnalysis;
    const place = (post.place as unknown as Place) ?? null;

    /*
     * 수정 요청이면 지금 초안을 고쳐 쓴다. 조사는 다시 하지 않는다 — 조사 결과는 이미
     * 이전 초안에 녹아 있고, 고칠 때마다 Gemini 를 부르면 쿼터만 준다.
     */
    const request = String(body.revision?.request ?? "").trim();
    const revision: Revision | null =
      request && post.body_markdown
        ? {
            previous: String(post.body_markdown),
            target: String(body.revision?.target ?? "전체").trim() || "전체",
            request,
          }
        : null;
    const research = revision ? null : await researchVisit({ placeQuery: post.place_query, place, analysis });

    const draft = await generateVisitDraft({
      placeQuery: post.place_query,
      visitedOn: post.visited_on,
      analysis,
      place,
      interview,
      situation,
      research,
      revision,
    });

    const saved = await updateVisitPost(id, {
      interview,
      situation,
      titles: draft.titles,
      // 첫 안이 추천이다. 사람이 목록에서 바로 바꿀 수 있다
      title: draft.titles[0] ?? "",
      body_markdown: draft.bodyMarkdown,
      body_html: draft.bodyHtml,
      tags: draft.tags,
      photo_order: draft.photoOrder,
      needs_check: draft.needsCheck,
      status: "drafted",
    });

    return NextResponse.json({
      ok: true,
      post: saved,
      draft,
      // 저장하지 않는다. 화면에서 어떤 정보가 들어갔는지 확인하는 용도다
      research,
      revised: Boolean(revision),
      warnings:
        research || revision
          ? []
          : ["검색 조사에 실패해 사진과 답변만으로 썼습니다. Gemini 키·쿼터를 확인하세요."],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
