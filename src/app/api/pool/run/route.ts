import { NextResponse } from "next/server";
import { collectKeywords } from "@/lib/keywordPool";
import { isChannel } from "@/lib/seeds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 시드 5개마다 검색광고 호출 + 입찰가 배치 + 1초 휴식이라 시드가 많으면 길어진다 */
export const maxDuration = 300;

/**
 * 키워드 수집을 지금 돌린다. 매일 도는 건 깃액션(keywords.yml)이고, 이건 시드를 바꾼 뒤
 * 바로 확인하고 싶을 때 쓰는 화면 버튼용이다. 세션 뒤에 있다 (미들웨어).
 *
 * body: { channel: "naver" | "tistory" }
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const channel = body.channel;
  if (!isChannel(channel)) {
    return NextResponse.json(
      { ok: false, error: "channel 은 naver 또는 tistory 입니다." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({ ok: true, result: await collectKeywords(channel) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
