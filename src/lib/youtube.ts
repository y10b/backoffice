import { getSettings } from "./db";

/**
 * YouTube Data API v3.
 *
 * 이 파일은 **영상 파일을 내려받지 않는다.** 트렌드 발견·소재 탐색·댓글 수집만 한다.
 * 남의 영상을 받아 재업로드하는 건 유튜브 약관과 저작권 양쪽에 걸리고 Content ID 가
 * 잡아낸다. 실제로 편집할 소재는 재사용이 허용된 것(CC 라이선스, 공개 도메인)만 쓴다.
 */
const API = "https://www.googleapis.com/youtube/v3";

export async function youtubeKey(): Promise<string | null> {
  const s = await getSettings(["youtube_api_key"]);
  return s.youtube_api_key || process.env.YOUTUBE_API_KEY || null;
}

function errorMessage(status: number, body: string): string {
  let msg = body.slice(0, 200);
  let reason = "";
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message ?? msg;
    reason = j?.error?.errors?.[0]?.reason ?? "";
  } catch {
    /* 원문 유지 */
  }
  if (reason === "quotaExceeded") {
    return "YouTube API 일일 할당량(기본 10,000 단위)을 소진했습니다. 검색은 1회당 100 단위라 금세 닳습니다. 내일 다시 시도하거나 할당량 증설을 신청하세요.";
  }
  if (status === 403) {
    return `YouTube API 접근이 거부됐습니다: ${msg} GCP 에서 YouTube Data API v3 가 켜져 있는지, API 키 제한이 막고 있지 않은지 확인하세요.`;
  }
  if (status === 400) return `요청이 잘못됐습니다: ${msg}`;
  return `YouTube API 오류 (HTTP ${status}): ${msg}`;
}

async function call(path: string, params: Record<string, string>): Promise<unknown> {
  const key = await youtubeKey();
  if (!key) {
    throw new Error(
      "YouTube API 키가 없습니다. 설정 화면에서 등록하거나 YOUTUBE_API_KEY 환경변수를 넣으세요.",
    );
  }
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);

  const res = await fetch(url.toString(), { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(errorMessage(res.status, text));
  return JSON.parse(text);
}

/** ISO8601 재생시간(PT1H2M3S)을 초로. 해석 못 하면 null */
export function parseDuration(iso: string): number | null {
  const m = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(iso ?? "");
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total =
    Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(total) ? Math.round(total) : null;
}

export type YtVideo = {
  id: string;
  title: string;
  channel: string;
  publishedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  durationSec: number | null;
  thumbnail: string;
  /** `creativeCommon` 이면 재사용 가능. `youtube` 는 표준 라이선스라 손대면 안 된다 */
  license: string | null;
  url: string;
};

function toVideo(item: any): YtVideo {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const id = String(item?.id?.videoId ?? item?.id ?? "");
  return {
    id,
    title: String(item?.snippet?.title ?? ""),
    channel: String(item?.snippet?.channelTitle ?? ""),
    publishedAt: String(item?.snippet?.publishedAt ?? ""),
    views: num(item?.statistics?.viewCount),
    likes: num(item?.statistics?.likeCount),
    comments: num(item?.statistics?.commentCount),
    durationSec: item?.contentDetails?.duration
      ? parseDuration(item.contentDetails.duration)
      : null,
    thumbnail:
      item?.snippet?.thumbnails?.medium?.url ??
      item?.snippet?.thumbnails?.default?.url ??
      "",
    license: item?.status?.license ?? null,
    url: id ? `https://www.youtube.com/watch?v=${id}` : "",
  };
}

/**
 * 지금 뜨는 영상. 무엇이 화제인지 파악하는 용도이지, 이걸 그대로 가공하라는 뜻이 아니다.
 * 대부분 표준 라이선스라 `license` 를 함께 내려 화면에서 구분할 수 있게 한다.
 */
export async function trendingVideos(
  regionCode = "KR",
  maxResults = 25,
): Promise<YtVideo[]> {
  const data: any = await call("videos", {
    part: "snippet,statistics,contentDetails,status",
    chart: "mostPopular",
    regionCode,
    maxResults: String(Math.min(Math.max(maxResults, 1), 50)),
  });
  return (data.items ?? []).map(toVideo);
}

/**
 * 재사용 가능한 소재 검색.
 *
 * `videoLicense=creativeCommon` 이 핵심이다. 이걸 빼면 표준 라이선스 영상이 섞여
 * 들어와 "가공 가능"이라는 전제가 깨진다.
 *
 * search 는 호출당 할당량 100 단위(조회는 1)라 비싸다. 그래서 검색 결과의 id 를 모아
 * videos 로 한 번에 상세를 받는다.
 */
export async function searchCreativeCommons(
  query: string,
  maxResults = 20,
): Promise<YtVideo[]> {
  const found: any = await call("search", {
    part: "id",
    q: query,
    type: "video",
    videoLicense: "creativeCommon",
    order: "viewCount",
    maxResults: String(Math.min(Math.max(maxResults, 1), 50)),
    regionCode: "KR",
    relevanceLanguage: "ko",
  });
  const ids = (found.items ?? [])
    .map((i: any) => i?.id?.videoId)
    .filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
  if (!ids.length) return [];

  const data: any = await call("videos", {
    part: "snippet,statistics,contentDetails,status",
    id: ids.join(","),
  });
  // 검색이 CC 로 걸러줘도 응답을 한 번 더 확인한다. 전제가 깨지면 여기서 막아야 한다
  return (data.items ?? []).map(toVideo).filter((v: YtVideo) => v.license === "creativeCommon");
}

export type YtComment = {
  id: string;
  author: string;
  text: string;
  likes: number;
  publishedAt: string;
  replyCount: number;
};

/** 태그를 걷어내고 HTML 엔티티를 되돌린다. 댓글은 그대로 화면·영상에 얹히므로 정리해야 한다 */
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * 인기 댓글. 쇼츠 화면에 얹을 재료다.
 * 댓글을 인용하는 것 자체는 영상 파일을 쓰는 것과 별개이고, 작성자명을 함께 남긴다.
 */
export async function topComments(videoId: string, max = 20): Promise<YtComment[]> {
  const data: any = await call("commentThreads", {
    part: "snippet",
    videoId,
    order: "relevance", // 좋아요·답글을 반영한 유튜브 기준 인기순
    maxResults: String(Math.min(Math.max(max, 1), 100)),
    textFormat: "html",
  });

  return (data.items ?? [])
    .map((item: any) => {
      const c = item?.snippet?.topLevelComment?.snippet ?? {};
      return {
        id: String(item?.id ?? ""),
        author: String(c.authorDisplayName ?? ""),
        text: stripHtml(String(c.textDisplay ?? "")),
        likes: Number(c.likeCount ?? 0) || 0,
        publishedAt: String(c.publishedAt ?? ""),
        replyCount: Number(item?.snippet?.totalReplyCount ?? 0) || 0,
      };
    })
    .filter((c: YtComment) => c.text.length > 0)
    .sort((a: YtComment, b: YtComment) => b.likes - a.likes);
}
