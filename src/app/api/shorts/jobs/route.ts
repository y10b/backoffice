import { NextResponse } from "next/server";
import { enqueueRenderJob, listRenderJobs } from "@/lib/db";
import { parseRenderOptions } from "@/lib/shorts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 렌더 작업 큐.
 *
 * 배포본에는 ffmpeg 가 없으므로 여기서는 직접 렌더하지 않고 작업만 쌓는다.
 * 로컬 워커(`npm run worker`)가 가져가 처리하고 결과를 되돌려 놓는다.
 */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, jobs: await listRenderJobs() });
  } catch (e) {
    return NextResponse.json({ ok: false, jobs: [], error: (e as Error).message });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const input = String(body.input ?? "").trim();
  if (!input) {
    return NextResponse.json(
      { ok: false, error: "원본 영상 주소(input)가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    // 큐에는 정리된 옵션을 그대로 넣는다. 워커가 같은 함수로 다시 읽는다
    const id = await enqueueRenderJob({ ...parseRenderOptions(body), input });
    return NextResponse.json({
      ok: true,
      id,
      message:
        "작업을 등록했습니다. 로컬에서 `npm run worker` 가 떠 있으면 곧 처리됩니다.",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
