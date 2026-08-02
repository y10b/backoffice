import { NextResponse } from "next/server";
import { searchCreativeCommons, topComments, trendingVideos } from "@/lib/youtube";
import { archiveFiles, licenseLabel, searchArchive } from "@/lib/archive";

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

  /* 가공 가능한 소재 — 두 소스를 나란히 */
  if (mode === "sources") {
    if (!query) {
      return NextResponse.json(
        { ok: false, error: "검색어를 입력하세요.", youtube: [], archive: [], sources: [] },
        { status: 400 },
      );
    }

    const [yt, ar] = await Promise.allSettled([
      searchCreativeCommons(query, 12),
      searchArchive(query, 12),
    ]);

    const youtube = yt.status === "fulfilled" ? yt.value : [];
    sources.push({
      id: "youtube-cc",
      label: "유튜브 CC 라이선스",
      ok: yt.status === "fulfilled",
      message:
        yt.status === "fulfilled"
          ? `${youtube.length}건`
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

    return NextResponse.json({ ok: true, mode, query, youtube, archive, sources });
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
