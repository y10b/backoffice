import { NextResponse } from "next/server";
import { db, nowIso } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = db()
    .prepare(
      `SELECT id, main_keyword, sub_keyword, title, meta_desc, tags, status,
              posted_naver, posted_tistory, created_at, updated_at
       FROM posts ORDER BY updated_at DESC LIMIT 200`,
    )
    .all();
  return NextResponse.json({ posts: rows });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ts = nowIso();
  const info = db()
    .prepare(
      `INSERT INTO posts
         (main_keyword, sub_keyword, title, body_html, body_markdown, tags, meta_desc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(body.main_keyword ?? ""),
      String(body.sub_keyword ?? ""),
      String(body.title ?? ""),
      String(body.body_html ?? ""),
      String(body.body_markdown ?? ""),
      JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
      String(body.meta_desc ?? ""),
      String(body.status ?? "draft"),
      ts,
      ts,
    );
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
