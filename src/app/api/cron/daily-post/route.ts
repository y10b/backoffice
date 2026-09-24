import { NextResponse } from "next/server";
import { writeDailyPost } from "@/lib/dailyPost";
import { isChannel } from "@/lib/seeds";
import { cronDenied } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 키워드 조회 + 그라운딩 + 본문 생성이 이어 돌아 오래 걸린다 (Hobby 상한이 300초) */
export const maxDuration = 300;

/**
 * 채널 하나에 하루 한 편. 로직은 src/lib/dailyPost.ts 에 있다.
 *
 * 매일 도는 건 깃액션이 러너에서 scripts/daily-post.mjs 로 직접 돌린다.
 * 이 경로는 수동으로 한 번 더 돌리고 싶을 때를 위해 남겨 둔다.
 *
 * body: { channel?: "naver" | "tistory" (기본 tistory), seed?: string }
 */
export async function POST(req: Request) {
  /*
   * 미들웨어가 세션 쿠키로 막지만, 자동화는 브라우저가 아니라 쿠키를 못 만든다.
   * 그래서 이 경로만 별도 시크릿으로 연다. 없으면(로컬) 그냥 통과시킨다.
   */
  const denied = cronDenied(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const channel = body.channel ?? "tistory";
  if (!isChannel(channel)) {
    return NextResponse.json(
      { ok: false, error: "channel 은 naver 또는 tistory 입니다." },
      { status: 400 },
    );
  }
  const seed = String(body.seed ?? "").trim() || undefined;

  try {
    return NextResponse.json(await writeDailyPost(channel, { seed }));
  } catch (e) {
    return NextResponse.json({ ok: false, channel, seed, error: (e as Error).message });
  }
}
