import { NextResponse } from "next/server";
import { deleteVelogPost, getVelogPost, listDevLogs, listVelogPosts, updateVelogPost } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 개발 로그 갈래의 읽기·손질.
 *
 * 만드는 쪽은 여기가 아니다 — 크론(/api/cron/devlog)이나 화면의 실행 버튼
 * (/api/devlog/run)이 lib/devlog 를 돌려 채운다. 이 라우트는 읽고 고치고 승인한다.
 */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  try {
    if (Number.isFinite(id) && id > 0) {
      const post = await getVelogPost(id);
      if (!post) return NextResponse.json({ ok: false, error: "없는 글입니다." }, { status: 404 });
      return NextResponse.json({ ok: true, post });
    }
    const [posts, logs] = await Promise.all([listVelogPosts(), listDevLogs()]);
    return NextResponse.json({ ok: true, posts, logs });
  } catch (e) {
    return NextResponse.json({ ok: false, posts: [], logs: [], error: (e as Error).message });
  }
}

/** 손질 가능한 필드만. 반응 수·URL 은 velog 가 정하는 값이라 여기서 안 고친다 */
const EDITABLE = ["title", "body_markdown", "tags", "status"] as const;
const STATUSES = new Set(["draft", "approved", "dropped"]);

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  for (const f of EDITABLE) {
    if (!(f in body)) continue;
    if (f === "tags") {
      patch.tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [];
    } else if (f === "status") {
      if (!STATUSES.has(String(body.status))) {
        return NextResponse.json({ ok: false, error: "알 수 없는 상태입니다." }, { status: 400 });
      }
      patch.status = String(body.status);
      // 다시 승인하면 지난 실패 사유는 지운다. 남겨두면 새 시도 결과와 섞인다
      if (body.status === "approved") patch.error = "";
    } else {
      patch[f] = String(body[f] ?? "");
    }
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ ok: false, error: "변경할 필드가 없습니다." }, { status: 400 });
  }

  try {
    // 이미 올라간 글은 상태를 되돌리지 않는다. approved 로 돌아가면 다음 아침에 또 올라간다
    if ("status" in patch) {
      const current = await getVelogPost(id);
      if (!current) return NextResponse.json({ ok: false, error: "없는 글입니다." }, { status: 404 });
      if (current.status === "published") {
        return NextResponse.json({ ok: false, error: "발행된 글의 상태는 바꿀 수 없습니다." }, { status: 400 });
      }
    }
    const post = await updateVelogPost(id, patch);
    if (!post) return NextResponse.json({ ok: false, error: "없는 글입니다." }, { status: 404 });
    return NextResponse.json({ ok: true, post });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
  }
  try {
    await deleteVelogPost(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
