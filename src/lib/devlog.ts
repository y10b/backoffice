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
 *  | draft   | 일요일 10시 | 지난 7일에서 글감을 골라 velog_posts 초안을 만든다  |
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
  findVelogPost,
  getSettings,
  insertDevLogs,
  insertVelogPost,
  listUnconsumedDevLogs,
  listVelogPostsByStatus,
  markDevLogsConsumed,
  updateVelogPost,
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
  velogToken: string;
  blocked: string[];
}> {
  const s = await getSettings(["github_pat", "github_user", "velog_token", "devlog_blocked_owners"]);
  const blockedRaw = s.devlog_blocked_owners || process.env.DEVLOG_BLOCKED_OWNERS || DEFAULT_BLOCKED;
  return {
    token: s.github_pat || process.env.GH_PAT || process.env.GITHUB_TOKEN || "",
    user: s.github_user || process.env.GH_USER || "y10b",
    velogToken: s.velog_token || process.env.VELOG_TOKEN || "",
    blocked: blockedRaw.split(/[\s,]+/).map((o) => o.trim().toLowerCase()).filter(Boolean),
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
  if (/(^|\n)\s*refactor|리팩|걷어|정리/.test(joined)) t.add("리팩토링");
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

type GhRepo = { full_name: string; private: boolean; pushed_at: string };

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
  skipped: number;
};

export async function collect(date = kstToday()): Promise<CollectResult> {
  const { token, user, blocked } = await devlogCreds();
  if (!token) throw new Error("GitHub 토큰이 없습니다. 설정 화면에서 등록하세요 (repo 스코프).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`날짜 형식이 잘못됐습니다: ${date}`);

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
    try {
      const commits = (await gh(
        `/repos/${r.full_name}/commits?author=${user}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`,
        token,
      )) as { commit?: { message?: string } }[];
      const messages = commits
        .map((c) => (c.commit?.message ?? "").split("\n")[0].trim())
        .filter(Boolean)
        .filter((m) => !/^Merge (branch|pull request)/i.test(m));
      if (!messages.length) continue;
      const topics = topicsOf(messages);
      rows.push({
        date,
        repo: r.full_name,
        private: r.private,
        commit_count: messages.length,
        messages,
        topics,
        score: scoreOf(messages, topics),
      });
    } catch {
      // 한 레포가 막혀도(권한·삭제) 나머지는 모은다
    }
  }

  const { inserted, skipped } = rows.length ? await insertDevLogs(rows) : { inserted: 0, skipped: 0 };
  return {
    date,
    found: rows.map((r) => ({ repo: r.repo, commits: r.commit_count, score: r.score, topics: r.topics })),
    inserted,
    skipped,
  };
}

/* ------------------------------------------------------------------ *
 * 2. draft — 지난 7일에서 글감 하나를 골라 초안
 * ------------------------------------------------------------------ */

const WINDOW_DAYS = 7;
const MIN_SCORE = 3;

function draftPrompt(repo: string, dates: string[], messages: string[], user: string): string {
  return `아래는 개발자 ${user} 가 ${dates[0]}~${dates[dates.length - 1]} 사이 \`${repo}\` 레포에 남긴 커밋 메시지다.

${messages.map((m) => `- ${m}`).join("\n")}

이걸로 velog(개발자 대상 기술 블로그)에 올릴 글의 **초안**을 한국어로 써라.

규칙:
- 커밋에 실제로 드러난 사실만 쓴다. **없는 수치·없는 결과를 지어내지 마라.** 모르는 건 "확인 필요"로 남겨라
- 기능 나열이 아니라 **"왜 그렇게 했는가"** 가 중심이다. 문제 → 원인 → 판단 → 결과 순서
- 제목은 구체적인 한 문장. "OO 개발기" 같은 제목 금지
- 마크다운. 2000자 내외
- 첫 줄에 \`# 제목\` 한 줄만 두고, 그 아래부터 본문

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
  | { made: true; id: number; title: string; repo: string; commits: number; ai: boolean };

export async function draft(): Promise<DraftResult> {
  const { user } = await devlogCreds();
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

  let ai: string | null = null;
  try {
    const payload = await geminiCall(await geminiModel(), {
      contents: [{ role: "user", parts: [{ text: draftPrompt(repo, dates, messages, user) }] }],
      // 생각에도 토큰을 쓰는 모델이라 짜게 주면 본문이 빈 채로 돌아온다
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
    });
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p: { text?: string }) => p.text ?? "").join("").trim();
    ai = text || null;
  } catch {
    // 모델이 막혀도 뼈대는 만든다. 중요한 건 "그때 뭘 했는지"가 남는 것이다
  }

  const short = repo.split("/")[1];
  const title = ai?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? `${short} — ${topics.join(" · ") || "작업"} 기록`;
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

  return { made: true, id, title, repo, commits: messages.length, ai: Boolean(ai) };
}

/* ------------------------------------------------------------------ *
 * velog GraphQL — 공식 API 가 아니다
 * ------------------------------------------------------------------ */

const VELOG = "https://v2.velog.io/graphql";

async function velogGql(query: string, variables: unknown, token?: string): Promise<any> {
  const r = await fetch(VELOG, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `access_token=${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`velog HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(`velog: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.data;
}

/** 토큰이 살아 있는지. 만료된 쿠키는 currentUser 가 null 로 온다 */
export async function velogWhoAmI(token: string): Promise<string | null> {
  const d = await velogGql(`query { currentUser { username } }`, {}, token);
  return d?.currentUser?.username ?? null;
}

const WRITE = `
mutation W($title:String,$body:String,$tags:[String],$is_markdown:Boolean,$is_temp:Boolean,$is_private:Boolean,$url_slug:String,$thumbnail:String,$meta:JSON,$series_id:ID){
  writePost(title:$title,body:$body,tags:$tags,is_markdown:$is_markdown,is_temp:$is_temp,is_private:$is_private,url_slug:$url_slug,thumbnail:$thumbnail,meta:$meta,series_id:$series_id){
    id url_slug title released_at
  }
}`;

/* ------------------------------------------------------------------ *
 * 3. publish — 승인된 글만
 * ------------------------------------------------------------------ */

export type PublishResult = {
  published: { id: number; title: string; url: string }[];
  failed: { id: number; title: string; error: string }[];
};

export async function publish(): Promise<PublishResult> {
  const { velogToken, user } = await devlogCreds();
  const rows = await listVelogPostsByStatus("approved");
  const out: PublishResult = { published: [], failed: [] };
  if (!rows.length) return out;
  if (!velogToken) {
    throw new Error("velog 토큰이 없습니다. 설정 화면에서 로그인 쿠키(access_token)를 등록하세요.");
  }

  for (const row of rows) {
    try {
      const body = row.body_markdown.trim();
      if (body.length < 200) throw new Error(`본문이 너무 짧습니다 (${body.length}자). 초안을 채우세요.`);
      if (/^>\s*TODO/m.test(body)) throw new Error("본문에 TODO 가 남아 있습니다. 채우거나 지우세요.");

      const slug = row.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80);
      const data = await velogGql(
        WRITE,
        {
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
        velogToken,
      );
      const post = data?.writePost;
      if (!post?.id) throw new Error("writePost 가 null 을 반환했습니다. 쿠키가 만료됐을 가능성이 높습니다.");

      const url = `https://velog.io/@${user}/${post.url_slug}`;
      await updateVelogPost(row.id, {
        status: "published",
        url,
        velog_id: String(post.id),
        error: "",
        published_at: post.released_at ?? new Date().toISOString(),
      });
      out.published.push({ id: row.id, title: row.title, url });
    } catch (e) {
      const error = (e as Error).message;
      // 승인 상태는 그대로 둔다. 원인을 고치면 다음 아침에 다시 시도된다
      await updateVelogPost(row.id, { error }).catch(() => {});
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
query P($username:String,$cursor:ID,$limit:Int){
  posts(username:$username, cursor:$cursor, limit:$limit){
    id title short_description url_slug released_at tags likes comments_count is_private
  }
}`;

const POST_BODY = `
query B($username:String,$url_slug:String){
  post(username:$username, url_slug:$url_slug){ body }
}`;

async function allVelogPosts(user: string): Promise<VelogListed[]> {
  const out: VelogListed[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const d = await velogGql(POSTS, { username: user, cursor, limit: 20 });
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
  const { user } = await devlogCreds();
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
      const d = await velogGql(POST_BODY, { username: user, url_slug: p.url_slug });
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
