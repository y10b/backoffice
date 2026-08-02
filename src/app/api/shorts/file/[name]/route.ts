import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { resolveShort } from "@/lib/shorts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ name: string }> };

/** 렌더된 mp4 를 내려준다. 미리보기와 저장 양쪽에 쓴다 */
export async function GET(_req: Request, { params }: Ctx) {
  const { name } = await params;
  const full = resolveShort(decodeURIComponent(name));
  if (!full) {
    return NextResponse.json({ ok: false, error: "잘못된 파일 이름입니다." }, { status: 400 });
  }
  try {
    const bytes = await fs.readFile(full);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "video/mp4",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "없는 파일입니다." }, { status: 404 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { name } = await params;
  const full = resolveShort(decodeURIComponent(name));
  if (!full) {
    return NextResponse.json({ ok: false, error: "잘못된 파일 이름입니다." }, { status: 400 });
  }
  await fs.unlink(full).catch(() => {});
  return NextResponse.json({ ok: true });
}
