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

  /*
   * 여러 개를 한 번에 받는다.
   *
   * AI 로 장면을 하나씩 만들면 한 편에 8개가 나온다. 하나씩 올리면 8번 눌러야 하고,
   * 그 사이 순서가 섞이면 조립이 어긋난다. 한 번에 받아 파일명 순으로 정렬한다.
   */
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) {
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

  /*
   * 브라우저가 넘기는 순서는 보장되지 않는다. `scene-1.mp4 … scene-10.mp4` 를
   * 사전순으로 정렬하면 10 이 2 앞에 오므로, 이름 속 숫자를 숫자로 비교한다.
   */
  const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
  files.sort((a, b) => collator.compare(a.name, b.name));

  const saved = [];
  const failed: { name: string; error: string }[] = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      saved.push(await saveSource(file.name, bytes, { origin, license }));
    } catch (e) {
      // 하나가 실패해도 나머지는 올린다. 8개 중 1개 때문에 전부 다시 올리게 하지 않는다
      failed.push({ name: file.name, error: (e as Error).message });
    }
  }

  if (!saved.length) {
    return NextResponse.json(
      { ok: false, error: failed[0]?.error ?? "저장에 실패했습니다.", failed },
      { status: 400 },
    );
  }
  // 단일 업로드 호출자가 아직 source 를 읽으므로 둘 다 내려준다
  return NextResponse.json({ ok: true, source: saved[0], sources: saved, failed });
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
