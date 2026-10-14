import { NextResponse } from "next/server";
import { getVisitPost, updateVisitPost } from "@/lib/db";
import { putQueued, removeQueued, unfilledReason } from "@/lib/naverQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 네이버 자동 발행 대기열에 넣고 뺀다. 넣으면 "올릴 준비"(ready) 가 되고, 매일 루틴이
 * 하나씩 올린다(.claude/skills/naver-publish). html 은 화면이 만든 네이버용 완성본이다.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const html = String(body.html ?? "");
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  if (html.length < 300) return NextResponse.json({ ok: false, error: "본문이 비어 있습니다." }, { status: 400 });
  const unfilled = unfilledReason(html);
  if (unfilled) return NextResponse.json({ ok: false, error: unfilled }, { status: 400 });

  try {
    const row = await getVisitPost(id);
    if (!row) return NextResponse.json({ ok: false, error: "없는 초안입니다." }, { status: 404 });
    if (row.status === "posted") return NextResponse.json({ ok: false, error: "이미 올린 글입니다." }, { status: 400 });
    await putQueued(id, html);
    const post = await updateVisitPost(id, { status: "ready" });
    return NextResponse.json({ ok: true, post });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  try {
    await removeQueued(id);
    const post = await updateVisitPost(id, { status: "drafted" });
    return NextResponse.json({ ok: true, post });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
