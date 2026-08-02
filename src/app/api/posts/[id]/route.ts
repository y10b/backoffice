import { NextResponse } from "next/server";
import { db, nowIso } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const row = db().prepare("SELECT * FROM posts WHERE id = ?").get(Number(id));
  if (!row) return NextResponse.json({ ok: false, error: "없는 글입니다." }, { status: 404 });
  return NextResponse.json({ ok: true, post: row });
}

const EDITABLE = [
  "main_keyword",
  "sub_keyword",
  "title",
  "body_html",
  "body_markdown",
  "meta_desc",
  "status",
  "posted_naver",
  "posted_tistory",
] as const;

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const sets: string[] = [];
  const values: (string | number)[] = [];

  for (const field of EDITABLE) {
    if (!(field in body)) continue;
    sets.push(`${field} = ?`);
    const v = body[field];
    values.push(typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : String(v));
  }

  if ("tags" in body) {
    sets.push("tags = ?");
    values.push(JSON.stringify(Array.isArray(body.tags) ? body.tags : []));
  }

  if (!sets.length) {
    return NextResponse.json({ ok: false, error: "변경할 필드가 없습니다." }, { status: 400 });
  }

  sets.push("updated_at = ?");
  values.push(nowIso());
  values.push(Number(id));

  db().prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  const row = db().prepare("SELECT * FROM posts WHERE id = ?").get(Number(id));
  return NextResponse.json({ ok: true, post: row });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  db().prepare("DELETE FROM posts WHERE id = ?").run(Number(id));
  return NextResponse.json({ ok: true });
}
