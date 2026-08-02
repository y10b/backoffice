import { NextResponse } from "next/server";
import { generateDraft } from "@/lib/gemini";
import { insertDraft } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mainKeyword = String(body.mainKeyword ?? "").trim();
  const subKeyword = String(body.subKeyword ?? "").trim();

  if (!mainKeyword) {
    return NextResponse.json({ ok: false, error: "메인 키워드를 입력하세요." }, { status: 400 });
  }

  try {
    const draft = await generateDraft({
      mainKeyword,
      subKeyword,
      tone: body.tone,
      targetChars: body.targetChars ? Number(body.targetChars) : undefined,
      outline: body.outline,
    });

    let postId: number | null = null;
    if (body.save !== false) {
      postId = await insertDraft({ mainKeyword, subKeyword, draft });
    }

    return NextResponse.json({ ok: true, draft, postId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
