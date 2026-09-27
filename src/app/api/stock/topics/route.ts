import { NextResponse } from "next/server";
import { upcomingTopics } from "@/lib/stock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 지금 만들어 올릴 시즌 주제. 앞으로 석 달 안에 수요가 몰리는 것을 추세와 함께 */
export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await upcomingTopics()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
