import { NextResponse } from "next/server";
import { generateDraft, suggestSubKeywords } from "@/lib/gemini";
import { insertDraft } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 제안(/api/suggest 기준 120초)과 본문(/api/generate 기준 300초)을 한 요청 안에서
 * 연달아 돌리므로 둘 중 큰 값으로는 모자란다. 합보다 조금 여유를 둔다.
 */
export const maxDuration = 600;

type Suggestion = { subKeyword: string; title: string; reason: string };

/** 실패 지점을 사용자에게 그대로 보여주려고 단계마다 이름을 붙인다 */
type Step = "suggest" | "generate" | "save";
const STEP_LABEL: Record<Step, string> = {
  suggest: "서브 키워드 제안",
  generate: "본문 생성",
  save: "글 저장",
};

/** 어느 단계에서 멈췄는지 메시지 앞에 박아 둔다. step 은 화면에서 분기하고 싶을 때 쓰라고 함께 반환 */
function fail(step: Step, e: unknown) {
  return NextResponse.json(
    { ok: false, step, error: `[${STEP_LABEL[step]}] ${(e as Error).message}` },
    { status: 500 },
  );
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mainKeyword = String(body.mainKeyword ?? "").trim();
  if (!mainKeyword) {
    return NextResponse.json(
      { ok: false, step: "input", error: "메인 키워드를 입력하세요." },
      { status: 400 },
    );
  }
  const context = Array.isArray(body.context) ? body.context.map(String) : [];

  // 1) 서브 키워드 후보
  let suggestions: Suggestion[] = [];
  try {
    suggestions = await suggestSubKeywords(mainKeyword, context);
  } catch (e) {
    return fail("suggest", e);
  }

  // 2) 첫 번째 후보를 쓴다. Gemini 프롬프트가 "경쟁이 덜한 순"으로 추천하게 되어 있어
  //    반환 순서 자체가 추천 순위다. 여기서 별도 점수로 재정렬하면 근거 없는 뒤집기가 된다.
  //    후보 전체를 함께 돌려주므로 선택이 마음에 안 들면 화면에서 다른 후보로 재생성하면 된다.
  //    후보가 비면(모델이 빈 배열을 준 경우) 서브 키워드 없이 메인만으로 진행한다.
  const subKeyword = suggestions[0]?.subKeyword?.trim() ?? "";

  // 3) 본문 생성
  let draft;
  try {
    draft = await generateDraft({
      mainKeyword,
      subKeyword,
      tone: body.tone,
      targetChars: body.targetChars ? Number(body.targetChars) : undefined,
      outline: body.outline,
    });
  } catch (e) {
    return fail("generate", e);
  }

  // 4) 저장은 /api/generate 와 같은 컬럼·같은 status 로 넣어야 글 목록에서 구분 없이 보인다
  let postId: number | null = null;
  let warning: string | null = null;
  if (body.save !== false) {
    try {
      postId = await insertDraft({ mainKeyword, subKeyword, draft, auto: true });
    } catch (e) {
      // 수십 초 걸려 뽑은 본문을 저장 실패만으로 버리면 손해가 크다.
      // 초안은 그대로 돌려주고 어느 단계가 어긋났는지만 경고로 알린다
      // (postId 가 없으니 화면의 "저장" 버튼이 새 글로 다시 넣어 준다).
      warning = `[${STEP_LABEL.save}] ${(e as Error).message}`;
    }
  }

  return NextResponse.json({ ok: true, postId, draft, subKeyword, suggestions, warning });
}
