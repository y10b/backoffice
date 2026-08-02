import { NextResponse } from "next/server";
import { deleteSource, listSources, saveSource } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 원본 영상은 수백 MB 가 될 수 있어 업로드 자체가 오래 걸린다 */
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ ok: true, sources: await listSources() });
}

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

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "파일이 없습니다." }, { status: 400 });
  }

  const origin = String(form.get("origin") ?? "").trim();
  const license = String(form.get("license") ?? "").trim();
  if (!origin || !license) {
    /*
     * 출처와 라이선스를 비워두고 받으면, 나중에 이 파일을 어디서 가져왔는지 알 수 없다.
     * 공공누리는 출처 표시가 이용 조건이라 적어두지 않으면 쓸 수가 없다.
     */
    return NextResponse.json(
      { ok: false, error: "출처와 라이선스를 함께 적어야 합니다." },
      { status: 400 },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = await saveSource(file.name, bytes, { origin, license });
    return NextResponse.json({ ok: true, source: saved });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "";
  try {
    await deleteSource(name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
