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

export type DraftInput = {
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
  const { data, error } = await supabase()
    .from("posts")
    .select(
      "id, main_keyword, sub_keyword, title, meta_desc, tags, status, posted_naver, posted_tistory, created_at, updated_at",
    )
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
 * render_jobs — 쇼츠 렌더 작업 큐
 *
 * 웹(배포본)에서 등록하고 로컬 워커가 가져가 처리한다. ffmpeg 가 서버리스에서 못 도는
 * 문제를, 로컬이 밖으로 나가 폴링하는 방향으로 뒤집어 푼다.
 * ------------------------------------------------------------------ */

export type RenderJob = {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  options: Record<string, unknown>;
  result_url: string;
  result_name: string;
  size_bytes: number | null;
  error: string;
  attempts: number;
  created_at: string;
  updated_at: string;
};

export async function enqueueRenderJob(options: Record<string, unknown>): Promise<number> {
  const { data, error } = await supabase()
    .from("render_jobs")
    .insert({ options })
    .select("id")
    .single();
  if (error) throw new Error(`렌더 작업 등록 실패: ${error.message}`);
  return Number(data.id);
}

export async function listRenderJobs(limit = 30): Promise<RenderJob[]> {
  const { data, error } = await supabase()
    .from("render_jobs")
    .select("*")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`렌더 작업 조회 실패: ${error.message}`);
  return (data ?? []) as RenderJob[];
}

/**
 * 대기 중인 작업 하나를 원자적으로 가져온다.
 * 여러 워커가 떠 있어도 같은 작업을 두 번 처리하지 않도록 DB 함수에 맡긴다.
 */
export async function claimRenderJob(worker: string): Promise<RenderJob | null> {
  const { data, error } = await supabase().rpc("claim_render_job", { worker });
  if (error) throw new Error(`작업 가져오기 실패: ${error.message}`);
  const rows = (data ?? []) as RenderJob[];
  return rows[0] ?? null;
}

export async function finishRenderJob(
  id: number,
  patch: {
    status: "done" | "failed";
    resultUrl?: string;
    resultName?: string;
    sizeBytes?: number;
    error?: string;
  },
): Promise<void> {
  const { error } = await supabase()
    .from("render_jobs")
    .update({
      status: patch.status,
      result_url: patch.resultUrl ?? "",
      result_name: patch.resultName ?? "",
      size_bytes: patch.sizeBytes ?? null,
      error: patch.error ?? "",
      updated_at: nowIso(),
    })
    .eq("id", id);
  if (error) throw new Error(`작업 상태 갱신 실패: ${error.message}`);
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
