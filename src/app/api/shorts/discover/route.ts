import { NextResponse } from "next/server";
import {
  allComments,
  searchCreativeCommons,
  searchPopular,
  topComments,
  trendingVideos,
  videoDetails,
} from "@/lib/youtube";
import { archiveFiles, licenseLabel, searchArchive } from "@/lib/archive";
import { buildHistogram, collectMentions, pickHighlights } from "@/lib/highlights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 쇼츠 소재 탐색.
 *
 * 세 가지를 한 화면에 모은다.
 *  - 지금 뜨는 것 (무엇을 만들지 정하는 근거)
 *  - 실제로 가공해도 되는 소재 (CC / 공개 도메인)
 *  - 인기 댓글 (쇼츠에 얹을 재료)
 *
 * 어느 하나가 실패해도 나머지는 보여준다. 소스마다 상태를 따로 내려 화면이 구분한다.
 */
type Source = { id: string; label: string; ok: boolean; message: string };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "trending";
  const query = (url.searchParams.get("q") ?? "").trim();
  const videoId = (url.searchParams.get("videoId") ?? "").trim();

  const sources: Source[] = [];

  /* 지금 뜨는 영상 — 기획 근거. 대부분 표준 라이선스라 가공 대상이 아니다 */
  if (mode === "trending") {
    try {
      const videos = await trendingVideos("KR", 25);
      const reusable = videos.filter((v) => v.license === "creativeCommon").length;
      sources.push({
        id: "youtube-trending",
        label: "유튜브 인기 급상승",
        ok: true,
        message: `${videos.length}건 · 이 중 재사용 가능 ${reusable}건`,
      });
      return NextResponse.json({ ok: true, mode, videos, sources });
    } catch (e) {
      return NextResponse.json({
        ok: false,
        mode,
        videos: [],
        sources: [
          { id: "youtube-trending", label: "유튜브 인기 급상승", ok: false, message: (e as Error).message },
        ],
        error: (e as Error).message,
      });
    }
  }

  /*
   * 게임 영상 검색 — 댓글 하이라이트를 뜨기 위한 후보 목록.
   *
   * 라이선스로 걸러내지 않는다. 여기서 하는 건 댓글 분석이고 영상 파일에는 손대지 않는다.
   * CC 로 좁히면 정작 댓글이 많이 달린 인기 영상이 전부 빠져 목록이 쓸모없어진다.
   */
  if (mode === "search") {
    if (!query) {
      return NextResponse.json(
        { ok: false, error: "검색어를 입력하세요.", videos: [] },
        { status: 400 },
      );
    }
    const months = Number(url.searchParams.get("months") ?? 6) || 6;
    const publishedAfter = new Date(
      Date.now() - months * 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    try {
      const videos = await searchPopular(query, {
        maxResults: 25,
        // 60개월이면 사실상 전체다. 그때는 기간 조건을 아예 빼서 옛 영상도 잡는다
        publishedAfter: months >= 60 ? undefined : publishedAfter,
      });
      // 댓글이 잠긴 영상은 하이라이트를 뜰 수 없어 뒤로 보낸다
      videos.sort((a, b) => Number(b.commentsEnabled) - Number(a.commentsEnabled));
      return NextResponse.json({
        ok: true,
        mode,
        videos,
        note: `${months >= 60 ? "전체 기간" : `최근 ${months}개월`} · 조회수순 ${videos.length}건`,
        sources: [
          {
            id: "youtube-search",
            label: "유튜브 검색",
            ok: true,
            message: `${videos.length}건 · 댓글 열림 ${videos.filter((v) => v.commentsEnabled).length}건`,
          },
        ],
      });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, videos: [], error: (e as Error).message });
    }
  }

  /*
   * 가공 가능한 소재.
   *
   * 롱폼을 잘라 쇼츠로 만드는 흐름이라 **가공해도 되는 것만** 보여준다. 인기 급상승은
   * 사실상 전부 표준 라이선스라(실측 10/10) 목록에 섞어봐야 쓸 수 없는 줄만 늘어난다.
   *
   * 길이는 `long`(20분 초과)이 기본이다. 한 편에서 여러 컷을 뽑을 수 있어 소재 하나로
   * 여러 편이 나오고, 4분짜리에서는 쓸 만한 구간이 몇 개 안 나온다.
   */
  if (mode === "sources") {
    if (!query) {
      return NextResponse.json(
        { ok: false, error: "검색어를 입력하세요.", videos: [], archive: [], sources: [] },
        { status: 400 },
      );
    }

    const durationParam = url.searchParams.get("duration") ?? "long";
    const duration = (["any", "long", "medium", "short"] as const).includes(
      durationParam as any,
    )
      ? (durationParam as "any" | "long" | "medium" | "short")
      : "long";

    const [yt, ar] = await Promise.allSettled([
      searchCreativeCommons(query, 25, { duration }),
      searchArchive(query, 12),
    ]);

    let videos = yt.status === "fulfilled" ? yt.value : [];
    /*
     * 긴 것부터 보여준다. 잘라 쓸 소재는 길수록 뽑을 구간이 많다.
     * 길이를 모르는 항목(파싱 실패)은 판단할 수 없으니 뒤로 보낸다.
     */
    videos = [...videos].sort((a, b) => (b.durationSec ?? -1) - (a.durationSec ?? -1));

    const label =
      duration === "long"
        ? "20분 초과"
        : duration === "medium"
          ? "4~20분"
          : duration === "short"
            ? "4분 미만"
            : "길이 무관";
    sources.push({
      id: "youtube-cc",
      label: "유튜브 CC 라이선스",
      ok: yt.status === "fulfilled",
      message:
        yt.status === "fulfilled"
          ? `${videos.length}건 · ${label} · 전부 가공 가능`
          : (yt.reason as Error).message,
    });

    const archive =
      ar.status === "fulfilled"
        ? ar.value.map((a) => {
            const lic = licenseLabel(a.licenseUrl);
            return { ...a, license: lic.label, licenseConfirmed: lic.confirmed };
          })
        : [];
    sources.push({
      id: "archive",
      label: "Internet Archive",
      ok: ar.status === "fulfilled",
      message:
        ar.status === "fulfilled" ? `${archive.length}건` : (ar.reason as Error).message,
    });

    return NextResponse.json({
      ok: true,
      mode,
      query,
      videos,
      archive,
      sources,
      note: `CC 라이선스 · ${label} · 긴 순 ${videos.length}건`,
    });
  }

  /* 인기 댓글 */
  if (mode === "comments") {
    if (!videoId) {
      return NextResponse.json(
        { ok: false, error: "videoId 가 필요합니다.", comments: [] },
        { status: 400 },
      );
    }
    try {
      const comments = await topComments(videoId, 30);
      return NextResponse.json({ ok: true, mode, videoId, comments });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, comments: [], error: (e as Error).message });
    }
  }

  /*
   * 댓글 타임스탬프 하이라이트.
   *
   * 분석 전용이다. 어느 영상에든 돌려도 되지만, 나오는 건 "몇 초 지점이 반응이 좋았나"
   * 라는 정보이지 그 영상을 쓸 권리가 아니다. 컷 실행은 소재 탭의 CC·아카이브·업로드
   * 파일에만 붙는다.
   */
  if (mode === "highlights") {
    if (!videoId) {
      return NextResponse.json(
        { ok: false, error: "videoId 가 필요합니다.", highlights: [] },
        { status: 400 },
      );
    }
    const binSec = Number(url.searchParams.get("bin") ?? 10) || 10;
    const leadInSec = Number(url.searchParams.get("leadIn") ?? 4) || 4;
    const cutDuration = Number(url.searchParams.get("cut") ?? 15) || 15;

    try {
      const [detail, comments] = await Promise.all([
        videoDetails(videoId).catch(() => null),
        allComments(videoId, 5),
      ]);
      const videoDuration = detail?.durationSec ?? undefined;

      const mentions = collectMentions(comments, videoDuration);
      const highlights = pickHighlights(mentions, {
        binSec,
        leadInSec,
        cutDuration,
        videoDuration,
      });

      return NextResponse.json({
        ok: true,
        mode,
        videoId,
        video: detail,
        commentCount: comments.length,
        mentionCount: mentions.length,
        histogram: buildHistogram(mentions, binSec, videoDuration),
        highlights,
        sources: [
          {
            id: "youtube-comments",
            label: "댓글 타임스탬프",
            ok: true,
            message: `댓글 ${comments.length}개 중 타임스탬프 ${mentions.length}건 · 하이라이트 ${highlights.length}구간`,
          },
        ],
      });
    } catch (e) {
      return NextResponse.json({
        ok: false,
        mode,
        highlights: [],
        histogram: [],
        error: (e as Error).message,
      });
    }
  }

  /* 소재 항목의 실제 파일 목록 */
  if (mode === "files") {
    const identifier = (url.searchParams.get("identifier") ?? "").trim();
    if (!identifier) {
      return NextResponse.json(
        { ok: false, error: "identifier 가 필요합니다.", files: [] },
        { status: 400 },
      );
    }
    try {
      return NextResponse.json({ ok: true, mode, files: await archiveFiles(identifier) });
    } catch (e) {
      return NextResponse.json({ ok: false, mode, files: [], error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: false, error: "알 수 없는 mode 입니다." }, { status: 400 });
}
