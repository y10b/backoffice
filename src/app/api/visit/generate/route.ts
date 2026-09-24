import { NextResponse } from "next/server";
import { getVisitPost, updateVisitPost } from "@/lib/db";
import { generateVisitDraft, type Interview, type PhotoAnalysis } from "@/lib/visit";
import type { Place } from "@/lib/kakao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 3단계 — 인터뷰 답을 받아 본문을 쓴다.
 *
 * 사실은 1단계에서 이미 다 모였다. 여기서 더해지는 건 사람만 아는 것 — 누구랑 갔고,
 * 뭐가 기억에 남고, 또 갈 건지. 네 줄이지만 이 글에서 유일하게 대체 불가능한 정보다.
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

    const draft = await generateVisitDraft({
      placeQuery: post.place_query,
      visitedOn: post.visited_on,
      analysis: post.analysis as unknown as PhotoAnalysis,
      place: (post.place as unknown as Place) ?? null,
      interview,
      situation,
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

    return NextResponse.json({ ok: true, post: saved, draft });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
