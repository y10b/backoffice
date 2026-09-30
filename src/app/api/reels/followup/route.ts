import { NextResponse } from "next/server";
import { nextFollowup } from "@/lib/reels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 쭉 적은 썰 + 지금까지 되물은 것 → 다음에 물을 것 하나(또는 충분하다는 신호) */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const story = String(body.story ?? "").trim().slice(0, 6000);
  if (!story) return NextResponse.json({ ok: false, error: "썰을 먼저 적어 주세요." }, { status: 400 });
  const followups = (Array.isArray(body.followups) ? body.followups : [])
    .slice(0, 8)
    .map((f: { q?: unknown; a?: unknown }) => ({ q: String(f?.q ?? "").slice(0, 300), a: String(f?.a ?? "").slice(0, 1000) }));
  try {
    return NextResponse.json({ ok: true, ...(await nextFollowup(story, followups)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
