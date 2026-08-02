import { NextResponse } from "next/server";
import { db, nowIso } from "@/lib/db";
import { buildUrl, fetchCreatorAdvisor, loadPresets } from "@/lib/naver";
import { parseCurl } from "@/lib/curl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function todayKst(): string {
  // 네이버 통계는 KST 기준이라 UTC 로 계산하면 하루가 밀린다
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  let url: string;
  let presetId = String(body.presetId ?? "");
  const label = String(body.label ?? "");

  if (typeof body.curl === "string" && body.curl.trim()) {
    // cURL 붙여넣기 경로: URL 을 그대로 쓰되 쿠키는 저장된 것을 쓴다
    try {
      const parsed = parseCurl(body.curl);
      url = parsed.url;
      presetId = "curl";
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `cURL 파싱 실패: ${(e as Error).message}` },
        { status: 400 },
      );
    }
  } else {
    const presets = loadPresets();
    const preset = presets.find((p) => p.id === presetId) ?? presets[0];
    if (!preset) {
      return NextResponse.json(
        { ok: false, error: "사용 가능한 엔드포인트 프리셋이 없습니다." },
        { status: 400 },
      );
    }
    presetId = preset.id;

    // 어제 데이터가 기본. 당일 통계는 집계 전이라 비는 경우가 많다.
    const date = String(body.date ?? shiftDate(todayKst(), -1));
    const days = Number(body.days ?? 7);
    url = buildUrl(preset, {
      date,
      dateStart: shiftDate(date, -(days - 1)),
      dateEnd: date,
      categoryId: body.categoryId ? String(body.categoryId) : undefined,
      limit: String(body.limit ?? 30),
    });
  }

  const result = await fetchCreatorAdvisor(url);

  if (result.ok && result.keywords.length) {
    db()
      .prepare(
        "INSERT INTO keyword_snapshots (fetched_at, preset, category_id, label, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        nowIso(),
        presetId,
        body.categoryId ? String(body.categoryId) : null,
        label,
        JSON.stringify(result.keywords),
      );
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 200 });
}

/** 저장된 스냅샷 목록 */
export async function GET() {
  const rows = db()
    .prepare(
      "SELECT id, fetched_at, preset, category_id, label FROM keyword_snapshots ORDER BY id DESC LIMIT 30",
    )
    .all();
  return NextResponse.json({ snapshots: rows });
}
