import { NextResponse } from "next/server";
import { insertVisitPost } from "@/lib/db";
import { analyzePhotos, checkPlace, type InputPhoto } from "@/lib/visit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 사진 여러 장을 비전 모델에 넘기면 20~40초가 걸린다. 기본 10초로는 못 끝낸다
export const maxDuration = 120;

/**
 * 1단계 — 사진을 읽어 사실을 복원한다.
 *
 * 사진은 화면에서 이미 축소해서 보낸다(긴 변 1024px, JPEG). 원본 그대로면 15장에
 * 40MB 가 넘어 요청이 통째로 거절되고, 비전 모델도 그만한 해상도를 쓰지 않는다.
 *
 * 분석만 하고 끝낸다. 본문 생성은 사람이 인터뷰에 답한 뒤 `generate` 가 한다 —
 * 감상 없이 쓴 후기는 사실 나열이 되고, 그게 AI 글의 전형이다.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const placeQuery = String(body.placeQuery ?? "").trim();
  const visitedOn = String(body.visitedOn ?? "").trim();
  const situation = String(body.situation ?? "").trim();
  const photos: InputPhoto[] = Array.isArray(body.photos) ? body.photos : [];

  if (!placeQuery) {
    return NextResponse.json({ ok: false, error: "장소명이나 주소를 넣어주세요." }, { status: 400 });
  }
  if (!visitedOn) {
    return NextResponse.json(
      { ok: false, error: "방문 날짜를 넣어주세요. \"2024년 가을쯤\" 처럼 대략이어도 됩니다." },
      { status: 400 },
    );
  }
  if (!photos.length) {
    return NextResponse.json({ ok: false, error: "사진을 한 장 이상 올려주세요." }, { status: 400 });
  }

  try {
    /*
     * 장소 조회와 사진 분석은 서로를 기다릴 이유가 없다. 사진 분석이 20초 넘게
     * 걸리는데 그 앞에 카카오 왕복을 직렬로 두면 그만큼 더 기다린다.
     */
    const [analysis, check] = await Promise.all([
      analyzePhotos(photos),
      checkPlace(placeQuery),
    ]);

    const warnings = [...check.warnings];
    /*
     * 가격 근거가 없으면 미리 알린다. 생성 단계에서 가격을 아예 빼도록 프롬프트가
     * 막고 있지만, 사용자가 메뉴판 사진을 다시 찾아볼 기회를 여기서 주는 게 낫다.
     */
    if (!analysis.menu.length) {
      warnings.push(
        "메뉴판·영수증 사진이 없어 가격 근거가 없습니다. 본문에 가격을 쓰지 않습니다. " +
          "찍어둔 메뉴판이 있으면 함께 올려주세요.",
      );
    }

    const id = await insertVisitPost({
      place_query: placeQuery,
      visited_on: visitedOn,
      situation,
      place: check.place,
      analysis,
      warnings,
      status: "analyzed",
    });

    return NextResponse.json({
      ok: true,
      id,
      analysis,
      place: check.place,
      candidates: check.candidates,
      warnings,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
