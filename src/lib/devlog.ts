/**
 * 개발 로그 갈래 — 깃 이력을 모아 velog 글 초안을 만들고, 승인한 것만 올린다.
 *
 * 원래 별도 레포(y10b/devlog)였다. 노션 DB 세 개를 저장소로 쓰고 깃액션 네 개가 각자
 * 스크립트를 돌렸다. 승인 화면이 노션에, 나머지가 백오피스에 있으면 검토가 두 곳으로
 * 갈리므로 여기로 옮겼다. 저장소는 Supabase, 화면은 /devlog, 실행은 이 모듈 하나다.
 *
 *  | 단계    | 언제        | 하는 일                                            |
 *  |---------|-------------|----------------------------------------------------|
 *  | collect | 매일 21시   | 그날 커밋을 레포·날짜별로 모아 dev_logs 에 쌓는다   |
 *  | draft   | 매일 22시반 | 안 쓴 글감 전체에서 프로젝트×주 한 묶음 → 초안      |
 *  | publish | 매일 7시    | status=approved 만 velog 에 올린다                 |
 *  | sync    | 매일 22시   | velog 에 올라간 글을 되돌려 채우고 반응을 갱신한다 |
 *
 * 지키는 선:
 * - 회사 레포는 아예 조회하지 않는다. `blockedOwners()` 가 마지막 방어선이다.
 * - 커밋이 없는 날은 아무것도 만들지 않는다. 일정을 채우려고 쓰면 없는 내용이 생긴다.
 * - 발행은 사람이 승인해야 한다. velog 는 채용 담당자가 보는 채널이다.
 * - velog 쓰기는 공식 API 가 아니라 로그인 쿠키다. 만료되면 조용히 멈추지 않도록
 *   실패를 글에 남기고 호출자에게 던진다.
 */

import {
  claimVelogPost,
  findVelogPost,
  getSettings,
  hasSupabase,
  insertVelogPost,
  setSetting,
  listUnconsumedDevLogs,
  listVelogPostsByStatus,
  markDevLogsConsumed,
  updateVelogPost,
  upsertDevLogs,
  type DevLog,
  type DevLogInput,
} from "./db";
import { geminiCall, geminiKeys, geminiModel } from "./gemini";
import { openaiJson, openaiKey } from "./openai";

/* ------------------------------------------------------------------ *
 * 설정
 * ------------------------------------------------------------------ */

const DEFAULT_BLOCKED = "bambitcorporation";

/** 쉼표·공백·줄바꿈 어느 것으로 구분해도 된다. 붙여넣다 보면 형식이 제각각이다 */
const splitList = (raw: string) => raw.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);

export async function devlogCreds(): Promise<{
  token: string;
  user: string;
  /** velog 핸들. GitHub 과 다를 수 있어 따로 둔다 — 비우면 GitHub 사용자를 쓴다 */
  velogUser: string;
  velogToken: string;
  /** access_token 은 24시간짜리다. refresh_token(30일)을 같이 보내야 매일 발행이 산다 */
  velogRefresh: string;
  blocked: string[];
  /** 수집할 레포(owner/name). 비어 있으면 접근 가능한 레포 전체(차단 소유자 제외) */
  repos: string[];
  /**
   * 내 커밋으로 칠 author 이메일(소문자). 로컬 git 이메일로 찍힌 커밋은 GitHub 계정에
   * 연결되지 않아 login 이 비어 온다 — 이메일로만 내 것인지 알 수 있다.
   */
  authorEmails: string[];
}> {
  const s = await getSettings([
    "github_pat", "github_user", "velog_user", "velog_token", "velog_refresh_token",
    "devlog_blocked_owners", "devlog_repos", "devlog_author_emails",
  ]);
  const user = s.github_user || process.env.GH_USER || "y10b";
  // 설정에서 목록을 바꿔도 기본 차단 대상은 늘 남는다. 지워지는 순간이 새는 순간이다
  const blockedRaw = `${DEFAULT_BLOCKED},${s.devlog_blocked_owners || process.env.DEVLOG_BLOCKED_OWNERS || ""}`;
  const repos = splitList(s.devlog_repos || process.env.DEVLOG_REPOS || "").filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  return {
    token: s.github_pat || process.env.GH_PAT || process.env.GITHUB_TOKEN || "",
    user,
    velogUser: s.velog_user || process.env.VELOG_USER || user,
    velogToken: s.velog_token || process.env.VELOG_TOKEN || "",
    velogRefresh: s.velog_refresh_token || process.env.VELOG_REFRESH_TOKEN || "",
    blocked: [...new Set(splitList(blockedRaw).map((o) => o.toLowerCase()))],
    repos: [...new Map(repos.map((r) => [r.toLowerCase(), r])).values()],
    authorEmails: [
      ...new Set(splitList(s.devlog_author_emails || process.env.DEVLOG_AUTHOR_EMAILS || "").map((e) => e.toLowerCase())),
    ],
  };
}

export const isBlocked = (fullName: string, blocked: string[]) =>
  blocked.some((o) => fullName.toLowerCase().startsWith(`${o}/`));

/** KST 기준 오늘 날짜 (YYYY-MM-DD). 러너와 Vercel 은 UTC 라 그대로 쓰면 하루가 밀린다 */
export function kstToday(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}

/** ISO 시각 → KST 날짜 */
export function kstDateOf(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * 글감 판별 — 순수 함수
 * ------------------------------------------------------------------ */

/** 커밋 메시지에서 주제 태그를 뽑는다. conventional commit prefix 와 한국어 단서 기준 */
export function topicsOf(messages: string[]): string[] {
  const t = new Set<string>();
  const joined = messages.join("\n").toLowerCase();
  if (/(^|\n)\s*feat|기능|추가|넣는다/.test(joined)) t.add("기능");
  if (/(^|\n)\s*fix|hotfix|버그|오류|수정|바로잡/.test(joined)) t.add("버그");
  if (/(^|\n)\s*refactor|repactor|리팩|걷어|정리/.test(joined)) t.add("리팩토링");
  if (/(^|\n)\s*(ci|chore|build|deploy)|배포|인프라|docker|ecs|ec2|actions|깃액션|vercel/.test(joined)) t.add("인프라");
  if (/(^|\n)\s*(data|db)|스키마|마이그|수집|스크래|supabase/.test(joined)) t.add("데이터");
  if (/(^|\n)\s*docs?|문서|readme|devlog/.test(joined)) t.add("문서");
  if (/perf|성능|최적화|캐싱|캐시/.test(joined)) t.add("성능");
  return [...t];
}

/**
 * 글이 될 만한 하루인지 0~5. 높을수록 쓸 게 있다.
 * "왜 그렇게 했는지"가 드러나는 날 — 원인 규명, 판단의 전환 — 이 좋은 글감이다.
 */
export function scoreOf(messages: string[], topics: string[]): number {
  let s = 0;
  const joined = messages.join("\n");
  if (messages.length >= 3) s += 1;
  if (messages.length >= 8) s += 1;
  if (topics.includes("버그") || topics.includes("성능")) s += 2;
  if (topics.includes("인프라") || topics.includes("데이터")) s += 1;
  if (/→|->|전환|교체|이전|마이그|대신|포기|걷어|원인|옮기/.test(joined)) s += 1;
  if (topics.length === 1 && topics[0] === "문서") s -= 1;
  return Math.max(0, Math.min(5, s));
}

/**
 * 레포 → 프로젝트. 한 서비스가 BE·FE·관리자로 레포가 갈려 있어도 글은 서비스 단위로 쓴다.
 * 모르는 레포는 레포 이름 그대로.
 */
export function projectOf(repo: string): string {
  const name = (repo.split("/")[1] ?? repo).toLowerCase();
  if (name === "syak" || name.startsWith("syak_")) return "샥";
  if (name.startsWith("anasudal")) return "안아수달";
  if (name === "bigpicture_truck") return "화물";
  return repo.split("/")[1] ?? repo;
}

/** 서비스 소개의 출발점. 재료에서 드러나지 않는 것을 모델이 지어내지 않도록 확실한 것만 적는다 */
const PROJECT_HINT: Record<string, string> = {
  샥: "빈자리 취소석 자동 매칭 서비스다. 세부 동작은 재료에서 확인되는 것만 쓴다.",
};

/** ISO 주의 월요일(YYYY-MM-DD). 입력은 이미 KST 날짜다 */
export function isoWeekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0 … 일=6
  return new Date(d.getTime() - dow * 86400e3).toISOString().slice(0, 10);
}

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ *
 * 1. collect — GitHub 에서 커밋 (하루 또는 기간)
 * ------------------------------------------------------------------ */

type GhRepo = { full_name: string; private: boolean; pushed_at: string; fork?: boolean };

type GhCommit = {
  sha: string;
  parents?: { sha: string }[];
  author?: { login?: string } | null;
  commit?: { message?: string; author?: { email?: string; date?: string }; committer?: { date?: string } };
};

async function gh(path: string, token: string): Promise<unknown> {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "backoffice-devlog",
    },
  });
  if (!r.ok) throw new Error(`GitHub ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export type CollectResult = {
  date: string;
  found: { repo: string; commits: number; score: number; topics: string[] }[];
  inserted: number;
  updated: number;
  skipped: number;
};

export type CollectRangeResult = {
  from: string;
  to: string;
  repos: { repo: string; days: number; commits: number }[];
  /** 읽지 못한 레포와 사유. 한 레포가 막혀도 나머지는 모은다 */
  errors: { repo: string; error: string }[];
  inserted: number;
  updated: number;
  skipped: number;
};

/**
 * 포크는 원본 소유자로 판단한다.
 *
 * 회사 레포를 개인 계정으로 포크하면 full_name 이 내 이름으로 시작해 접두사 차단이
 * 빠져나간다. 포크만 따로 원본을 물어봐서 원본 소유자가 차단 대상이면 같이 막는다.
 */
async function forkOfBlocked(r: GhRepo, token: string, blocked: string[]): Promise<boolean> {
  if (!r.fork) return false;
  try {
    const full = (await gh(`/repos/${r.full_name}`, token)) as { parent?: { full_name?: string } };
    const parent = full.parent?.full_name ?? "";
    return Boolean(parent) && isBlocked(parent, blocked);
  } catch {
    // 원본을 못 읽으면 안전한 쪽으로 — 포크는 건너뛴다
    return true;
  }
}

function assertDate(date: string) {
  // 정규식만으로는 "2024-13-01" 같은 값을 못 거른다. Date.parse 로 한 번 더 본다
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+09:00`))) {
    throw new Error(`날짜 형식이 잘못됐습니다: ${date}`);
  }
}

/**
 * 수집할 레포. 설정에 목록이 있으면 그것만, 없으면 접근 가능한 레포 중 기간 안에 푸시된 것.
 * 어느 쪽이든 차단 소유자와 차단 소유자의 포크는 여기서 빠진다.
 */
async function targetRepos(
  token: string,
  blocked: string[],
  configured: string[],
  since: string,
  errors: CollectRangeResult["errors"],
): Promise<GhRepo[]> {
  let repos: GhRepo[] = [];
  if (configured.length) {
    for (const name of configured) {
      // 차단된 소유자는 레포 정보 조회조차 하지 않는다
      if (isBlocked(name, blocked)) continue;
      try {
        repos.push((await gh(`/repos/${name}`, token)) as GhRepo);
      } catch (e) {
        errors.push({ repo: name, error: (e as Error).message.slice(0, 200) });
      }
    }
  } else {
    for (let page = 1; page <= 4; page++) {
      const batch = (await gh(
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        token,
      )) as GhRepo[];
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    repos = repos.filter((r) => new Date(r.pushed_at) >= new Date(since));
  }
  const out: GhRepo[] = [];
  for (const r of repos) {
    if (isBlocked(r.full_name, blocked)) continue;
    if (await forkOfBlocked(r, token, blocked)) continue;
    out.push(r);
  }
  return out;
}

/**
 * 기간 안의 내 커밋(기본 브랜치). 오래된 것부터.
 *
 * API 의 author 파라미터는 GitHub 계정에 연결된 커밋만 잡는다. 로컬 git 이메일로 찍힌
 * 커밋이 통째로 빠져서, 전부 받아 login 또는 이메일로 직접 거른다. 병합 커밋은 글감이 아니다.
 */
async function myCommits(
  repo: string,
  since: string,
  until: string,
  token: string,
  user: string,
  emails: string[],
): Promise<{ sha: string; message: string; date: string }[]> {
  const all: GhCommit[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = (await gh(
      `/repos/${repo}/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100&page=${page}`,
      token,
    )) as GhCommit[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  const me = user.toLowerCase();
  return all
    .filter((c) => {
      const login = (c.author?.login ?? "").toLowerCase();
      const email = (c.commit?.author?.email ?? "").toLowerCase();
      return (login && login === me) || (email && emails.includes(email));
    })
    .filter((c) => (c.parents?.length ?? 1) < 2)
    .map((c) => ({
      sha: c.sha,
      // 본문 전체를 남긴다 — 이 레포들은 커밋 본문에 이유를 쓴다
      message: (c.commit?.message ?? "").trim(),
      /*
       * 커미터 시각으로 날짜를 정한다. since/until 이 커미터 시각 기준이라, 작성 시각으로
       * 묶으면 리베이스된 커밋이 수집 범위 밖 날짜에 반쪽짜리 행을 만들어 멀쩡한 행을 덮는다.
       */
      date: kstDateOf(c.commit?.committer?.date ?? c.commit?.author?.date ?? new Date().toISOString()),
    }))
    .filter((c) => c.message && !/^Merge (branch|pull request|remote-tracking)/i.test(c.message))
    .reverse();
}

/**
 * 기간 수집. 레포마다 since/until 로 한 번에 받아(페이지네이션) KST 날짜별로 묶어 쌓는다.
 * 하루 수집(`collect`)도 이걸 부른다.
 */
export async function collectRange(from: string, to: string = from): Promise<CollectRangeResult & { rows: DevLogInput[] }> {
  const { token, user, blocked, repos: configured, authorEmails } = await devlogCreds();
  if (!token) throw new Error("GitHub 토큰이 없습니다. 설정 화면에서 등록하세요 (repo 스코프).");
  assertDate(from);
  assertDate(to);
  if (from > to) throw new Error(`기간이 거꾸로입니다: ${from} ~ ${to}`);

  const since = `${from}T00:00:00+09:00`;
  const until = `${to}T23:59:59+09:00`;
  const errors: CollectRangeResult["errors"] = [];
  const repos = await targetRepos(token, blocked, configured, since, errors);

  const rows: DevLogInput[] = [];
  const perRepo: CollectRangeResult["repos"] = [];
  for (const r of repos) {
    let commits: Awaited<ReturnType<typeof myCommits>>;
    try {
      commits = await myCommits(r.full_name, since, until, token, user, authorEmails);
    } catch (e) {
      // 한 레포가 막혀도(권한·삭제) 나머지는 모은다
      errors.push({ repo: r.full_name, error: (e as Error).message.slice(0, 200) });
      continue;
    }
    const byDate = new Map<string, typeof commits>();
    for (const c of commits) {
      if (c.date < from || c.date > to) continue;
      byDate.set(c.date, [...(byDate.get(c.date) ?? []), c]);
    }
    for (const [date, list] of byDate) {
      const messages = list.map((c) => c.message.split("\n")[0].trim());
      const topics = topicsOf(messages);
      rows.push({
        date,
        repo: r.full_name,
        private: r.private,
        commit_count: list.length,
        messages,
        commits: list.map((c) => ({ sha: c.sha, message: c.message })),
        topics,
        score: scoreOf(messages, topics),
      });
    }
    if (byDate.size) {
      perRepo.push({ repo: r.full_name, days: byDate.size, commits: [...byDate.values()].reduce((n, l) => n + l.length, 0) });
    }
  }

  // 이중 방어 — 레포 필터를 믿지 않고 저장 직전에 한 번 더 막는다
  const safeRows = rows.filter((r) => !isBlocked(r.repo, blocked));
  /*
   * 갱신이다, 삽입이 아니다. 수집은 21시에 돌지만 그 뒤에도 커밋은 생긴다.
   * 같은 날·같은 레포가 있으면 아직 초안에 안 쓰인 것에 한해 메시지와 점수를 덮어쓴다.
   */
  const { inserted, updated, skipped } = safeRows.length
    ? await upsertDevLogs(safeRows)
    : { inserted: 0, updated: 0, skipped: 0 };
  return { from, to, repos: perRepo, errors, inserted, updated, skipped, rows: safeRows };
}

export async function collect(date = kstToday()): Promise<CollectResult> {
  const r = await collectRange(date, date);
  return {
    date,
    found: r.rows.map((x) => ({ repo: x.repo, commits: x.commit_count, score: x.score, topics: x.topics })),
    inserted: r.inserted,
    updated: r.updated,
    skipped: r.skipped,
  };
}

/* ------------------------------------------------------------------ *
 * 2. draft — 소비되지 않은 글감 전체에서 프로젝트 × 주 한 묶음을 골라 초안
 * ------------------------------------------------------------------ */

/*
 * 매일 돈다. 창을 두지 않는다 — 소급 수집한 과거 작업도 글감이다. 대신 1~2커밋짜리
 * 묶음은 빼서 쓸 게 없는 뼈대 글이 안 나오게 한다. 점수가 같으면 오래된 주부터 써서
 * 이야기가 시간 순으로 쌓이게 한다.
 */
const MIN_GROUP_COMMITS = 3;
const MIN_GROUP_SCORE = 2;

export type DevlogGroup = {
  project: string;
  week: string;
  weekEnd: string;
  rows: DevLog[];
  repos: string[];
  commits: number;
  score: number;
};

/** 묶음 점수 = dev_logs 점수 합 + 커밋 수 보정(5개마다 1, 최대 5) */
export function groupDevLogs(rows: DevLog[]): DevlogGroup[] {
  const map = new Map<string, DevLog[]>();
  for (const r of rows) {
    const key = `${projectOf(r.repo)}|${isoWeekStart(r.date)}`;
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  const groups: DevlogGroup[] = [];
  for (const [key, list] of map) {
    const [project, week] = key.split("|");
    const commits = list.reduce((n, r) => n + r.commit_count, 0);
    const base = list.reduce((n, r) => n + r.score, 0);
    groups.push({
      project,
      week,
      weekEnd: addDays(week, 6),
      rows: [...list].sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo)),
      repos: [...new Set(list.map((r) => r.repo))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      commits,
      score: base + Math.min(5, Math.floor(commits / 5)),
    });
  }
  return groups
    .filter((g) => g.commits >= MIN_GROUP_COMMITS && g.score >= MIN_GROUP_SCORE)
    .sort((a, b) => b.score - a.score || a.week.localeCompare(b.week));
}

/* ------------------------------------------------------------------ *
 * 초안 재료 — 커밋 본문과 실제 diff
 *
 * 제목 첫 줄만 넘기면 "무엇을 했다"는 나열밖에 못 쓴다. 기술 글의 값은 "왜 그랬고
 * 어떻게 바뀌었나"에 있고, 그건 커밋 본문과 diff 에 있다. 토큰 예산 안에서 잘라 넣는다.
 * ------------------------------------------------------------------ */

/** diff 까지 읽는 커밋 수. 나머지는 제목 목록으로만 들어간다 */
const MAX_DETAILED = 14;
const MAX_FILES_PER_COMMIT = 6;
const MAX_PATCH_CHARS = 1800;
const MAX_TOTAL_CHARS = 42000;
/** 잠금 파일·빌드 산출물·바이너리는 읽어도 글감이 안 된다 */
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.(png|jpg|jpeg|gif|webp|svg|ico|mp4|pdf|ttf|otf|woff2?))$|(^|\/)(dist|build|\.next|node_modules)\//i;
/** diff 를 읽을 가치가 낮은 커밋. 예산이 모자랄 때 먼저 뺀다 */
const TRIVIAL = /^(docs|chore|style|ci|build|test)(\(.+\))?:|^(typo|오타|주석|readme|lint|format)/i;

type CommitDetail = {
  sha: string;
  commit: { message: string };
  stats?: { additions: number; deletions: number };
  files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
};

type Ref = { repo: string; date: string; sha: string; message: string };

/**
 * 묶음의 커밋들을 날짜순으로, 레포 이름을 붙여 diff 까지 읽는다. 비공개 레포도 포함한다.
 * 예전 행(commits 가 빈 것)은 그날을 다시 조회해 SHA 를 채운다.
 */
export async function gatherMaterials(
  group: DevLog[],
  token: string,
  user: string,
  emails: string[] = [],
): Promise<string> {
  const refs: Ref[] = [];
  for (const r of [...group].sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo))) {
    let commits = r.commits ?? [];
    if (!commits.length) {
      try {
        commits = await myCommits(r.repo, `${r.date}T00:00:00+09:00`, `${r.date}T23:59:59+09:00`, token, user, emails);
      } catch {
        /* 못 읽으면 제목만으로 간다 */
      }
    }
    if (commits.length) refs.push(...commits.map((c) => ({ repo: r.repo, date: r.date, sha: c.sha, message: c.message })));
    else refs.push(...r.messages.map((m) => ({ repo: r.repo, date: r.date, sha: "", message: m })));
  }

  // diff 를 읽을 커밋 — 사소한 커밋을 먼저 빼고, 그래도 많으면 앞에서부터
  const readable = refs.filter((r) => r.sha);
  const main = readable.filter((r) => !TRIVIAL.test(r.message));
  const chosen = new Set(
    (main.length >= MAX_DETAILED ? main : [...main, ...readable.filter((r) => TRIVIAL.test(r.message))])
      .slice(0, MAX_DETAILED)
      .map((r) => r.sha),
  );

  const index = [
    `## 커밋 목록 (오래된 순, ${refs.length}개)`,
    ...refs.map((r) => `- ${r.date} [${r.repo.split("/")[1]}] ${r.sha ? r.sha.slice(0, 7) : "-------"} ${r.message.split("\n")[0]}`),
  ].join("\n");

  const chunks: string[] = [index];
  let used = index.length;
  for (const ref of refs) {
    if (!chosen.has(ref.sha)) continue;
    let detail: CommitDetail | null = null;
    try {
      detail = (await gh(`/repos/${ref.repo}/commits/${ref.sha}`, token)) as CommitDetail;
    } catch {
      /* diff 를 못 읽어도 메시지는 넣는다 */
    }
    const lines: string[] = [];
    lines.push(`### [${ref.repo.split("/")[1]}] ${ref.date} 커밋 ${ref.sha.slice(0, 7)}`);
    lines.push(ref.message);
    const files = (detail?.files ?? []).filter((f) => !SKIP_FILE.test(f.filename));
    if (files.length) {
      lines.push(
        `변경 파일 ${files.length}개: ` +
          files.slice(0, 12).map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`).join(", "),
      );
      for (const f of files.slice(0, MAX_FILES_PER_COMMIT)) {
        if (!f.patch) continue;
        const patch = f.patch.length > MAX_PATCH_CHARS ? `${f.patch.slice(0, MAX_PATCH_CHARS)}\n… (이하 생략)` : f.patch;
        lines.push(`\`\`\`diff\n# ${f.filename}\n${patch}\n\`\`\``);
      }
    }
    const chunk = lines.join("\n");
    if (used + chunk.length > MAX_TOTAL_CHARS) {
      chunks.push(`### [${ref.repo.split("/")[1]}] ${ref.date} 커밋 ${ref.sha.slice(0, 7)}\n${ref.message}\n(예산 초과로 diff 생략)`);
      used += 200 + ref.message.length;
      continue;
    }
    chunks.push(chunk);
    used += chunk.length;
  }
  return chunks.join("\n\n");
}

function draftPrompt(g: DevlogGroup, materials: string, user: string): string {
  const repoNames = g.repos.map((r) => r.split("/")[1]).join(", ");
  const hint = PROJECT_HINT[g.project];
  return `아래는 개발자 ${user} 가 ${g.week}~${g.weekEnd} 한 주 동안 "${g.project}" 프로젝트(레포: ${repoNames})에 남긴 커밋들이다.
커밋 본문과 실제 diff 가 들어 있다. 이 재료만으로 velog(개발자 대상 기술 블로그)에 올릴 **완성된 글**을 한국어로 써라.
글쓴이는 이 글을 읽고 고치지 않고 바로 발행 승인한다. 빈칸을 남기면 안 된다.

서비스: ${hint ?? "재료(커밋 메시지·코드·파일 이름)에서 드러나는 서비스의 목적을 파악해 소개한다. 재료로 확인되지 않는 기능은 쓰지 않는다."}

=== 재료 시작 ===
${materials}
=== 재료 끝 ===

글의 목적: 읽는 사람이 "이 서비스는 무엇이고, 이번 주에 무엇이 막혔고, 왜 이렇게 풀었고, 그래서 코드가 어떻게 달라졌는지"를 이해하게 하는 것.

구성 (소제목은 내용에 맞게 다시 지어라):
1. 서비스 소개 — 한 단락. 이 서비스가 무엇을 하는지 재료에서 드러나는 만큼만
2. 문제 — 이번 주 작업의 출발점. 무엇이 안 됐거나 불편했나. 커밋 본문에 적힌 이유를 근거로
3. 판단 — 왜 그 방법을 골랐나. 버린 대안이 커밋에 있으면 함께
4. 변경 전 / 변경 후 — diff 에서 핵심 부분을 골라 코드 블록으로 보여주고 무엇이 달라졌는지 설명. 코드는 재료의 diff 에서 그대로 가져오고 언어 태그를 붙인다. \`-\` \`+\` 접두는 떼고 읽히는 코드로 정리한다
5. 결과 — 무엇이 가능해졌나

규칙:
- **\`> TODO\`, "TODO", "(확인 필요)", "[여기에 ~]" 같은 빈칸·자리표시를 절대 쓰지 마라.** 이 글은 완성본이다
- **재료에 없는 사실·수치·결과는 추측해서 채우지 말고 아예 쓰지 마라.** 모르는 부분은 문장째 빼라
- 결과 수치(성능·사용자 수 등)가 재료에 없으면 수치 없이, 코드 동작으로 "무엇이 가능해졌나"를 설명해라
- 기능 나열 금지. 문제 → 판단 → 변화 흐름으로. 한 주 작업 중 가장 이야기가 되는 줄기 하나를 중심에 두고 나머지는 짧게
- 코드 블록은 2~4개, 각 40줄 이하. diff 를 통째로 붙이지 말고 요점만
- 여러 레포에 걸친 작업이면 어느 쪽(BE·FE·관리자 등) 코드인지 밝혀라
- 제목은 문제와 해법이 드러나는 구체적인 한 문장. "OO 개발기", "개발일지", "N주차" 금지
- 마크다운, 2500~4000자. 첫 줄에 \`# 제목\` 한 줄만 두고 그 아래부터 본문
- 존댓말이 아니라 담백한 평어체("~했다")`;
}

const TODO_RE = /TODO/i;

const RETRY_ASK =
  "TODO 없이 완성본으로 다시 써라. 재료로 채울 수 없는 부분은 자리표시를 남기지 말고 문장째 빼라. " +
  "코드 블록은 2~4개, 전체 4000자를 넘기지 말고 끝까지 마무리해라. 첫 줄은 `# 제목`.";

/** 펜스·서두를 벗겨 첫 `# 제목` 부터 돌려준다 */
function cleanModelText(raw: string): string {
  // 모델이 ```markdown 펜스로 감싸거나 서두 문장을 붙이면 벗겨낸다. 본문은 첫 `# 제목` 부터다
  let text = raw.trim().replace(/^```[a-z]*\s*\n/i, "").replace(/\n```\s*$/, "");
  const at = text.search(/^#\s+.+$/m);
  if (at > 0) text = text.slice(at);
  return text;
}

async function askGemini(prompt: string, previous?: string): Promise<{ text: string; truncated: boolean }> {
  const contents = [
    { role: "user", parts: [{ text: prompt }] },
    ...(previous ? [{ role: "model", parts: [{ text: previous }] }, { role: "user", parts: [{ text: RETRY_ASK }] }] : []),
  ];
  const payload = await geminiCall(
    await geminiModel(),
    // 생각에도 토큰을 쓰는 모델이라 짜게 주면 본문이 빈 채로 돌아온다
    { contents, generationConfig: { maxOutputTokens: 16384, temperature: 0.7 } },
    { retries: 4 },
  );
  const cand = payload?.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts
    .filter((p: { thought?: boolean }) => !p.thought)
    .map((p: { text?: string }) => p.text ?? "")
    .join("");
  return { text: cleanModelText(text), truncated: cand?.finishReason === "MAX_TOKENS" };
}

async function askOpenai(prompt: string, previous?: string): Promise<{ text: string; truncated: boolean }> {
  const user = previous
    ? `${prompt}\n\n=== 앞서 쓴 초안 ===\n${previous}\n=== 끝 ===\n\n${RETRY_ASK}`
    : prompt;
  const r = await openaiJson<{ markdown: string }>({
    system: "너는 개발자의 커밋 기록으로 기술 블로그 글을 쓰는 편집자다. 결과는 markdown 필드 하나에 글 전체를 담는다.",
    user,
    schemaName: "devlog_post",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { markdown: { type: "string", description: "첫 줄 `# 제목` 으로 시작하는 글 전체 마크다운" } },
      required: ["markdown"],
    },
    maxTokens: 32000,
    retries: 3,
  });
  return { text: cleanModelText(r.markdown ?? ""), truncated: false };
}

/**
 * 모델 한 번 호출. Gemini 키가 있으면 Gemini, 없거나 실패하면 OpenAI 로 넘어간다.
 * 둘 다 안 되면 던진다 — 호출자는 초안을 만들지 않고 글감을 남긴다.
 */
async function askModel(prompt: string, previous?: string): Promise<{ text: string; truncated: boolean }> {
  const errors: string[] = [];
  if ((await geminiKeys()).length) {
    try {
      return await askGemini(prompt, previous);
    } catch (e) {
      errors.push(`Gemini: ${(e as Error).message.slice(0, 150)}`);
    }
  }
  if (await openaiKey()) {
    try {
      return await askOpenai(prompt, previous);
    } catch (e) {
      errors.push(`OpenAI: ${(e as Error).message.slice(0, 150)}`);
    }
  }
  throw new Error(errors.join(" / ") || "Gemini·OpenAI 키가 모두 없습니다. 설정 화면에서 등록하세요.");
}

/** 잘린 답의 끝을 마지막 온전한 문단까지 되감는다. 열린 코드 펜스도 닫힌 곳까지 */
function trimTruncated(text: string): string {
  const paras = text.split(/\n{2,}/);
  while (paras.length > 1) {
    paras.pop();
    const t = paras.join("\n\n");
    if (((t.match(/^```/gm) ?? []).length % 2 === 0) && /[.다요)`]$/.test(t.trim())) return t;
  }
  return text;
}

/** TODO 가 든 줄을 지운다. 코드 블록 안의 주석은 원본 코드라 건드리지 않는다 */
function stripTodoLines(text: string): string {
  let inCode = false;
  return text
    .split("\n")
    .filter((line) => {
      if (/^```/.test(line)) inCode = !inCode;
      return inCode || !TODO_RE.test(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const codeBlocks = (text: string) => Math.floor((text.match(/^```/gm) ?? []).length / 2);

/** 코드 블록 밖에 TODO 가 있는가 */
function hasTodo(text: string): boolean {
  return TODO_RE.test(text.replace(/^```[\s\S]*?^```/gm, ""));
}

export type DraftResult =
  | { made: false; reason: string }
  | {
      made: true;
      id: number;
      title: string;
      project: string;
      repo: string;
      source: string;
      commits: number;
      ai: boolean;
      retried: boolean;
      todoStripped: boolean;
    };

export async function draft(): Promise<DraftResult> {
  const { user, token, blocked, repos: configured, authorEmails } = await devlogCreds();
  const allowed = new Set(configured.map((r) => r.toLowerCase()));
  const rows = (await listUnconsumedDevLogs()).filter(
    (r) => !isBlocked(r.repo, blocked) && (!allowed.size || allowed.has(r.repo.toLowerCase())),
  );
  const groups = groupDevLogs(rows);
  if (!groups.length) {
    return {
      made: false,
      reason: `소비되지 않은 글감 중 커밋 ${MIN_GROUP_COMMITS}개 이상인 프로젝트×주 묶음이 없습니다.`,
    };
  }
  const g = groups[0];
  if (!token) return { made: false, reason: "GitHub 토큰이 없어 diff 를 읽을 수 없습니다. 설정 화면에서 등록하세요." };

  const messages = g.rows.flatMap((r) => r.messages);
  const topics = [...new Set(g.rows.flatMap((r) => r.topics))];
  const fromPrivate = g.rows.some((r) => r.private);
  const repoNames = g.repos.map((r) => r.split("/")[1]);
  const source = `${g.project} (${repoNames.join(", ")}) · ${g.week}~${g.weekEnd} 커밋 ${g.commits}개`;

  const materials = await gatherMaterials(g.rows, token, user, authorEmails);

  /*
   * 모델이 실패하면 뼈대를 저장하지 않는다. 뼈대는 사람이 채워야 하는 숙제가 되고,
   * 글감을 소비해 버리면 그 주는 다시 글이 되지 않는다. 그대로 두고 다음 날 다시 시도한다.
   */
  const prompt = draftPrompt(g, materials, user);
  let text: string;
  let retried = false;
  let todoStripped = false;
  try {
    const first = await askModel(prompt);
    text = first.text;
    if (!text) return { made: false, reason: "모델이 빈 답을 돌려줬습니다. 다음 실행에서 다시 시도합니다." };
    // 잘렸거나, TODO 가 남았거나, 코드 블록이 규칙(2~4개)을 넘으면 한 번 더 요청한다
    if (first.truncated || hasTodo(text) || codeBlocks(text) > 4) {
      retried = true;
      const again = await askModel(prompt, text).catch(() => null);
      if (again?.text) text = again.truncated ? trimTruncated(again.text) : again.text;
      else if (first.truncated) text = trimTruncated(text);
    }
  } catch (e) {
    return { made: false, reason: `모델 호출 실패 — 글감은 그대로 두고 다음 실행에서 다시 시도합니다: ${(e as Error).message.slice(0, 200)}` };
  }
  if (hasTodo(text)) {
    text = stripTodoLines(text);
    todoStripped = true;
  }

  const found = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  // 모델이 제목 자리에 인용 표시를 넣으면 제목으로 못 쓴다
  if (!found || /^(>|\[)/.test(found)) {
    return { made: false, reason: "모델 응답에 제목이 없습니다. 다음 실행에서 다시 시도합니다." };
  }
  const title = found;
  const body = text.replace(/^#\s+.+\n+/, "").trim();
  if (body.length < 800) {
    return { made: false, reason: `모델 응답이 너무 짧습니다 (${body.length}자). 다음 실행에서 다시 시도합니다.` };
  }

  const id = await insertVelogPost({
    title,
    body_markdown: body,
    tags: [g.project, ...topics].slice(0, 5),
    source,
    from_private: fromPrivate,
    auto_generated: true,
    status: "draft",
  });
  await markDevLogsConsumed(g.rows.map((r) => r.id));

  return {
    made: true,
    id,
    title,
    project: g.project,
    repo: g.repos.join(", "),
    source,
    commits: messages.length,
    ai: true,
    retried,
    todoStripped,
  };
}

/* ------------------------------------------------------------------ *
 * velog GraphQL — 공식 API 가 아니다
 * ------------------------------------------------------------------ */

/*
 * v3 다. v2 는 읽기 쿼리만 남아 있고 mutation 이 하나도 없다 — 원본 devlog 의 발행은
 * 이미 죽어 있었다. v3 는 인자를 전부 input 객체로 받고, refresh_token 쿠키만 있어도
 * 새 access_token 을 Set-Cookie 로 돌려준다(실측).
 */
const VELOG = "https://v3.velog.io/graphql";

export type VelogAuth = { access: string; refresh: string };

/**
 * velog 는 access_token 이 24시간, refresh_token 이 30일이다. access 가 죽어도 refresh 가
 * 쿠키에 같이 있으면 서버가 새 쌍을 Set-Cookie 로 돌려준다. 그걸 받아 설정에 다시 넣어야
 * 다음 날에도 발행이 된다 — 안 그러면 매일 브라우저에서 쿠키를 꺼내 와야 한다.
 */
async function velogGql(query: string, variables: unknown, auth?: VelogAuth): Promise<any> {
  const cookie = auth
    ? [auth.access && `access_token=${auth.access}`, auth.refresh && `refresh_token=${auth.refresh}`]
        .filter(Boolean)
        .join("; ")
    : "";
  const r = await fetch(VELOG, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  if (auth) await rotateVelogCookies(r, auth);
  if (!r.ok) throw new Error(`velog HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(`velog: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.data;
}

/** 응답의 Set-Cookie 에 새 토큰이 있으면 설정에 저장한다. 값이 같으면 건드리지 않는다 */
async function rotateVelogCookies(r: Response, auth: VelogAuth): Promise<void> {
  const cookies: string[] =
    typeof (r.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [];
  const pick = (name: string) => {
    for (const c of cookies) {
      const m = c.match(new RegExp(`^${name}=([^;]*)`));
      if (m && m[1]) return m[1];
    }
    return "";
  };
  const access = pick("access_token");
  const refresh = pick("refresh_token");
  if (!hasSupabase()) return;
  if (access && access !== auth.access) {
    await setSetting("velog_token", access).catch(() => {});
    auth.access = access;
  }
  if (refresh && refresh !== auth.refresh) {
    await setSetting("velog_refresh_token", refresh).catch(() => {});
    auth.refresh = refresh;
  }
}

/** 토큰이 살아 있는지. 만료된 쿠키는 currentUser 가 null 로 온다 */
export async function velogWhoAmI(auth: VelogAuth): Promise<string | null> {
  const d = await velogGql(`query { currentUser { username } }`, {}, auth);
  return d?.currentUser?.username ?? null;
}

const WRITE = `
mutation W($input: WritePostInput!) {
  writePost(input: $input) { id url_slug title released_at }
}`;

/* ------------------------------------------------------------------ *
 * 3. publish — 승인된 글만
 * ------------------------------------------------------------------ */

export type PublishResult = {
  published: { id: number; title: string; url: string }[];
  failed: { id: number; title: string; error: string }[];
};

export async function publish(): Promise<PublishResult> {
  const { velogToken, velogRefresh, velogUser } = await devlogCreds();
  const rows = await listVelogPostsByStatus("approved");
  const out: PublishResult = { published: [], failed: [] };
  if (!rows.length) return out;
  if (!velogToken && !velogRefresh) {
    throw new Error("velog 토큰이 없습니다. 설정 화면에서 로그인 쿠키(access_token · refresh_token)를 등록하세요.");
  }
  const auth: VelogAuth = { access: velogToken, refresh: velogRefresh };

  for (const row of rows) {
    /*
     * 선점. 크론과 화면 버튼이 겹치면 같은 글이 velog 에 두 번 올라간다.
     * approved → publishing 조건부 갱신이 한쪽에서만 성공한다.
     */
    if (!(await claimVelogPost(row.id))) continue;
    let written: { id: string; url_slug: string; released_at?: string } | null = null;
    try {
      const body = row.body_markdown.trim();
      if (body.length < 200) throw new Error(`본문이 너무 짧습니다 (${body.length}자). 초안을 채우세요.`);
      if (/^>\s*TODO/m.test(body)) throw new Error("본문에 TODO 가 남아 있습니다. 채우거나 지우세요.");

      const slug = row.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80);
      const data = await velogGql(
        WRITE,
        {
          input: {
            title: row.title,
            body,
            tags: row.tags,
            is_markdown: true,
            is_temp: false,
            is_private: false,
            url_slug: slug,
            thumbnail: null,
            meta: {},
            series_id: null,
          },
        },
        auth,
      );
      const post = data?.writePost;
      if (!post?.id) throw new Error("writePost 가 null 을 반환했습니다. 쿠키가 만료됐을 가능성이 높습니다.");
      written = post;

      const url = `https://velog.io/@${velogUser}/${post.url_slug}`;
      const patch = {
        status: "published",
        url,
        velog_id: String(post.id),
        error: "",
        published_at: post.released_at ?? new Date().toISOString(),
      };
      // velog 에는 올라갔는데 여기 기록이 실패하면 다음 시도가 또 올린다. 한 번 더 써본다
      await updateVelogPost(row.id, patch).catch(() => updateVelogPost(row.id, patch));
      out.published.push({ id: row.id, title: row.title, url });
    } catch (e) {
      const error = (e as Error).message;
      /*
       * 올리기 전에 실패했으면 승인 상태로 되돌린다 — 원인을 고치면 다음 아침에 다시 간다.
       * 올린 뒤에 실패했으면 되돌리지 않는다. 되돌리면 중복 발행이고, publishing 으로
       * 남겨두면 화면에서 사유를 보고 사람이 정리한다.
       */
      await updateVelogPost(row.id, written ? { error } : { status: "approved", error }).catch(() => {});
      out.failed.push({ id: row.id, title: row.title, error });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. sync — velog → 여기. 읽기라 토큰이 필요 없다
 * ------------------------------------------------------------------ */

type VelogListed = {
  id: string;
  title: string;
  short_description: string;
  url_slug: string;
  released_at: string;
  tags: string[];
  likes: number;
  comments_count: number;
  is_private: boolean;
};

const POSTS = `
query P($input: GetPostsInput!) {
  posts(input: $input) {
    id title short_description url_slug released_at tags likes comments_count is_private
  }
}`;

const POST_BODY = `
query B($input: ReadPostInput!) {
  post(input: $input) { body }
}`;

async function allVelogPosts(user: string): Promise<VelogListed[]> {
  const out: VelogListed[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const d = await velogGql(POSTS, { input: { username: user, cursor, limit: 20 } });
    const batch: VelogListed[] = d?.posts ?? [];
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 20) break;
    cursor = batch[batch.length - 1].id;
  }
  return out;
}

export type SyncResult = { total: number; created: number; linked: number; refreshed: number };

export async function sync(): Promise<SyncResult> {
  const { velogUser: user } = await devlogCreds();
  const posts = (await allVelogPosts(user)).filter((p) => !p.is_private);
  const out: SyncResult = { total: posts.length, created: 0, linked: 0, refreshed: 0 };

  for (const p of posts) {
    const url = `https://velog.io/@${user}/${p.url_slug}`;
    const existing = await findVelogPost(url, p.title);

    if (existing) {
      const patch: Record<string, unknown> = { likes: p.likes, comments: p.comments_count };
      // 손으로 velog 에 올린 글이 여기 미발행으로 남아 있는 경우
      if (existing.status !== "published") {
        patch.status = "published";
        patch.published_at = p.released_at;
        out.linked += 1;
      }
      if (!existing.url) patch.url = url;
      if (!existing.velog_id) patch.velog_id = p.id;
      // 제목·본문은 절대 덮어쓰지 않는다. 상태·URL·반응만 만진다
      await updateVelogPost(existing.id, patch);
      out.refreshed += 1;
      continue;
    }

    // 본문은 목록 응답에 없다. 따로 읽되, 스키마가 다르면 요약으로 대신한다
    let body = p.short_description ?? "";
    try {
      const d = await velogGql(POST_BODY, { input: { username: user, url_slug: p.url_slug } });
      if (typeof d?.post?.body === "string" && d.post.body.trim()) body = d.post.body;
    } catch {
      /* 요약으로 충분하다 */
    }

    await insertVelogPost({
      title: p.title,
      body_markdown: body,
      tags: p.tags ?? [],
      source: "velog 역동기화",
      auto_generated: false,
      status: "published",
      url,
      velog_id: p.id,
      likes: p.likes,
      comments: p.comments_count,
      published_at: p.released_at,
    });
    out.created += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 실행 진입점 — 크론·화면·CLI 가 같은 문을 쓴다
 * ------------------------------------------------------------------ */

export const TASKS = ["collect", "collect-range", "draft", "publish", "sync"] as const;
export type Task = (typeof TASKS)[number];

export function isTask(v: unknown): v is Task {
  return typeof v === "string" && (TASKS as readonly string[]).includes(v);
}

export async function runTask(task: Task, opts: { date?: string; to?: string } = {}): Promise<unknown> {
  switch (task) {
    case "collect":
      return collect(opts.date || kstToday());
    case "collect-range": {
      // 소급 수집. 끝 날짜를 비우면 오늘까지. 저장한 행 전체는 돌려주지 않는다 — 너무 크다
      if (!opts.date) throw new Error("collect-range 는 시작 날짜가 필요합니다 (YYYY-MM-DD).");
      const { rows: _rows, ...rest } = await collectRange(opts.date, opts.to || kstToday());
      return rest;
    }
    case "draft":
      return draft();
    case "publish":
      return publish();
    case "sync":
      return sync();
  }
}
