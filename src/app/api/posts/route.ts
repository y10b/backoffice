import { NextResponse } from "next/server";
import { insertDraft, listPosts } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ posts: await listPosts() });
  } catch (e) {
    return NextResponse.json({ posts: [], error: (e as Error).message });
  }
}

/** 화면에서 직접 저장하는 경로. 자동 생성분과 같은 저장 함수를 써서 컬럼이 어긋나지 않게 한다. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    const id = await insertDraft({
      mainKeyword: String(body.main_keyword ?? ""),
      subKeyword: String(body.sub_keyword ?? ""),
      draft: {
        title: String(body.title ?? ""),
        bodyHtml: String(body.body_html ?? ""),
        bodyMarkdown: String(body.body_markdown ?? ""),
        tags: Array.isArray(body.tags) ? body.tags : [],
        metaDescription: String(body.meta_desc ?? ""),
        faq: Array.isArray(body.faq) ? body.faq : [],
        jsonLd: String(body.json_ld ?? ""),
        sources: Array.isArray(body.sources) ? body.sources : [],
        visuals: Array.isArray(body.visuals) ? body.visuals : [],
      },
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
