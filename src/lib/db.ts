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
  d.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS keyword_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at  TEXT NOT NULL,
      preset      TEXT NOT NULL,
      category_id TEXT,
      label       TEXT,
      payload     TEXT NOT NULL
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
  _db = d;
  return d;
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
