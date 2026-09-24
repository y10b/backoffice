import { NextResponse } from "next/server";
import { isTask, runTask } from "@/lib/devlog";
import { cronDenied } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 개발 로그 크론. GitHub Actions 가 하루 몇 번 부른다 (수집 · 초안 · 발행 · 동기화).
 *
 * daily-post 와 같은 구조다 — 러너에 소스를 체크아웃하지 않고, 이미 떠 있는 배포본의
 * 이 경로를 CRON_SECRET 으로 부른다. 판단은 전부 서버에 있고 워크플로는 curl 한 줄이다.
 */
export async function POST(req: Request) {
  const denied = cronDenied(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  if (!isTask(body.task)) {
    return NextResponse.json({ ok: false, error: "task 가 필요합니다." }, { status: 400 });
  }
  try {
    const result = await runTask(body.task, { date: typeof body.date === "string" ? body.date : undefined });
    // 발행 실패는 시끄럽게 — ok:false 로 답해 액션이 빨갛게 뜨게 한다
    const failed = body.task === "publish" && (result as { failed?: unknown[] }).failed?.length;
    return NextResponse.json({ ok: !failed, task: body.task, result });
  } catch (e) {
    return NextResponse.json({ ok: false, task: body.task, error: (e as Error).message });
  }
}
