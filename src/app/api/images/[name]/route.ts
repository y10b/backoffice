import { NextResponse } from "next/server";
import { deleteImage, readImage } from "@/lib/images";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { name } = await params;
  const file = await readImage(decodeURIComponent(name));
  if (!file) {
    return NextResponse.json({ ok: false, error: "없는 이미지입니다." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.contentType,
      // 파일명에 난수가 들어가 내용이 바뀌면 이름도 바뀐다. 길게 캐시해도 안전하다
      "cache-control": "public, max-age=31536000, immutable",
      // 이미지가 아닌 것이 섞여도 브라우저가 추측해 실행하지 않게 막는다
      "x-content-type-options": "nosniff",
    },
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { name } = await params;
  try {
    await deleteImage(decodeURIComponent(name));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 },
    );
  }
}
