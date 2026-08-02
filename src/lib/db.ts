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
export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
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
