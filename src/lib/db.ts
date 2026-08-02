import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "backoffice.db");

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec("PRAGMA journal_mode = WAL;");

  // 크리에이터 어드바이저 시절 스냅샷은 컬럼 구성이 달라 그냥 버린다.
  // 조회 결과 캐시일 뿐이라 보존할 값이 없다.
  const legacy = d
    .prepare("PRAGMA table_info(keyword_snapshots)")
    .all() as { name: string }[];
  if (legacy.length && !legacy.some((c) => c.name === "seeds")) {
    d.exec("DROP TABLE keyword_snapshots;");
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS keyword_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at TEXT NOT NULL,
      seeds      TEXT NOT NULL DEFAULT '',
      count      INTEGER NOT NULL DEFAULT 0,
      payload    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      main_keyword  TEXT NOT NULL,
      sub_keyword   TEXT NOT NULL DEFAULT '',
      title         TEXT NOT NULL DEFAULT '',
      body_html     TEXT NOT NULL DEFAULT '',
      body_markdown TEXT NOT NULL DEFAULT '',
      tags          TEXT NOT NULL DEFAULT '[]',
      meta_desc     TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'draft',
      posted_naver  INTEGER NOT NULL DEFAULT 0,
      posted_tistory INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posts_updated ON posts(updated_at DESC);
  `);

  /*
   * SEO·그라운딩 결과를 담는 컬럼은 나중에 붙었다. 이미 글이 쌓인 DB 도 있으므로
   * 테이블을 다시 만들지 않고 없는 컬럼만 덧붙인다.
   */
  const postCols = new Set(
    (d.prepare("PRAGMA table_info(posts)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const added: [string, string][] = [
    ["faq", "TEXT NOT NULL DEFAULT '[]'"],
    ["json_ld", "TEXT NOT NULL DEFAULT ''"],
    ["sources", "TEXT NOT NULL DEFAULT '[]'"],
    ["visuals", "TEXT NOT NULL DEFAULT '[]'"],
    // 자동 생성분과 손으로 다듬은 글의 성과를 나중에 갈라 보기 위한 표시
    ["auto_generated", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, decl] of added) {
    if (!postCols.has(name)) d.exec(`ALTER TABLE posts ADD COLUMN ${name} ${decl};`);
  }

  _db = d;
  return d;
}

/**
 * 초안 저장. `/api/generate` 와 `/api/autowrite` 가 같은 INSERT 를 각자 들고 있으면
 * 컬럼이 늘 때 한쪽만 고쳐져 조용히 어긋난다. 저장 경로를 여기 하나로 모은다.
 */
export function insertDraft(input: {
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
}): number {
  const ts = nowIso();
  const { draft } = input;
  const res = db()
    .prepare(
      `INSERT INTO posts
         (main_keyword, sub_keyword, title, body_html, body_markdown, tags, meta_desc,
          faq, json_ld, sources, visuals, auto_generated, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(
      input.mainKeyword,
      input.subKeyword,
      draft.title,
      draft.bodyHtml,
      draft.bodyMarkdown,
      JSON.stringify(draft.tags ?? []),
      draft.metaDescription,
      JSON.stringify(draft.faq ?? []),
      draft.jsonLd ?? "",
      JSON.stringify(draft.sources ?? []),
      JSON.stringify(draft.visuals ?? []),
      input.auto ? 1 : 0,
      ts,
      ts,
    );
  return Number(res.lastInsertRowid);
}

export function getSetting(key: string): string | null {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function nowIso(): string {
  return new Date().toISOString();
}
