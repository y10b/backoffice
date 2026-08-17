import type { YtComment } from "./youtube";

/**
 * 댓글 타임스탬프로 하이라이트 구간을 찾는다.
 *
 * 유튜브 내부 API 에는 `mostReplayed`(재생 그래프) 가 있지만 공개 Data API 에는 없다.
 * 비공식 엔드포인트는 쓰지 않으므로, 사람들이 직접 찍어둔 타임스탬프를 집계해 대체한다.
 * 게임·음악·스포츠처럼 "그 장면" 이 뚜렷한 장르에서 특히 잘 맞는다.
 *
 * 이 모듈은 **분석만** 한다. 영상 파일에는 손대지 않는다.
 */

export type TimestampMention = {
  /** 초 단위 위치 */
  at: number;
  /** 언급한 댓글의 좋아요 */
  likes: number;
  /** 타임스탬프를 걷어낸 댓글 본문. 어떤 반응이었는지 보여준다 */
  text: string;
  author: string;
};

export type HighlightBin = {
  /** 빈 시작 초 */
  start: number;
  /** 이 구간을 언급한 댓글 수 */
  mentions: number;
  /** 좋아요 가중 점수 */
  score: number;
};

export type Highlight = {
  /** 댓글이 몰린 지점 (초) */
  peakAt: number;
  /** 실제 컷 시작 — peakAt 에서 리드인만큼 앞당기고 장면 전환에 맞춘 값 */
  cutStart: number;
  cutDuration: number;
  mentions: number;
  score: number;
  /** 이 구간을 언급한 댓글 중 좋아요 상위. 자막 재료로 쓴다 */
  samples: TimestampMention[];
};

/**
 * 댓글 한 줄에서 타임스탬프를 모두 뽑는다.
 *
 * 유튜브가 자동 링크로 만들어 주는 `H:MM:SS` / `M:SS` 가 대부분이고, 한국어 댓글에는
 * `2분 30초` 형태도 흔하다. 둘 다 받는다.
 */
const CLOCK = /(?:^|[^\d:])(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?![\d:])/g;
const KOREAN = /(?:(\d{1,3})\s*시간)?\s*(?:(\d{1,3})\s*분)\s*(?:([0-5]?\d)\s*초)?/g;

export function parseTimestamps(text: string): number[] {
  const out: number[] = [];

  for (const m of text.matchAll(CLOCK)) {
    const [, h, a, b] = m;
    // 그룹이 3개면 H:MM:SS, 2개면 M:SS
    const sec = h ? Number(h) * 3600 + Number(a) * 60 + Number(b) : Number(a) * 60 + Number(b);
    if (Number.isFinite(sec)) out.push(sec);
  }

  for (const m of text.matchAll(KOREAN)) {
    const [, h, min, s] = m;
    if (!min && !h) continue;
    const sec = Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
    if (Number.isFinite(sec) && sec > 0) out.push(sec);
  }

  // 같은 댓글이 같은 지점을 두 번 가리켜도 한 표다
  return [...new Set(out)];
}

/** 타임스탬프를 걷어낸 본문. 화면에 반응만 보여주려고 정리한다 */
export function stripTimestamps(text: string): string {
  return text
    .replace(CLOCK, " ")
    .replace(KOREAN, " ")
    .replace(/[-~—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function collectMentions(comments: YtComment[], videoDuration?: number): TimestampMention[] {
  const out: TimestampMention[] = [];
  for (const c of comments) {
    for (const at of parseTimestamps(c.text)) {
      // 영상 길이를 아는 경우 그 밖을 가리키는 값은 버린다.
      // "2024" 같은 연도나 스코어(3:1)가 시각으로 잡히는 걸 걸러낸다.
      if (videoDuration && (at > videoDuration || at < 0)) continue;
      out.push({
        at,
        likes: c.likes,
        text: stripTimestamps(c.text),
        author: c.author,
      });
    }
  }
  return out;
}

/**
 * 좋아요 가중치.
 *
 * 선형으로 더하면 좋아요 3천짜리 댓글 하나가 나머지를 다 덮는다. 로그를 씌워
 * "많이 눌린 댓글은 더 세지만 압도하지는 않게" 만든다.
 */
function weight(likes: number): number {
  return 1 + Math.log10(Math.max(likes, 0) + 1);
}

export function buildHistogram(
  mentions: TimestampMention[],
  binSec = 10,
  videoDuration?: number,
): HighlightBin[] {
  if (!mentions.length) return [];

  const bins = new Map<number, HighlightBin>();
  for (const m of mentions) {
    const start = Math.floor(m.at / binSec) * binSec;
    const bin = bins.get(start) ?? { start, mentions: 0, score: 0 };
    bin.mentions += 1;
    bin.score += weight(m.likes);
    bins.set(start, bin);
  }

  // 빈 구간도 채워야 히스토그램이 시간축대로 그려진다
  const max = videoDuration ?? Math.max(...mentions.map((m) => m.at));
  const filled: HighlightBin[] = [];
  for (let s = 0; s <= max; s += binSec) {
    filled.push(bins.get(s) ?? { start: s, mentions: 0, score: 0 });
  }
  return filled;
}

export type PickOptions = {
  binSec?: number;
  /**
   * 피크보다 몇 초 앞에서 컷을 시작할지.
   *
   * 사람은 좋은 장면이 **시작될 때**가 아니라 **반응한 뒤에** 댓글을 쓴다. 타임스탬프를
   * 그대로 시작점으로 쓰면 클라이맥스가 지나간 자리에서 시작한다.
   */
  leadInSec?: number;
  cutDuration?: number;
  /** 몇 개까지 뽑을지 */
  limit?: number;
  /** 피크끼리 최소 간격. 붙어 있으면 같은 장면을 두 번 자르게 된다 */
  minGapSec?: number;
  videoDuration?: number;
};

/**
 * 히스토그램에서 피크를 골라 컷 구간으로 바꾼다.
 *
 * 이웃 빈을 합쳐서 본다. 사람마다 초를 몇 초씩 다르게 적어서 표가 흩어지는데,
 * 한 빈만 보면 같은 장면이 여러 봉우리로 쪼개진다.
 */
export function pickHighlights(
  mentions: TimestampMention[],
  options: PickOptions = {},
): Highlight[] {
  const {
    binSec = 10,
    leadInSec = 4,
    cutDuration = 15,
    limit = 8,
    minGapSec = 20,
    videoDuration,
  } = options;

  const bins = buildHistogram(mentions, binSec, videoDuration);
  if (!bins.length) return [];

  // 이웃과 합친 점수로 순위를 매긴다
  const smoothed = bins.map((b, i) => ({
    bin: b,
    total: (bins[i - 1]?.score ?? 0) * 0.5 + b.score + (bins[i + 1]?.score ?? 0) * 0.5,
  }));

  const picked: Highlight[] = [];
  for (const { bin, total } of [...smoothed].sort((a, b) => b.total - a.total)) {
    if (picked.length >= limit) break;
    if (bin.mentions === 0) continue;
    if (picked.some((p) => Math.abs(p.peakAt - bin.start) < minGapSec)) continue;

    const inBin = mentions.filter((m) => m.at >= bin.start && m.at < bin.start + binSec);
    // 빈 시작점보다 실제 언급들의 중앙값이 장면에 더 가깝다
    const sorted = inBin.map((m) => m.at).sort((a, b) => a - b);
    const peakAt = sorted.length ? sorted[Math.floor(sorted.length / 2)] : bin.start;

    picked.push({
      peakAt,
      cutStart: Math.max(0, peakAt - leadInSec),
      cutDuration,
      mentions: inBin.length,
      score: Number(total.toFixed(2)),
      samples: [...inBin].sort((a, b) => b.likes - a.likes).slice(0, 3),
    });
  }

  return picked.sort((a, b) => a.peakAt - b.peakAt);
}

/**
 * 컷 시작을 가장 가까운 장면 전환으로 당겨 붙인다.
 *
 * 리드인으로 뒤로 밀면 대사 중간이나 움직임 한복판에서 시작할 수 있다. 장면 경계로
 * 스냅하면 깔끔하게 끊긴다. `detectScenes()` 결과를 넘겨 쓴다.
 *
 * 너무 멀리 있는 전환까지 끌어오면 엉뚱한 장면이 붙으므로 허용 범위를 둔다.
 */
export function snapToScenes(
  highlights: Highlight[],
  sceneStarts: number[],
  toleranceSec = 6,
): Highlight[] {
  if (!sceneStarts.length) return highlights;
  const sorted = [...sceneStarts].sort((a, b) => a - b);

  return highlights.map((h) => {
    let best: number | null = null;
    for (const s of sorted) {
      // 피크를 넘어선 전환으로 스냅하면 하이라이트를 잘라먹는다
      if (s > h.peakAt) break;
      if (Math.abs(s - h.cutStart) <= toleranceSec) best = s;
    }
    return best === null ? h : { ...h, cutStart: best };
  });
}
