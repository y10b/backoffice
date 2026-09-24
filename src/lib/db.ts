import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * 저장소. 원래는 로컬 파일 SQLite(`node:sqlite`)였는데 Supabase Postgres 로 옮겼다.
 *
 * Vercel 은 서버리스라 파일시스템이 읽기 전용이고 인스턴스마다 초기화된다. SQLite 파일에
 * 쓰기가 안 되고, 써지더라도 다음 요청은 다른 인스턴스로 가서 사라진다.
 *
 * 직접 Postgres 연결 대신 PostgREST(supabase-js)를 쓴다. 서버리스에서 커넥션 풀이
 * 금세 고갈되는 문제를 HTTP 가 통째로 피해 간다. 우리 질의는 전부 단순 CRUD 라
 * 쿼리 빌더로 충분하다.
 *
 * SQLite 는 동기였지만 여기는 전부 비동기다. 그래서 이 모듈을 쓰는 쪽도 async 가 된다.
 */

let _client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다. .env.local 또는 배포 환경변수를 확인하세요.",
    );
  }

  _client = createClient(url, key, {
    // 서버 전용이라 세션을 붙들 이유가 없다. 서버리스에서 불필요한 상태는 버그의 근원이다
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * settings — API 키·토큰 보관
 * ------------------------------------------------------------------ */

export async function getSetting(key: string): Promise<string | null> {
  const { data, error } = await supabase()
    .from("settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`설정 조회 실패(${key}): ${error.message}`);
  return data?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const { error } = await supabase()
    .from("settings")
    .upsert({ key, value }, { onConflict: "key" });
  if (error) throw new Error(`설정 저장 실패(${key}): ${error.message}`);
}

/**
 * 여러 키를 한 번에 읽는다.
 *
 * 자격증명은 보통 2~3개를 같이 본다(`searchAdCreds` 는 3개). 하나씩 await 하면
 * 왕복이 그만큼 늘어 화면이 눈에 띄게 느려진다.
 */
/** Supabase 자격증명이 환경에 있는가. 없으면 DB 를 건드리는 경로를 건너뛴다 */
export function hasSupabase(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  /*
   * DB 가 없는 환경(깃액션 러너)에서는 빈 값을 준다.
   *
   * 이 함수를 쓰는 곳은 전부 `설정값 || process.env.X` 꼴이라, 빈 값을 주면
   * 환경변수로 자연스럽게 떨어진다. 여기서 던지면 러너에서 아무것도 못 돌린다 —
   * 키를 시크릿으로 넣어줬는데도 DB 가 없다는 이유로 죽는 건 이상하다.
   */
  if (!hasSupabase()) return {};
  const { data, error } = await supabase()
    .from("settings")
    .select("key, value")
    .in("key", keys);
  if (error) throw new Error(`설정 조회 실패: ${error.message}`);
  const out: Record<string, string> = {};
  for (const row of data ?? []) out[row.key as string] = row.value as string;
  return out;
}

/* ------------------------------------------------------------------ *
 * posts — 초안
 * ------------------------------------------------------------------ */

/**
 * posts.channel · keyword_pool.channel 컬럼의 값. 키워드 기반 글은 티스토리뿐이라 늘 'tistory' 다
 * (네이버는 방문 후기 레인 visit_posts 가 맡는다). 컬럼은 예전 행 호환으로 남겨 둔다.
 */
export type Channel = "tistory";
const CHANNEL: Channel = "tistory";

export type DraftInput = {
  /** 생략하면 'tistory'. 컬럼이 남아 있어 값만 받는다 */
  channel?: Channel;
  mainKeyword: string;
  subKeyword: string;
  draft: {
    title: string;
    bodyHtml: string;
    bodyMarkdown: string;
    tags: string[];
    metaDescription: string;
    faq?: { question: string; answer: string }[];
    jsonLd?: string;
    sources?: { title: string; uri: string }[];
    visuals?: { type: string; title: string; html: string }[];
  };
  auto?: boolean;
};

/**
 * 초안 저장. `/api/generate` 와 `/api/autowrite` 가 같은 INSERT 를 각자 들고 있으면
 * 컬럼이 늘 때 한쪽만 고쳐져 조용히 어긋난다. 저장 경로를 여기 하나로 모은다.
 */
export async function insertDraft(input: DraftInput): Promise<number> {
  const { draft } = input;
  const { data, error } = await supabase()
    .from("posts")
    .insert({
      channel: input.channel ?? CHANNEL,
      main_keyword: input.mainKeyword,
      sub_keyword: input.subKeyword,
      title: draft.title,
      body_html: draft.bodyHtml,
      body_markdown: draft.bodyMarkdown,
      tags: draft.tags ?? [],
      meta_desc: draft.metaDescription,
      faq: draft.faq ?? [],
      json_ld: draft.jsonLd ?? "",
      sources: draft.sources ?? [],
      visuals: draft.visuals ?? [],
      auto_generated: Boolean(input.auto),
      status: "draft",
    })
    .select("id")
    .single();
  if (error) throw new Error(`초안 저장 실패: ${error.message}`);
  return Number(data.id);
}

/** 글 목록. 본문은 빼서 목록 응답이 무거워지지 않게 한다 */
export async function listPosts(limit = 200) {
  const q = supabase()
    .from("posts")
    .select(
      "id, channel, main_keyword, sub_keyword, title, meta_desc, tags, status, posted_naver, posted_tistory, created_at, updated_at",
    );
  const { data, error } = await q
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`글 목록 조회 실패: ${error.message}`);
  return data ?? [];
}

export async function getPost(id: number) {
  const { data, error } = await supabase()
    .from("posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`글 조회 실패: ${error.message}`);
  return data;
}

export async function updatePost(id: number, patch: Record<string, unknown>) {
  const { data, error } = await supabase()
    .from("posts")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`글 수정 실패: ${error.message}`);
  return data;
}

export async function deletePost(id: number): Promise<void> {
  const { error } = await supabase().from("posts").delete().eq("id", id);
  if (error) throw new Error(`글 삭제 실패: ${error.message}`);
}

/* ------------------------------------------------------------------ *
 * keyword_snapshots — 조회 결과 캐시
 * ------------------------------------------------------------------ */

export async function insertSnapshot(
  seeds: string,
  count: number,
  payload: unknown,
): Promise<void> {
  const { error } = await supabase()
    .from("keyword_snapshots")
    .insert({ seeds, count, payload });
  // 스냅샷은 캐시라 실패해도 조회 결과는 살려야 한다. 던지지 않고 흘린다
  if (error) console.warn("스냅샷 저장 실패:", error.message);
}

export async function listSnapshots(limit = 30) {
  const { data, error } = await supabase()
    .from("keyword_snapshots")
    .select("id, fetched_at, seeds, count")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`스냅샷 목록 조회 실패: ${error.message}`);
  return data ?? [];
}

export async function latestSnapshot() {
  const { data, error } = await supabase()
    .from("keyword_snapshots")
    .select("seeds, fetched_at, payload")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`최근 스냅샷 조회 실패: ${error.message}`);
  return data;
}

/* ------------------------------------------------------------------ *
 * keyword_pool — 티스토리 시드로 매일 모으는 키워드 (channel 은 늘 'tistory')
 *
 * 스냅샷은 조회 한 번의 통짜 JSON 이라 날짜를 넘어 비교할 수 없다. 여기는 키워드 한 줄이
 * 한 행이고, 다시 나오면 수치와 last_seen 만 갱신해 "며칠째 보이는지"가 쌓인다.
 * 날짜는 전부 KST 다 — 수집이 06:00 KST(=전날 21:00 UTC)에 돌아 UTC 로 찍으면 하루 밀린다.
 * ------------------------------------------------------------------ */

export type PoolRow = {
  id: number;
  channel: Channel;
  seed: string;
  keyword: string;
  searches: number | null;
  mobile_ratio: number | null;
  bid: number | null;
  ad_absorption: number | null;
  revenue_score: number | null;
  competition: string;
  word_count: number;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  created_at: string;
};

export type PoolInput = Pick<
  PoolRow,
  | "channel"
  | "seed"
  | "keyword"
  | "searches"
  | "mobile_ratio"
  | "bid"
  | "ad_absorption"
  | "revenue_score"
  | "competition"
  | "word_count"
>;

export type PoolSort = "searches" | "absorption" | "bid" | "seen" | "long";

/** KST 기준 YYYY-MM-DD. offsetDays 만큼 앞뒤로 민다 */
export function kstDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

/**
 * 있으면 갱신, 없으면 삽입.
 *
 * seen_count 를 +1 하려면 기존 값을 알아야 해서 먼저 한 번 읽는다. 그 뒤 한 번의 upsert 로
 * 전부 쓴다 — 줄마다 update 를 보내면 수백 번 왕복한다. 기존 줄은 first_seen · seed 를
 * 그대로 실어 보내 덮어써도 바뀌지 않게 한다.
 *
 * 같은 날 다시 돌리면 seen_count 는 늘지 않는다. "며칠에 걸쳐 보였나"를 세려는 값이다.
 * 같은 키워드가 입력에 두 번 있으면 처음 것만 쓴다 (한 upsert 안에 같은 키가 두 번이면
 * Postgres 가 거부한다).
 */
export async function upsertKeywordPool(
  rows: PoolInput[],
): Promise<{ inserted: number; updated: number }> {
  if (!rows.length) return { inserted: 0, updated: 0 };
  const today = kstDate();

  const unique = new Map<string, PoolInput>();
  for (const r of rows) {
    const k = `${r.channel}\u0000${r.keyword}`;
    if (!unique.has(k)) unique.set(k, r);
  }
  const list = [...unique.values()];

  // 기존 줄. in() 목록이 URL 에 실리므로 잘라서 읽는다
  const existing = new Map<string, { seed: string; first_seen: string; last_seen: string; seen_count: number }>();
  const byChannel = new Map<Channel, string[]>();
  for (const r of list) byChannel.set(r.channel, [...(byChannel.get(r.channel) ?? []), r.keyword]);
  for (const [channel, keywords] of byChannel) {
    for (let i = 0; i < keywords.length; i += 100) {
      const { data, error } = await supabase()
        .from("keyword_pool")
        .select("keyword, seed, first_seen, last_seen, seen_count")
        .eq("channel", channel)
        .in("keyword", keywords.slice(i, i + 100));
      if (error) throw new Error(`키워드 풀 조회 실패: ${error.message}`);
      for (const e of data ?? []) {
        existing.set(`${channel}\u0000${e.keyword}`, {
          seed: String(e.seed),
          first_seen: String(e.first_seen),
          last_seen: String(e.last_seen),
          seen_count: Number(e.seen_count ?? 0),
        });
      }
    }
  }

  let inserted = 0;
  let updated = 0;
  const payload = list.map((r) => {
    const e = existing.get(`${r.channel}\u0000${r.keyword}`);
    if (e) updated += 1;
    else inserted += 1;
    return {
      ...r,
      seed: e?.seed ?? r.seed,
      first_seen: e?.first_seen ?? today,
      last_seen: today,
      seen_count: e ? (e.last_seen < today ? e.seen_count + 1 : e.seen_count) : 1,
    };
  });

  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await supabase()
      .from("keyword_pool")
      .upsert(payload.slice(i, i + 500), { onConflict: "channel,keyword" });
    if (error) throw new Error(`키워드 풀 저장 실패: ${error.message}`);
  }
  return { inserted, updated };
}

/** 최근 days 일(last_seen, KST) 안에 보인 키워드 */
export async function listKeywordPool(
  o: { days?: number; limit?: number; sort?: PoolSort } = {},
): Promise<PoolRow[]> {
  const days = Math.max(1, o.days ?? 14);
  const limit = Math.min(Math.max(1, o.limit ?? 300), 2000);
  const sort = o.sort ?? "searches";

  let q = supabase()
    .from("keyword_pool")
    .select("*")
    .eq("channel", CHANNEL)
    .gte("last_seen", kstDate(-(days - 1)));

  const desc = { ascending: false, nullsFirst: false } as const;
  switch (sort) {
    case "absorption":
      // 흡수율 낮은 순 = 광고로 덜 빠지는 정보성 키워드
      q = q.order("ad_absorption", { ascending: true, nullsFirst: false }).order("searches", desc);
      break;
    case "bid":
      q = q.order("bid", desc).order("searches", desc);
      break;
    case "seen":
      q = q.order("seen_count", desc).order("searches", desc);
      break;
    case "long":
      q = q.order("word_count", desc).order("searches", desc);
      break;
    default:
      q = q.order("searches", desc);
  }

  const { data, error } = await q.limit(limit);
  if (error) throw new Error(`키워드 풀 조회 실패: ${error.message}`);
  return (data ?? []) as PoolRow[];
}

export async function countKeywordPool(days = 14): Promise<number> {
  const { count, error } = await supabase()
    .from("keyword_pool")
    .select("id", { count: "exact", head: true })
    .eq("channel", CHANNEL)
    .gte("last_seen", kstDate(-(Math.max(1, days) - 1)));
  if (error) throw new Error(`키워드 풀 개수 조회 실패: ${error.message}`);
  return count ?? 0;
}

/* ------------------------------------------------------------------ *
 * threads_posts — 쓰레드 제휴 게시물 후보
 *
 * 블로그 글과 섞지 않는다. 2,000자짜리 한 편을 오래 다듬는 일과 500자짜리를 여러 개
 * 만들어 그날 올릴 것만 고르는 일은 손질 방식이 다르다.
 * ------------------------------------------------------------------ */

export type ThreadsPost = {
  id: number;
  keyword: string;
  searches: number | null;
  bid: number | null;
  angle: string;
  hooks: string[];
  draft: string;
  checklist: string[];
  affiliate_url: string;
  status: string;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ThreadsPostInput = {
  keyword: string;
  searches?: number | null;
  bid?: number | null;
  angle?: string;
  hooks?: string[];
  draft?: string;
  checklist?: string[];
};

/**
 * 후보를 넣는다. 같은 키워드가 이미 열려 있으면(draft·ready) 건너뛴다.
 *
 * 검색량 상위 키워드는 며칠씩 그대로라, 막지 않으면 같은 '로봇청소기'가 일주일 내내
 * 다시 들어온다. 유니크 인덱스가 막아주므로 충돌은 오류가 아니라 정상 흐름이다.
 */
export async function insertThreadsPosts(
  items: ThreadsPostInput[],
): Promise<{ inserted: number; skipped: number }> {
  if (!items.length) return { inserted: 0, skipped: 0 };

  let inserted = 0;
  let skipped = 0;
  for (const it of items) {
    const { error } = await supabase()
      .from("threads_posts")
      .insert({
        keyword: it.keyword,
        searches: it.searches ?? null,
        bid: it.bid ?? null,
        angle: it.angle ?? "",
        hooks: it.hooks ?? [],
        draft: it.draft ?? "",
        checklist: it.checklist ?? [],
      });
    if (!error) {
      inserted += 1;
      continue;
    }
    // 23505 = unique_violation. 이미 열려 있는 키워드라 건너뛴 것이다
    if ((error as { code?: string }).code === "23505") {
      skipped += 1;
      continue;
    }
    throw new Error(`쓰레드 후보 저장 실패: ${error.message}`);
  }
  return { inserted, skipped };
}

export async function listThreadsPosts(limit = 100): Promise<ThreadsPost[]> {
  const { data, error } = await supabase()
    .from("threads_posts")
    .select("*")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`쓰레드 후보 조회 실패: ${error.message}`);
  return (data ?? []) as ThreadsPost[];
}

export async function updateThreadsPost(
  id: number,
  patch: Record<string, unknown>,
): Promise<ThreadsPost | null> {
  const next: Record<string, unknown> = { ...patch, updated_at: nowIso() };
  // 올림 표시를 하는 순간을 기록해 둔다. 나중에 성과를 되짚을 때 기준이 된다
  if (patch.status === "posted" && !("posted_at" in patch)) next.posted_at = nowIso();

  const { data, error } = await supabase()
    .from("threads_posts")
    .update(next)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`쓰레드 후보 수정 실패: ${error.message}`);
  return (data as ThreadsPost) ?? null;
}

export async function deleteThreadsPost(id: number): Promise<void> {
  const { error } = await supabase().from("threads_posts").delete().eq("id", id);
  if (error) throw new Error(`쓰레드 후보 삭제 실패: ${error.message}`);
}

/* ------------------------------------------------------------------ *
 * visit_posts — 방문 후기 초안
 *
 * posts 와 섞지 않는다. posts 는 키워드에서 출발하고 여기는 사진에서 출발한다.
 * 한 테이블에 두면 어느 쪽에도 안 맞는 컬럼이 절반씩 빈다.
 * ------------------------------------------------------------------ */

export type VisitPost = {
  id: number;
  place_query: string;
  visited_on: string;
  place: Record<string, unknown> | null;
  analysis: Record<string, unknown>;
  interview: Record<string, unknown>;
  situation: string;
  titles: string[];
  title: string;
  body_markdown: string;
  body_html: string;
  tags: string[];
  photo_order: { index: number; note: string }[];
  warnings: string[];
  needs_check: string[];
  status: string;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function insertVisitPost(row: Record<string, unknown>): Promise<number> {
  const { data, error } = await supabase()
    .from("visit_posts")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    // 23505 = unique_violation. 같은 가게·같은 날짜가 이미 열려 있다
    if ((error as { code?: string }).code === "23505") {
      throw new Error(
        "같은 가게·같은 방문일의 초안이 이미 있습니다. 목록에서 기존 것을 이어서 쓰세요.",
      );
    }
    throw new Error(`방문 후기 저장 실패: ${error.message}`);
  }
  return Number(data.id);
}

/** 목록. 본문은 빼서 응답이 무거워지지 않게 한다 */
export async function listVisitPosts(limit = 100) {
  const { data, error } = await supabase()
    .from("visit_posts")
    .select(
      "id, place_query, visited_on, place, situation, titles, title, tags, warnings, needs_check, status, posted_at, created_at, updated_at",
    )
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`방문 후기 목록 조회 실패: ${error.message}`);
  return data ?? [];
}

export async function getVisitPost(id: number): Promise<VisitPost | null> {
  const { data, error } = await supabase()
    .from("visit_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`방문 후기 조회 실패: ${error.message}`);
  return (data as VisitPost) ?? null;
}

export async function updateVisitPost(
  id: number,
  patch: Record<string, unknown>,
): Promise<VisitPost | null> {
  const next: Record<string, unknown> = { ...patch, updated_at: nowIso() };
  // 올림 표시를 하는 순간을 기록해 둔다. 나중에 성과를 되짚을 때 기준이 된다
  if (patch.status === "posted" && !("posted_at" in patch)) next.posted_at = nowIso();

  const { data, error } = await supabase()
    .from("visit_posts")
    .update(next)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`방문 후기 수정 실패: ${error.message}`);
  return (data as VisitPost) ?? null;
}

export async function deleteVisitPost(id: number): Promise<void> {
  const { error } = await supabase().from("visit_posts").delete().eq("id", id);
  if (error) throw new Error(`방문 후기 삭제 실패: ${error.message}`);
}

/* ------------------------------------------------------------------ *
 * dev_logs · velog_posts — 개발 로그 갈래
 *
 * 원래 별도 레포가 노션을 저장소로 썼다. 승인 화면만 다른 곳에 있으면 검토가 갈리므로
 * 여기로 옮겼다. dev_logs 는 재료(하루·레포 단위 커밋 묶음), velog_posts 는 글이다.
 * ------------------------------------------------------------------ */

export type DevLog = {
  id: number;
  date: string;
  repo: string;
  private: boolean;
  commit_count: number;
  messages: string[];
  /** SHA 와 커밋 본문 전체. 초안이 실제 diff 를 다시 읽는 열쇠다 */
  commits: { sha: string; message: string }[];
  topics: string[];
  score: number;
  consumed: boolean;
  created_at: string;
};

export type DevLogInput = Omit<DevLog, "id" | "created_at" | "consumed">;

/** 같은 날·같은 레포가 이미 있으면 건너뛴다. 수집을 다시 돌려도 중복이 안 생긴다 */
export async function insertDevLogs(
  rows: DevLogInput[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const { error } = await supabase().from("dev_logs").insert(r);
    if (!error) {
      inserted += 1;
      continue;
    }
    if ((error as { code?: string }).code === "23505") {
      skipped += 1;
      continue;
    }
    throw new Error(`개발 로그 저장 실패: ${error.message}`);
  }
  return { inserted, skipped };
}

/**
 * 있으면 갱신, 없으면 삽입. 아직 초안에 쓰이지 않은(consumed=false) 줄만 갱신한다 —
 * 이미 글이 된 커밋 묶음을 바꾸면 글과 재료가 어긋난다.
 */
export async function upsertDevLogs(
  rows: DevLogInput[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const ins = await supabase().from("dev_logs").insert(r);
    if (!ins.error) {
      inserted += 1;
      continue;
    }
    if ((ins.error as { code?: string }).code !== "23505") {
      throw new Error(`개발 로그 저장 실패: ${ins.error.message}`);
    }
    const { data, error } = await supabase()
      .from("dev_logs")
      .update({
        private: r.private,
        commit_count: r.commit_count,
        messages: r.messages,
        commits: r.commits,
        topics: r.topics,
        score: r.score,
      })
      .eq("date", r.date)
      .eq("repo", r.repo)
      .eq("consumed", false)
      .select("id");
    if (error) throw new Error(`개발 로그 갱신 실패: ${error.message}`);
    if (data?.length) updated += 1;
    else skipped += 1;
  }
  return { inserted, updated, skipped };
}

export async function listDevLogs(limit = 60): Promise<DevLog[]> {
  const { data, error } = await supabase()
    .from("dev_logs")
    .select("*")
    .order("date", { ascending: false })
    .order("score", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`개발 로그 조회 실패: ${error.message}`);
  return (data ?? []) as DevLog[];
}

/** 아직 초안에 쓰이지 않은, 기준일 이후의 로그 */
export async function listUnconsumedDevLogs(fromDate: string): Promise<DevLog[]> {
  const { data, error } = await supabase()
    .from("dev_logs")
    .select("*")
    .gte("date", fromDate)
    .eq("consumed", false)
    .order("score", { ascending: false });
  if (error) throw new Error(`개발 로그 조회 실패: ${error.message}`);
  return (data ?? []) as DevLog[];
}

export async function markDevLogsConsumed(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase().from("dev_logs").update({ consumed: true }).in("id", ids);
  if (error) throw new Error(`개발 로그 갱신 실패: ${error.message}`);
}

export type VelogPost = {
  id: number;
  title: string;
  body_markdown: string;
  tags: string[];
  source: string;
  from_private: boolean;
  auto_generated: boolean;
  status: string;
  url: string;
  velog_id: string;
  error: string;
  likes: number;
  comments: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function insertVelogPost(row: Partial<VelogPost>): Promise<number> {
  const { data, error } = await supabase()
    .from("velog_posts")
    .insert(row)
    .select("id")
    .single();
  if (error) throw new Error(`velog 글 저장 실패: ${error.message}`);
  return Number(data.id);
}

/** 목록. 본문은 빼서 응답이 무거워지지 않게 한다 */
export async function listVelogPosts(limit = 100) {
  const { data, error } = await supabase()
    .from("velog_posts")
    .select(
      "id, title, tags, source, from_private, auto_generated, status, url, error, likes, comments, published_at, created_at, updated_at",
    )
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`velog 글 목록 조회 실패: ${error.message}`);
  return (data ?? []) as Omit<VelogPost, "body_markdown" | "velog_id">[];
}

export async function listVelogPostsByStatus(status: string): Promise<VelogPost[]> {
  const { data, error } = await supabase()
    .from("velog_posts")
    .select("*")
    .eq("status", status)
    .order("id", { ascending: true });
  if (error) throw new Error(`velog 글 조회 실패: ${error.message}`);
  return (data ?? []) as VelogPost[];
}

export async function getVelogPost(id: number): Promise<VelogPost | null> {
  const { data, error } = await supabase()
    .from("velog_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`velog 글 조회 실패: ${error.message}`);
  return (data as VelogPost) ?? null;
}

/** 제목 매칭용 정규화. 공백·문장부호·대소문자 차이를 무시한다 (원본 sync-velog.ts 의 norm()) */
const normTitle = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * 역동기화의 매칭 키. url 이 먼저고, 없으면 제목으로 잇는다.
 * 제목은 정확히 같아야만 매칭하면 공백 하나 차이로도 중복 행이 생기므로 정규화해서 비교한다.
 */
export async function findVelogPost(url: string, title: string): Promise<VelogPost | null> {
  const byUrl = await supabase()
    .from("velog_posts")
    .select("*")
    .eq("url", url)
    .maybeSingle();
  if (byUrl.error) throw new Error(`velog 글 조회 실패: ${byUrl.error.message}`);
  if (byUrl.data) return byUrl.data as VelogPost;

  const target = normTitle(title);
  if (!target) return null;
  /*
   * 제목으로는 아직 안 나간 글(draft · approved · publishing)만 잇는다. 보류한 글이
   * 되살아나면 안 된다. 같은 제목이 둘 이상이면 어느 쪽인지 모르므로 잇지 않는다 —
   * 그러면 새 행이 생기고 사람이 정리한다.
   */
  const { data, error } = await supabase()
    .from("velog_posts")
    .select("*")
    .eq("url", "")
    .in("status", ["draft", "approved", "publishing"]);
  if (error) throw new Error(`velog 글 조회 실패: ${error.message}`);
  const hits = ((data ?? []) as VelogPost[]).filter((r) => normTitle(r.title) === target);
  return hits.length === 1 ? hits[0] : null;
}

/** approved → publishing 조건부 선점. 다른 실행이 먼저 집었으면 null */
export async function claimVelogPost(id: number): Promise<VelogPost | null> {
  const { data, error } = await supabase()
    .from("velog_posts")
    .update({ status: "publishing", updated_at: nowIso() })
    .eq("id", id)
    .eq("status", "approved")
    .select()
    .maybeSingle();
  if (error) throw new Error(`velog 글 선점 실패: ${error.message}`);
  return (data as VelogPost) ?? null;
}

export async function updateVelogPost(
  id: number,
  patch: Record<string, unknown>,
): Promise<VelogPost | null> {
  const { data, error } = await supabase()
    .from("velog_posts")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`velog 글 수정 실패: ${error.message}`);
  return (data as VelogPost) ?? null;
}

export async function deleteVelogPost(id: number): Promise<void> {
  const { error } = await supabase().from("velog_posts").delete().eq("id", id);
  if (error) throw new Error(`velog 글 삭제 실패: ${error.message}`);
}
