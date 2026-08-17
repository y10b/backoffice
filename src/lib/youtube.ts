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
  /**
   * 외부 사이트 임베드 허용 여부(`status.embeddable`).
   *
   * 라이선스와는 별개 축이다. CC 여도 임베드를 막아둔 영상이 있고, 표준 라이선스여도
   * 임베드는 되는 영상이 대부분이다. **임베드 허용은 "플레이어를 띄워도 된다"는 뜻이지
   * 영상을 받아 잘라 써도 된다는 뜻이 아니다.** 가공 가능 판정은 license 로만 한다.
   */
  embeddable: boolean | null;
  /** 아동용 표시. 켜져 있으면 댓글이 막혀 있어 댓글 수집이 빈다 */
  madeForKids: boolean | null;
  /** 국내에서 재생이 막혀 있는지 (`contentDetails.regionRestriction`) */
  blockedInKR: boolean;
  /** 댓글이 열려 있는지. 막히면 응답에 commentCount 자체가 없다 */
  commentsEnabled: boolean;
  url: string;
};

/**
 * 국내에서 볼 수 있는 영상인지. `allowed` 가 있으면 화이트리스트,
 * `blocked` 가 있으면 블랙리스트로 해석한다. 둘 다 없으면 제한 없음.
 */
function isBlockedInKR(regionRestriction: any, region = "KR"): boolean {
  if (!regionRestriction) return false;
  const { allowed, blocked } = regionRestriction;
  if (Array.isArray(allowed)) return !allowed.includes(region);
  if (Array.isArray(blocked)) return blocked.includes(region);
  return false;
}

function toVideo(item: any): YtVideo {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
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
    embeddable: bool(item?.status?.embeddable),
    madeForKids: bool(item?.status?.madeForKids),
    blockedInKR: isBlockedInKR(item?.contentDetails?.regionRestriction),
    commentsEnabled: item?.statistics?.commentCount !== undefined,
    url: id ? `https://www.youtube.com/watch?v=${id}` : "",
  };
}

export type ReuseVerdict = {
  /** 영상을 받아 잘라 쓸 수 있는가. CC 라이선스만 통과한다 */
  canEdit: boolean;
  /** 플레이어를 우리 페이지에 띄울 수 있는가 */
  canEmbed: boolean;
  /** 판정 근거. 화면에 그대로 띄운다 */
  reasons: string[];
};

/**
 * 재사용 가능 여부 판정.
 *
 * 두 축을 분리하는 게 요점이다. 임베드(재공유)와 재편집은 다른 권한이고, 섞으면
 * "임베드 되니까 잘라 써도 되겠지"라는 잘못된 결론으로 간다.
 */
export function reuseVerdict(v: YtVideo): ReuseVerdict {
  const reasons: string[] = [];

  const isCc = v.license === "creativeCommon";
  if (!isCc) reasons.push("표준 유튜브 라이선스 — 영상 파일을 받아 가공할 수 없음");
  else reasons.push("CC BY 라이선스 — 출처를 밝히면 가공 가능");

  if (v.embeddable === false) reasons.push("퍼가기 금지 — 외부 임베드 불가");
  if (v.blockedInKR) reasons.push("국내 재생 차단");
  if (v.madeForKids) reasons.push("아동용 — 댓글이 막혀 있음");
  if (!v.commentsEnabled) reasons.push("댓글 사용 중지 — 댓글 수집 불가");

  return {
    canEdit: isCc && !v.blockedInKR,
    canEmbed: v.embeddable !== false && !v.blockedInKR,
    reasons,
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
 * `videoSyndicated=true` 는 유튜브 밖에서 재생 가능한 것만 남긴다. 이걸 빼면 우리
 * 페이지에 붙이지도 못하는 영상이 목록에 섞인다.
 *
 * search 는 호출당 할당량 100 단위(조회는 1)라 비싸다. 그래서 검색 결과의 id 를 모아
 * videos 로 한 번에 상세를 받는다.
 */
export async function searchCreativeCommons(
  query: string,
  maxResults = 20,
  /** 임베드·외부재생 가능한 것만 남길지. 후보가 너무 적으면 끄고 넓힌다 */
  shareableOnly = true,
): Promise<YtVideo[]> {
  const found: any = await call("search", {
    part: "id",
    q: query,
    type: "video",
    videoLicense: "creativeCommon",
    ...(shareableOnly ? { videoEmbeddable: "true", videoSyndicated: "true" } : {}),
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
  return (data.items ?? []).map(toVideo).filter((v: YtVideo) => reuseVerdict(v).canEdit);
}

/**
 * 일반 인기 영상 검색 — 기획 근거용.
 *
 * `searchCreativeCommons` 와 달리 라이선스로 거르지 않는다. 여기서 나오는 영상은
 * **무엇이 먹히는지 보려고** 조회하는 것이지 소재로 쓰려는 게 아니다. 유아 채널은
 * 영상을 전부 새로 생성하므로 남의 파일을 만질 일이 없다.
 */
export async function searchPopular(
  query: string,
  opts: {
    maxResults?: number;
    /** ISO8601. 최근 것만 보고 싶을 때 */
    publishedAfter?: string;
    /** 유아 콘텐츠는 보통 1(영화·애니), 24(엔터), 27(교육) */
    videoCategoryId?: string;
    videoDuration?: "short" | "medium" | "long";
  } = {},
): Promise<YtVideo[]> {
  const found: any = await call("search", {
    part: "id",
    q: query,
    type: "video",
    order: "viewCount",
    maxResults: String(Math.min(Math.max(opts.maxResults ?? 20, 1), 50)),
    regionCode: "KR",
    relevanceLanguage: "ko",
    ...(opts.publishedAfter ? { publishedAfter: opts.publishedAfter } : {}),
    ...(opts.videoCategoryId ? { videoCategoryId: opts.videoCategoryId } : {}),
    ...(opts.videoDuration ? { videoDuration: opts.videoDuration } : {}),
  });

  const ids = (found.items ?? [])
    .map((i: any) => i?.id?.videoId)
    .filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
  if (!ids.length) return [];

  const data: any = await call("videos", {
    part: "snippet,statistics,contentDetails,status",
    id: ids.join(","),
  });
  // 검색 순위가 아니라 실제 조회수로 다시 정렬한다. search 의 viewCount 정렬은 근사치다
  return (data.items ?? [])
    .map(toVideo)
    .sort((a: YtVideo, b: YtVideo) => (b.views ?? 0) - (a.views ?? 0));
}

/** 단일 영상 상세. 하이라이트 집계에서 영상 길이를 알아야 범위 밖 숫자를 걸러낼 수 있다 */
export async function videoDetails(videoId: string): Promise<YtVideo | null> {
  const data: any = await call("videos", {
    part: "snippet,statistics,contentDetails,status",
    id: videoId,
  });
  const item = (data.items ?? [])[0];
  return item ? toVideo(item) : null;
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
function toComments(items: any[]): YtComment[] {
  return items
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
    .filter((c: YtComment) => c.text.length > 0);
}

export async function topComments(videoId: string, max = 20): Promise<YtComment[]> {
  const data: any = await call("commentThreads", {
    part: "snippet",
    videoId,
    order: "relevance", // 좋아요·답글을 반영한 유튜브 기준 인기순
    maxResults: String(Math.min(Math.max(max, 1), 100)),
    textFormat: "html",
  });
  return toComments(data.items ?? []).sort((a, b) => b.likes - a.likes);
}

/**
 * 하이라이트 집계용 댓글 수집.
 *
 * `topComments` 는 인기순 한 페이지라 30~100개다. 타임스탬프는 그중 일부에만 있어서
 * 그 정도로는 히스토그램이 성기다. 여기서는 페이지를 넘겨 표본을 늘린다.
 *
 * commentThreads 는 호출당 할당량 1 단위라(search 는 100) 몇 페이지 더 받아도 싸다.
 * 댓글이 막힌 영상은 403 이 나므로 빈 배열로 돌려 화면이 죽지 않게 한다.
 */
export async function allComments(videoId: string, maxPages = 5): Promise<YtComment[]> {
  const out: YtComment[] = [];
  let pageToken = "";

  for (let page = 0; page < maxPages; page++) {
    let data: any;
    try {
      data = await call("commentThreads", {
        part: "snippet",
        videoId,
        order: "relevance",
        maxResults: "100",
        textFormat: "html",
        ...(pageToken ? { pageToken } : {}),
      });
    } catch (e) {
      // 첫 페이지부터 실패하면 진짜 오류다. 그 뒤는 모은 만큼이라도 살린다
      if (page === 0) throw e;
      break;
    }

    out.push(...toComments(data.items ?? []));
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }

  return out;
}
