import { NextResponse } from "next/server";
import { isTask, runTask } from "@/lib/devlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 레포가 많으면 커밋 조회가 길다. Hobby 상한까지 준다 */
export const maxDuration = 300;

/**
 * 화면의 실행 버튼. 크론과 같은 함수를 돌린다 — 로그인 세션은 미들웨어가 확인한다.
 * 크론이 안 돌았거나 지금 당장 초안을 보고 싶을 때 쓴다.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (!isTask(body.task)) {
    return NextResponse.json({ ok: false, error: "task 는 collect · draft · publish · sync 중 하나입니다." }, { status: 400 });
  }
  try {
    const result = await runTask(body.task, { date: typeof body.date === "string" ? body.date : undefined });
    return NextResponse.json({ ok: true, task: body.task, result });
  } catch (e) {
    return NextResponse.json({ ok: false, task: body.task, error: (e as Error).message });
  }
}
