import { NextResponse } from "next/server";
import { listImages, saveImage } from "@/lib/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 보관 중인 이미지 목록 */
export async function GET() {
  return NextResponse.json({ ok: true, images: await listImages() });
}

/** 업로드. 한 번에 여러 장을 받는다 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "multipart/form-data 로 보내야 합니다." },
      { status: 400 },
    );
  }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) {
    return NextResponse.json({ ok: false, error: "파일이 없습니다." }, { status: 400 });
  }

  const saved: { name: string; url: string; size: number }[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await saveImage(file.name, bytes);
      saved.push({
        name: r.name,
        url: `/api/images/${encodeURIComponent(r.name)}`,
        size: r.size,
      });
    } catch (e) {
      // 한 장이 실패해도 나머지는 저장한다. 여러 장 올릴 때 전부 날리면 손해가 크다
      failed.push({ name: file.name, error: (e as Error).message });
    }
  }

  return NextResponse.json({
    ok: saved.length > 0,
    saved,
    failed,
    error: failed.length ? `${failed.length}장 실패: ${failed[0].error}` : undefined,
  });
}
