import { NextResponse } from "next/server";
import { db, nowIso } from "@/lib/db";
import { researchKeywords, type SortKey } from "@/lib/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORT_KEYS: SortKey[] = [
  "searches",
  "competition",
  "docs",
  "mobile",
  "absorption",
];

function parseSeeds(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((s) => String(s));
  if (typeof input === "string") return input.split(/[,\n]/);
  return [];
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  // Number(null) 과 Number("") 은 0 이라 그냥 두면 값이 최소치로 눌린다.
  // JSON 에 null 이 실려 오는 경우가 있어 숫자 변환 전에 걸러낸다.
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const seeds = parseSeeds(body.seeds).map((s) => s.trim()).filter(Boolean);
  if (!seeds.length) {
    return NextResponse.json(
      {
        ok: false,
        seeds: [],
        keywords: [],
        sources: [],
        error: "시드 키워드를 하나 이상 입력하세요. (최대 5개)",
      },
      { status: 400 },
    );
  }

  const sort = SORT_KEYS.includes(body.sort) ? (body.sort as SortKey) : "searches";
  const result = await researchKeywords({
    seeds,
    limit: clamp(body.limit, 5, 200, 50),
    minSearches: clamp(body.minSearches, 0, 1_000_000, 100),
    includeDocs: body.includeDocs !== false,
    includeTrend: body.includeTrend === true,
    sort,
  });

  if (result.ok && result.keywords.length) {
    db()
      .prepare(
        "INSERT INTO keyword_snapshots (fetched_at, seeds, count, payload) VALUES (?, ?, ?, ?)",
      )
      .run(
        nowIso(),
        result.seeds.join(", "),
        result.keywords.length,
        JSON.stringify(result.keywords),
      );
  }

  return NextResponse.json(result);
}

/**
 * 저장된 스냅샷 목록. `?latest=1` 이면 가장 최근 것의 키워드까지 함께 준다.
 * 화면에 들어오자마자 지난 조회 결과를 보여주기 위한 것이라, API 를 다시 때리지 않는다.
 */
export async function GET(req: Request) {
  const wantLatest = new URL(req.url).searchParams.get("latest") === "1";

  const rows = db()
    .prepare(
      "SELECT id, fetched_at, seeds, count FROM keyword_snapshots ORDER BY id DESC LIMIT 30",
    )
    .all();

  if (!wantLatest || !rows.length) return NextResponse.json({ snapshots: rows });

  const row = db()
    .prepare("SELECT seeds, fetched_at, payload FROM keyword_snapshots ORDER BY id DESC LIMIT 1")
    .get() as { seeds: string; fetched_at: string; payload: string } | undefined;

  let keywords: unknown[] = [];
  try {
    const parsed = JSON.parse(row?.payload ?? "[]");
    if (Array.isArray(parsed)) keywords = parsed;
  } catch {
    /* 저장이 깨졌으면 빈 표로 시작하고 목록만 준다 */
  }

  return NextResponse.json({
    snapshots: rows,
    latest: row
      ? {
          seeds: row.seeds.split(",").map((s) => s.trim()).filter(Boolean),
          fetchedAt: row.fetched_at,
          keywords,
        }
      : null,
  });
}
