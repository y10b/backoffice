import { NextResponse } from "next/server";
import { collectKeywords } from "@/lib/keywordPool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 시드 5개마다 검색광고 호출 + 입찰가 배치 + 1초 휴식이라 시드가 많으면 길어진다 */
export const maxDuration = 300;

/**
 * 키워드 수집을 지금 돌린다. 매일 도는 건 깃액션(keywords.yml)이고, 이건 시드를 바꾼 뒤
 * 바로 확인하고 싶을 때 쓰는 화면 버튼용이다. 세션 뒤에 있다 (미들웨어).
 *
 * body 없음. 시드는 설정 표 seeds_tistory (비면 코드 기본값).
 */
export async function POST() {
  try {
    return NextResponse.json({ ok: true, result: await collectKeywords() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}
