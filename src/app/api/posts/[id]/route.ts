import { NextResponse } from "next/server";
import { deletePost, getPost, updatePost } from "@/lib/db";
import { parseVisuals } from "@/lib/visuals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const post = await getPost(Number(id));
    if (!post) {
      return NextResponse.json({ ok: false, error: "없는 글입니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, post });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

/** 화이트리스트 밖의 필드는 무시한다. 요청 본문이 그대로 컬럼이 되면 안 된다. */
const EDITABLE = [
  "main_keyword",
  "sub_keyword",
  "title",
  "body_html",
  "body_markdown",
  "meta_desc",
  "status",
] as const;

/** Postgres 에서는 boolean 컬럼이라 0/1 이 아니라 true/false 로 넣어야 한다. */
const BOOLEAN_FIELDS = ["posted_naver", "posted_tistory"] as const;

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const patch: Record<string, unknown> = {};
  for (const field of EDITABLE) {
    if (field in body) patch[field] = String(body[field] ?? "");
  }
  for (const field of BOOLEAN_FIELDS) {
    if (field in body) patch[field] = Boolean(body[field]);
  }
  // jsonb 컬럼이라 문자열로 감싸지 않고 배열 그대로 넘긴다
  if ("tags" in body) patch.tags = Array.isArray(body.tags) ? body.tags : [];
  /*
   * 시각 자료도 jsonb 다. 이걸 받지 않아서 글을 한 번 저장하면 자료가 사라졌다.
   * 모델이 만든 HTML 을 그대로 믿지 않고 여기서 다시 정제한다 — 클라이언트를 거쳐
   * 오는 값이라 중간에 무엇이 섞였는지 알 수 없다.
   */
  if ("visuals" in body) {
    patch.visuals = parseVisuals(body.visuals);
  }

  if (!Object.keys(patch).length) {
    return NextResponse.json(
      { ok: false, error: "변경할 필드가 없습니다." },
      { status: 400 },
    );
  }

  try {
    const post = await updatePost(Number(id), patch);
    if (!post) {
      return NextResponse.json({ ok: false, error: "없는 글입니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, post });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    await deletePost(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
