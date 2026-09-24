import { NextResponse } from "next/server";
import { deleteVisitPost, getVisitPost, listVisitPosts, updateVisitPost } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 방문 후기 초안 — 읽기와 손질.
 *
 * 만드는 쪽은 여기가 아니다. `analyze` 가 사진을 읽어 행을 만들고, `generate` 가
 * 본문을 채운다. 이 라우트는 목록·조회·수정·삭제만 한다.
 */

export async function GET(req: Request) {
  // `?id=` 가 없으면 get() 이 null 이고 Number(null) 은 0 이라 "조회" 분기로 빠졌다.
  // 그래서 목록 요청이 늘 { post: null } 을 돌려줬다. 양수일 때만 단건 조회다
  const id = Number(new URL(req.url).searchParams.get("id"));
  try {
    if (Number.isFinite(id) && id > 0) {
      return NextResponse.json({ ok: true, post: await getVisitPost(id) });
    }
    return NextResponse.json({ ok: true, posts: await listVisitPosts() });
  } catch (e) {
    return NextResponse.json({ ok: false, posts: [], error: (e as Error).message });
  }
}

/**
 * 손질 가능한 필드만 받는다.
 *
 * analysis 는 뺐다 — 사진에서 읽은 값이라 사람이 고치기 시작하면 "무엇이 근거였나"가
 * 흐려진다. 메뉴 가격이 틀렸으면 사진을 다시 올려 분석하는 쪽이 맞다.
 */
const EDITABLE = [
  "title",
  "body_markdown",
  "body_html",
  "tags",
  "situation",
  "status",
] as const;

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  for (const f of EDITABLE) {
    if (!(f in body)) continue;
    // tags 는 배열(jsonb)이라 문자열로 뭉개면 안 된다
    patch[f] = f === "tags" ? (Array.isArray(body[f]) ? body[f] : []) : String(body[f] ?? "");
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ ok: false, error: "변경할 필드가 없습니다." }, { status: 400 });
  }

  try {
    const post = await updateVisitPost(id, patch);
    if (!post) return NextResponse.json({ ok: false, error: "없는 초안입니다." }, { status: 404 });
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
    await deleteVisitPost(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
