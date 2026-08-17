import { NextResponse } from "next/server";
import { searchPopular, videoDetails } from "@/lib/youtube";
import { composeScenePrompt, planKidsVideo, type KidsVideoPlan } from "@/lib/claude";
import { fetchVideo, pollVideo, submitVideo } from "@/lib/veo";
import { searchVoices, synthesize } from "@/lib/fishaudio";
import { saveSource } from "@/lib/sources";
import { enqueueRenderJob } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 유아 채널 파이프라인.
 *
 *   discover : 유아 인기 영상 조회 (무엇이 먹히는지 — 기획 근거)
 *   plan     : Claude 로 기획안 생성 (캐릭터·대본·장면 프롬프트)
 *   render   : 장면 하나를 Veo 에 제출 (유료)
 *   poll     : 렌더 상태 조회
 *   video    : 결과 영상 프록시 (Veo URI 는 API 키 헤더가 필요해 브라우저가 못 받는다)
 *   tts      : 장면 내레이션 음성 미리듣기 (Fish Audio — 무료 등급 가능)
 *   narration: 전체 내레이션을 파일로 저장 (조립에서 오디오 트랙으로 쓴다)
 *   assemble : 장면 클립들을 한 편으로 이어 붙이는 렌더 작업 등록
 *   voices   : 한국어 목소리 목록
 *
 * 남의 영상 파일은 어느 단계에서도 건드리지 않는다. discover 는 제목·조회수만 본다.
 */

/** 유아 콘텐츠가 몰리는 카테고리: 1 영화·애니, 24 엔터, 27 교육 */
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
    const operation = (url.searchParams.get("operation") ?? "").trim();
    if (!operation) {
      return NextResponse.json({ ok: false, error: "operation 이 필요합니다." }, { status: 400 });
    }
    try {
      return NextResponse.json({ ok: true, mode, ...(await pollVideo(operation)) });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, error: (e as Error).message });
    }
  }

  /* 결과 영상 프록시. 키 헤더를 서버가 붙여 그대로 흘려보낸다 */
  if (mode === "video") {
    const uri = (url.searchParams.get("uri") ?? "").trim();
    if (!uri) {
      return NextResponse.json({ ok: false, error: "uri 가 필요합니다." }, { status: 400 });
    }
    // 임의 주소로 키를 보내지 않도록 구글 호스트만 허용한다
    let host = "";
    try {
      host = new URL(uri).host;
    } catch {
      return NextResponse.json({ ok: false, error: "잘못된 uri 입니다." }, { status: 400 });
    }
    if (!/(^|\.)googleapis\.com$/.test(host)) {
      return NextResponse.json(
        { ok: false, error: "허용되지 않은 호스트입니다." },
        { status: 400 },
      );
    }
    try {
      const res = await fetchVideo(uri);
      return new Response(res.body, {
        headers: {
          "content-type": res.headers.get("content-type") ?? "video/mp4",
          "content-disposition": 'inline; filename="scene.mp4"',
        },
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
    }
  }

  if (mode === "voices") {
    try {
      const voices = await searchVoices(url.searchParams.get("q") ?? "");
      return NextResponse.json({ ok: true, mode, voices });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, voices: [], error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: false, error: "알 수 없는 mode 입니다." }, { status: 400 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mode = String(body.mode ?? "");

  if (mode === "plan") {
    try {
      /*
       * 참고 영상을 고른 경우 설명란까지 다시 받아온다.
       * 목록(search)의 응답에도 description 이 들어 있지만, 화면이 그걸 그대로 되돌려
       * 보내게 하면 사용자가 고친 값이 섞일 수 있다. 원본을 서버에서 다시 읽는다.
       */
      const sourceId = String(body.sourceVideoId ?? "").trim();
      const detail = sourceId ? await videoDetails(sourceId).catch(() => null) : null;

      const plan = await planKidsVideo({
        motifs: Array.isArray(body.motifs) ? body.motifs.map(String) : [],
        theme: String(body.theme ?? ""),
        source: detail
          ? {
              title: detail.title,
              channel: detail.channel,
              description: detail.description,
              durationSec: detail.durationSec,
              views: detail.views,
            }
          : undefined,
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
        model: body.model ? String(body.model) : undefined,
        // Veo 는 4·6·8초만 받는다. 기획안의 초를 가장 가까운 허용값으로 맞춘다
        durationSeconds: ([4, 6, 8] as const).reduce((best, v) =>
          Math.abs(v - scene.seconds) < Math.abs(best - scene.seconds) ? v : best,
        ),
        aspectRatio: body.aspectRatio ?? "9:16",
        resolution: body.resolution ?? "720p",
      });
      return NextResponse.json({
        ok: true,
        mode,
        sceneIndex,
        operation: task.operation,
        raw: task.raw,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, error: (e as Error).message }, { status: 500 });
    }
  }

  /* 내레이션 음성. 오디오 바이트를 그대로 내려 브라우저가 재생·저장한다 */
  if (mode === "tts") {
    const text = String(body.text ?? "");
    if (!text.trim()) {
      return NextResponse.json({ ok: false, error: "읽을 텍스트가 없습니다." }, { status: 400 });
    }
    try {
      const result = await synthesize({
        text,
        referenceId: body.referenceId ? String(body.referenceId) : undefined,
        format: body.format ?? "mp3",
      });
      return new Response(result.audio, {
        headers: {
          "content-type": result.contentType,
          "content-disposition": `inline; filename="narration.${result.format}"`,
        },
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  /*
   * 내레이션을 파일로 저장한다.
   *
   * `tts` 는 브라우저 미리듣기용으로 바이트를 그대로 내리지만, ffmpeg 는 경로가 필요하다.
   * 장면 대사를 줄바꿈으로 이어 한 번에 읽히면 문장 사이 호흡이 자연스럽다 — 장면별로
   * 따로 만들어 이어 붙이면 끊긴 티가 난다.
   */
  if (mode === "narration") {
    const plan = body.plan as KidsVideoPlan | undefined;
    if (!plan?.scenes?.length) {
      return NextResponse.json({ ok: false, error: "기획안이 필요합니다." }, { status: 400 });
    }
    const text = plan.scenes.map((s) => s.korean.trim()).filter(Boolean).join("\n");
    if (!text) {
      return NextResponse.json({ ok: false, error: "읽을 대사가 없습니다." }, { status: 400 });
    }
    try {
      const result = await synthesize({
        text,
        referenceId: body.referenceId ? String(body.referenceId) : undefined,
        format: "mp3",
      });
      const saved = await saveSource(
        `narration-${plan.title.slice(0, 20) || "kids"}.mp3`,
        new Uint8Array(result.audio),
        { origin: "Fish Audio TTS (자체 생성)", license: "자체 생성물" },
      );
      return NextResponse.json({ ok: true, mode, source: saved });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, error: (e as Error).message }, { status: 500 });
    }
  }

  /*
   * 조립. 장면 클립들을 순서대로 이어 붙이고 자막·내레이션을 얹는다.
   *
   * ffmpeg 는 배포본(서버리스)에서 못 돌기 때문에 직접 렌더하지 않고 큐에 넣는다.
   * 로컬 워커(`npm run worker`)가 가져가 처리한다.
   */
  if (mode === "assemble") {
    const plan = body.plan as KidsVideoPlan | undefined;
    const clips = Array.isArray(body.clips)
      ? body.clips.map((c: unknown) => String(c ?? "").trim()).filter(Boolean)
      : [];
    if (!clips.length) {
      return NextResponse.json(
        { ok: false, error: "이어 붙일 클립을 먼저 올리세요." },
        { status: 400 },
      );
    }
    try {
      const id = await enqueueRenderJob({
        clips,
        narration: body.narration ? String(body.narration) : undefined,
        // 장면 대사를 줄바꿈으로 넘기면 클립 경계에 맞춰 자막이 배분된다
        script: plan?.scenes?.map((s) => s.korean.trim()).join("\n"),
        title: body.withTitle && plan?.title ? plan.title : undefined,
        videoRatio: body.videoRatio ? Number(body.videoRatio) : undefined,
        // 클립 조립에서는 쓰이지 않지만 파서가 요구하는 필드다
        input: clips[0],
        startSec: 0,
        durationSec: 30,
      });
      return NextResponse.json({ ok: true, mode, jobId: id });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, error: (e as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, error: "알 수 없는 mode 입니다." }, { status: 400 });
}
