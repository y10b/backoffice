import { NextResponse } from "next/server";
import { deleteThreadsPost, listThreadsPosts, updateThreadsPost } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 쓰레드 제휴 게시물 후보.
 *
 * 후보를 만드는 쪽은 여기가 아니다 — 깃액션이 러너에서 네이버 검색광고와 Gemini 를
 * 직접 부르고 결과를 DB 에 넣는다. 이 라우트는 읽고 고치는 일만 한다.
 */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, posts: await listThreadsPosts() });
  } catch (e) {
    return NextResponse.json({ ok: false, posts: [], error: (e as Error).message });
  }
}

/** 손질 가능한 필드만 받는다. 근거 숫자(검색량·단가)는 뽑을 때 값이라 고치지 않는다 */
const EDITABLE = ["draft", "angle", "affiliate_url", "status"] as const;

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  for (const f of EDITABLE) {
    if (f in body) patch[f] = String(body[f] ?? "");
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ ok: false, error: "변경할 필드가 없습니다." }, { status: 400 });
  }

  try {
    const post = await updateThreadsPost(id, patch);
    if (!post) return NextResponse.json({ ok: false, error: "없는 후보입니다." }, { status: 404 });
    return NextResponse.json({ ok: true, post });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  }
  try {
    await deleteThreadsPost(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
