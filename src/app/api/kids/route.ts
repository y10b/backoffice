import { NextResponse } from "next/server";
import { searchPopular } from "@/lib/youtube";
import { composeScenePrompt, planKidsVideo, type KidsVideoPlan } from "@/lib/claude";
import { pollVideo, submitVideo } from "@/lib/seedance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 유아 채널 파이프라인.
 *
 *   discover : 유아 인기 영상 조회 (무엇이 먹히는지 — 기획 근거)
 *   plan     : Claude 로 기획안 생성 (캐릭터·대본·장면 프롬프트)
 *   render   : 장면 하나를 Seedance 에 제출
 *   poll     : 렌더 상태 조회
 *
 * 남의 영상 파일은 어느 단계에서도 건드리지 않는다. discover 는 제목·조회수만 보고,
 * 실제 화면은 전부 새로 생성한다.
 */

/** 유아 콘텐츠가 몰리는 카테고리: 1 영화·애니, 24 엔터테인먼트, 27 교육 */
const KIDS_CATEGORIES = ["1", "24", "27"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "discover";

  if (mode === "discover") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (!query) {
      return NextResponse.json(
        { ok: false, error: "검색어를 입력하세요.", videos: [] },
        { status: 400 },
      );
    }
    const category = url.searchParams.get("category") ?? "";
    const months = Number(url.searchParams.get("months") ?? 12) || 12;
    const publishedAfter = new Date(
      Date.now() - months * 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    try {
      const videos = await searchPopular(query, {
        maxResults: 25,
        publishedAfter,
        videoCategoryId: KIDS_CATEGORIES.includes(category) ? category : undefined,
      });
      return NextResponse.json({
        ok: true,
        mode,
        videos,
        note: `최근 ${months}개월 · 조회수순 ${videos.length}건`,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, videos: [], error: (e as Error).message });
    }
  }

  if (mode === "poll") {
    const taskId = (url.searchParams.get("taskId") ?? "").trim();
    if (!taskId) {
      return NextResponse.json({ ok: false, error: "taskId 가 필요합니다." }, { status: 400 });
    }
    try {
      return NextResponse.json({ ok: true, mode, ...(await pollVideo(taskId)) });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: false, error: "알 수 없는 mode 입니다." }, { status: 400 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mode = String(body.mode ?? "");

  if (mode === "plan") {
    try {
      const plan = await planKidsVideo({
        motifs: Array.isArray(body.motifs) ? body.motifs.map(String) : [],
        theme: String(body.theme ?? ""),
        targetAge: body.targetAge ? String(body.targetAge) : undefined,
        sceneCount: body.sceneCount ? Number(body.sceneCount) : undefined,
        secondsPerScene: body.secondsPerScene ? Number(body.secondsPerScene) : undefined,
        notes: body.notes ? String(body.notes) : undefined,
      });
      return NextResponse.json({ ok: true, mode, plan });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, error: (e as Error).message }, { status: 500 });
    }
  }

  if (mode === "render") {
    const plan = body.plan as KidsVideoPlan | undefined;
    const sceneIndex = Number(body.sceneIndex);
    const scene = plan?.scenes?.find((s) => s.index === sceneIndex);
    if (!plan || !scene) {
      return NextResponse.json(
        { ok: false, error: "기획안 또는 장면을 찾지 못했습니다." },
        { status: 400 },
      );
    }
    try {
      // 캐릭터 시트를 여기서 한 번만 붙인다. 장면마다 따로 조립하면 형태가 어긋난다
      const task = await submitVideo({
        prompt: composeScenePrompt(plan, scene),
        duration: scene.seconds,
        resolution: body.resolution ?? "720p",
        ratio: body.ratio ?? "9:16",
        imageUrl: body.imageUrl ? String(body.imageUrl) : undefined,
      });
      return NextResponse.json({ ok: true, mode, sceneIndex, taskId: task.id, raw: task.raw });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, error: (e as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, error: "알 수 없는 mode 입니다." }, { status: 400 });
}
