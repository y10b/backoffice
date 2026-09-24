/**
 * 개발 로그 갈래 — 깃 이력을 모아 velog 글 초안을 만들고, 승인한 것만 올린다.
 *
 * 원래 별도 레포(y10b/devlog)였다. 노션 DB 세 개를 저장소로 쓰고 깃액션 네 개가 각자
 * 스크립트를 돌렸다. 승인 화면이 노션에, 나머지가 백오피스에 있으면 검토가 두 곳으로
 * 갈리므로 여기로 옮겼다. 저장소는 Supabase, 화면은 /devlog, 실행은 이 모듈 하나다.
 *
 *  | 단계    | 언제        | 하는 일                                            |
 *  |---------|-------------|----------------------------------------------------|
 *  | collect | 매일 21시   | 그날 커밋을 레포별로 모아 dev_logs 에 쌓는다        |
 *  | draft   | 매일 22시반 | 최근 7일에서 글감 하나를 골라 velog_posts 초안을 만든다 |
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
import { geminiCall, geminiModel } from "./gemini";

/* ------------------------------------------------------------------ *
 * 설정
 * ------------------------------------------------------------------ */

const DEFAULT_BLOCKED = "bambitcorporation";

export async function devlogCreds(): Promise<{
  token: string;
  user: string;
  /** velog 핸들. GitHub 과 다를 수 있어 따로 둔다 — 비우면 GitHub 사용자를 쓴다 */
  velogUser: string;
  velogToken: string;
  /** access_token 은 24시간짜리다. refresh_token(30일)을 같이 보내야 매일 발행이 산다 */
  velogRefresh: string;
  blocked: string[];
}> {
  const s = await getSettings([
    "github_pat", "github_user", "velog_user", "velog_token", "velog_refresh_token",
    "devlog_blocked_owners",
  ]);
  const user = s.github_user || process.env.GH_USER || "y10b";
  // 설정에서 목록을 바꿔도 기본 차단 대상은 늘 남는다. 지워지는 순간이 새는 순간이다
  const blockedRaw = `${DEFAULT_BLOCKED},${s.devlog_blocked_owners || process.env.DEVLOG_BLOCKED_OWNERS || ""}`;
  return {
    token: s.github_pat || process.env.GH_PAT || process.env.GITHUB_TOKEN || "",
    user,
    velogUser: s.velog_user || process.env.VELOG_USER || user,
    velogToken: s.velog_token || process.env.VELOG_TOKEN || "",
    velogRefresh: s.velog_refresh_token || process.env.VELOG_REFRESH_TOKEN || "",
    blocked: [...new Set(blockedRaw.split(/[\s,]+/).map((o) => o.trim().toLowerCase()).filter(Boolean))],
  };
}

export const isBlocked = (fullName: string, blocked: string[]) =>
  blocked.some((o) => fullName.toLowerCase().startsWith(`${o}/`));

/** KST 기준 오늘 날짜 (YYYY-MM-DD). 러너와 Vercel 은 UTC 라 그대로 쓰면 하루가 밀린다 */
export function kstToday(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
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

/* ------------------------------------------------------------------ *
 * 1. collect — GitHub 에서 하루치 커밋
 * ------------------------------------------------------------------ */

type GhRepo = { full_name: string; private: boolean; pushed_at: string; fork?: boolean };

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

export async function collect(date = kstToday()): Promise<CollectResult> {
  const { token, user, blocked } = await devlogCreds();
  if (!token) throw new Error("GitHub 토큰이 없습니다. 설정 화면에서 등록하세요 (repo 스코프).");
  // 정규식만으로는 "2024-13-01" 같은 값을 못 거른다. Date.parse 로 한 번 더 본다
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+09:00`))) {
    throw new Error(`날짜 형식이 잘못됐습니다: ${date}`);
  }

  const since = `${date}T00:00:00+09:00`;
  const until = `${date}T23:59:59+09:00`;

  const repos: GhRepo[] = [];
  for (let page = 1; page <= 4; page++) {
    const batch = (await gh(
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      token,
    )) as GhRepo[];
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  // 차단된 소유자는 커밋 조회조차 하지 않는다
  const candidates = repos.filter(
    (r) => !isBlocked(r.full_name, blocked) && new Date(r.pushed_at) >= new Date(since),
  );

  const rows: DevLogInput[] = [];
  for (const r of candidates) {
    if (await forkOfBlocked(r, token, blocked)) continue;
    try {
      const list = (await gh(
        `/repos/${r.full_name}/commits?author=${user}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`,
        token,
      )) as { sha: string; commit?: { message?: string } }[];
      // 병합 커밋은 글감이 아니다. 본문 전체를 남긴다 — 이 레포는 커밋 본문에 이유를 쓴다
      const commits = list
        .map((c) => ({ sha: c.sha, message: (c.commit?.message ?? "").trim() }))
        .filter((c) => c.message && !/^Merge (branch|pull request)/i.test(c.message));
      const messages = commits.map((c) => c.message.split("\n")[0].trim());
      if (!messages.length) continue;
      const topics = topicsOf(messages);
      rows.push({
        date,
        repo: r.full_name,
        private: r.private,
        commit_count: messages.length,
        messages,
        commits,
        topics,
        score: scoreOf(messages, topics),
      });
    } catch {
      // 한 레포가 막혀도(권한·삭제) 나머지는 모은다
    }
  }

  // 이중 방어 — candidates 필터를 믿지 않고 저장 직전에 한 번 더 막는다
  const safeRows = rows.filter((r) => !isBlocked(r.repo, blocked));
  /*
   * 갱신이다, 삽입이 아니다. 수집은 21시에 돌지만 그 뒤에도 커밋은 생긴다.
   * 같은 날·같은 레포가 있으면 아직 초안에 안 쓰인 것에 한해 메시지와 점수를 덮어쓴다.
   */
  const { inserted, updated, skipped } = safeRows.length
    ? await upsertDevLogs(safeRows)
    : { inserted: 0, updated: 0, skipped: 0 };
  return {
    date,
    found: safeRows.map((r) => ({ repo: r.repo, commits: r.commit_count, score: r.score, topics: r.topics })),
    inserted,
    updated,
    skipped,
  };
}

/* ------------------------------------------------------------------ *
 * 2. draft — 지난 7일에서 글감 하나를 골라 초안
 * ------------------------------------------------------------------ */

/*
 * 매일 돈다. 창은 7일로 두어 어제 놓친 글감도 잡고, 점수 문턱은 2 로 낮춘다 —
 * 매일 검토하기로 했으니 걸러내는 건 사람이 한다. 다만 점수 미달인 날은 여전히 비운다.
 */
const WINDOW_DAYS = 7;
const MIN_SCORE = 2;

/* ------------------------------------------------------------------ *
 * 초안 재료 — 커밋 본문과 실제 diff
 *
 * 제목 첫 줄만 넘기면 "무엇을 했다"는 나열밖에 못 쓴다. 기술 글의 값은 "왜 그랬고
 * 어떻게 바뀌었나"에 있고, 그건 커밋 본문과 diff 에 있다. 토큰 예산 안에서 잘라 넣는다.
 * ------------------------------------------------------------------ */

const MAX_COMMITS = 12;
const MAX_FILES_PER_COMMIT = 6;
const MAX_PATCH_CHARS = 1800;
const MAX_TOTAL_CHARS = 42000;
/** 잠금 파일·빌드 산출물·바이너리는 읽어도 글감이 안 된다 */
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.(png|jpg|jpeg|gif|webp|svg|ico|mp4|pdf|ttf|otf|woff2?))$|(^|\/)(dist|build|\.next|node_modules)\//i;

type CommitDetail = {
  sha: string;
  commit: { message: string };
  stats?: { additions: number; deletions: number };
  files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
};

/**
 * 커밋들을 diff 까지 읽어 모델에 줄 재료 문자열로 만든다.
 * 예전 행(commits 가 빈 것)은 날짜 범위로 다시 조회해 SHA 를 채운다.
 */
export async function gatherMaterials(repo: string, group: DevLog[], token: string, user: string): Promise<string> {
  let refs = group.flatMap((r) => r.commits ?? []);
  if (!refs.length) {
    for (const r of group) {
      const since = `${r.date}T00:00:00+09:00`;
      const until = `${r.date}T23:59:59+09:00`;
      try {
        const list = (await gh(
          `/repos/${repo}/commits?author=${user}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`,
          token,
        )) as { sha: string; commit?: { message?: string } }[];
        refs.push(
          ...list
            .map((c) => ({ sha: c.sha, message: (c.commit?.message ?? "").trim() }))
            .filter((c) => c.message && !/^Merge (branch|pull request)/i.test(c.message)),
        );
      } catch {
        /* 못 읽으면 제목만으로 간다 */
      }
    }
  }
  // 오래된 것부터 — 글은 작업 순서대로 읽힌다
  refs = refs.slice(-MAX_COMMITS);

  const chunks: string[] = [];
  let used = 0;
  for (const ref of refs) {
    let detail: CommitDetail | null = null;
    try {
      detail = (await gh(`/repos/${repo}/commits/${ref.sha}`, token)) as CommitDetail;
    } catch {
      /* diff 를 못 읽어도 메시지는 넣는다 */
    }
    const lines: string[] = [];
    lines.push(`### 커밋 ${ref.sha.slice(0, 7)}`);
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
      chunks.push(`### 커밋 ${ref.sha.slice(0, 7)}\n${ref.message.split("\n")[0]}\n(예산 초과로 diff 생략)`);
      continue;
    }
    chunks.push(chunk);
    used += chunk.length;
  }
  return chunks.join("\n\n");
}

function draftPrompt(repo: string, dates: string[], materials: string, user: string): string {
  return `아래는 개발자 ${user} 가 ${dates[0]}~${dates[dates.length - 1]} 사이 \`${repo}\` 레포에 남긴 커밋들이다.
커밋 본문과 실제 diff 가 들어 있다. 이 재료만으로 velog(개발자 대상 기술 블로그)에 올릴 글의 **초안**을 한국어로 써라.

=== 재료 시작 ===
${materials}
=== 재료 끝 ===

글의 목적: 읽는 사람이 "이 사람은 무엇이 막혔고, 왜 이렇게 풀었고, 그래서 코드가 어떻게 달라졌는지"를 이해하게 하는 것.

구성 (소제목은 내용에 맞게 다시 지어라):
1. 배경 — 어떤 상황에서 무엇이 문제였나. 커밋 본문에 적힌 이유를 근거로 쓴다
2. 판단 — 왜 그 방법을 골랐나. 버린 대안이 커밋에 있으면 함께
3. 구현 — diff 에서 핵심 부분을 골라 **변경 전 / 변경 후** 코드 블록으로 보여주고, 무엇이 달라졌는지 설명. 코드는 재료의 diff 에서 그대로 가져오고 언어 태그를 붙인다. \`-\` \`+\` 접두는 떼고 읽히는 코드로 정리해도 된다
4. 결과와 남은 것 — 무엇이 해결됐고 무엇이 아직 확인 필요인지

규칙:
- **재료에 없는 사실·수치·결과를 지어내지 마라.** 재료에 없으면 \`> TODO: ~\` 로 남겨라
- 기능 나열 금지. 문제 → 원인 → 판단 → 변화 흐름으로
- 코드 블록은 최소 2개, 각 40줄 이하. diff 를 통째로 붙이지 말고 요점만
- 제목은 문제와 해법이 드러나는 구체적인 한 문장. "OO 개발기" 금지
- 마크다운, 2500~3500자. 첫 줄에 \`# 제목\` 한 줄만 두고 그 아래부터 본문
- 존댓말이 아니라 담백한 평어체("~했다")

글쓴이가 읽고 고칠 초안이다. 확신 없는 부분은 \`> TODO: ~\` 로 표시해라.`;
}

function skeleton(title: string, messages: string[]): string {
  return [
    `# ${title}`,
    ``,
    `> 자동 생성된 뼈대입니다. 커밋 기록을 보고 직접 채워 넣으세요.`,
    ``,
    `## 무엇을 하려고 했나`,
    `> TODO`,
    ``,
    `## 무엇이 문제였나`,
    `> TODO`,
    ``,
    `## 어떻게 판단했나`,
    `> TODO`,
    ``,
    `## 결과`,
    `> TODO`,
    ``,
    `---`,
    ``,
    `### 참고 — 이 기간의 커밋`,
    ``,
    ...messages.map((m) => `- ${m}`),
  ].join("\n");
}

export type DraftResult =
  | { made: false; reason: string }
  | { made: true; id: number; title: string; repo: string; commits: number; ai: boolean; aiError?: string };

export async function draft(): Promise<DraftResult> {
  const { user, token } = await devlogCreds();
  const from = kstToday(-WINDOW_DAYS);
  const rows = (await listUnconsumedDevLogs(from)).filter((r) => r.score >= MIN_SCORE);
  if (!rows.length) {
    return { made: false, reason: `지난 ${WINDOW_DAYS}일 중 글감 점수 ${MIN_SCORE} 이상인 날이 없습니다.` };
  }

  // 같은 레포끼리 묶는다 — 하루가 아니라 '한 덩어리의 작업'이 글이 된다
  const byRepo = new Map<string, DevLog[]>();
  for (const r of rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const [repo, group] = [...byRepo.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  const messages = group.flatMap((r) => r.messages);
  const topics = [...new Set(group.flatMap((r) => r.topics))];
  const dates = group.map((r) => r.date).sort();
  const fromPrivate = group.some((r) => r.private);

  // diff 까지 읽는다. 토큰이 없거나 레포가 사라져 못 읽으면 제목만으로 간다
  let materials = token ? await gatherMaterials(repo, group, token, user) : "";
  if (!materials.trim()) {
    materials =
      "(레포에서 diff 를 읽지 못했다. 아래는 커밋 제목뿐이다 — 코드 블록은 만들지 말고 확인 필요로 남겨라)\n" +
      messages.map((m) => `- ${m}`).join("\n");
  }

  let ai: string | null = null;
  let aiError: string | undefined;
  try {
    const payload = await geminiCall(await geminiModel(), {
      contents: [{ role: "user", parts: [{ text: draftPrompt(repo, dates, materials, user) }] }],
      // 생각에도 토큰을 쓰는 모델이라 짜게 주면 본문이 빈 채로 돌아온다
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
    });
    const cand = payload?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    let text = parts.map((p: { text?: string }) => p.text ?? "").join("").trim();
    // 모델이 ```markdown 펜스로 감싸거나 서두 문장을 붙이면 벗겨낸다. 본문은 첫 `# 제목` 부터다
    text = text.replace(/^```[a-z]*\s*\n/i, "").replace(/\n```\s*$/, "");
    const at = text.search(/^#\s+.+$/m);
    if (at > 0) text = text.slice(at);
    // 길이 제한으로 잘린 답은 끝이 없다. 승인 전에 눈에 띄도록 TODO 로 남긴다
    if (text && cand?.finishReason === "MAX_TOKENS") {
      text += "\n\n> TODO: 모델 응답이 길이 제한으로 잘렸습니다. 끝부분을 확인하세요.";
    }
    ai = text || null;
  } catch (e) {
    // 모델이 막혀도 뼈대는 만든다. 중요한 건 "그때 뭘 했는지"가 남는 것이다. 사유는 결과에 남긴다
    aiError = (e as Error).message.slice(0, 200);
  }

  const short = repo.split("/")[1];
  const fallbackTitle = `${short} — ${topics.join(" · ") || "작업"} 기록`;
  const found = ai?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  // 모델이 제목 자리에 TODO 나 인용 표시를 넣으면 제목으로 못 쓴다
  const title = found && !/^(>|TODO|\[)/.test(found) ? found : fallbackTitle;
  const body = (ai ?? skeleton(title, messages)).replace(/^#\s+.+\n+/, "");

  const id = await insertVelogPost({
    title,
    body_markdown: body,
    tags: topics,
    source: `${repo} · ${dates[0]}~${dates[dates.length - 1]} 커밋 ${messages.length}개`,
    from_private: fromPrivate,
    auto_generated: true,
    status: "draft",
  });
  await markDevLogsConsumed(group.map((r) => r.id));

  return { made: true, id, title, repo, commits: messages.length, ai: Boolean(ai), aiError };
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

export const TASKS = ["collect", "draft", "publish", "sync"] as const;
export type Task = (typeof TASKS)[number];

export function isTask(v: unknown): v is Task {
  return typeof v === "string" && (TASKS as readonly string[]).includes(v);
}

export async function runTask(task: Task, opts: { date?: string } = {}): Promise<unknown> {
  switch (task) {
    case "collect":
      return collect(opts.date || kstToday());
    case "draft":
      return draft();
    case "publish":
      return publish();
    case "sync":
      return sync();
  }
}
