/**
 * supabase/migrations/*.sql 을 순서대로 적용한다. SQL 편집기에 붙여넣던 일을 대신한다.
 *
 * Supabase 관리 API(https://api.supabase.com) 를 쓴다 — 개인 액세스 토큰과 프로젝트 ref 만
 * 있으면 되고 DB 비밀번호·psql 이 필요 없다. 이 토큰은 계정 전체 권한이라 .env.local
 * (gitignore) 에만 두고 절대 커밋하지 않는다.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_...  SUPABASE_PROJECT_REF=abcdefghijklmnop \
 *   node scripts/migrate.mjs            # 전부
 *   node scripts/migrate.mjs 20260925   # 파일명이 이 접두사로 시작하는 것만
 *
 * .env.local 이 있으면 거기서 읽는다. 적용 이력 표는 두지 않는다 — 마이그레이션이 전부
 * `if not exists` / `if exists` 로 짜여 있어 두 번 돌려도 안전하다.
 */
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);

// .env.local 을 환경에 얹는다. 이미 있는 값은 덮지 않는다
try {
  const env = await fs.readFile(path.join(root, ".env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* 없으면 환경변수만 쓴다 */
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref =
  process.env.SUPABASE_PROJECT_REF ||
  (process.env.SUPABASE_URL ?? "").match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];

if (!token || !ref) {
  console.error(
    "SUPABASE_ACCESS_TOKEN(계정 → Access Tokens 에서 발급)과 SUPABASE_PROJECT_REF" +
      "(대시보드 주소의 /project/ 뒤 문자열, 또는 SUPABASE_URL 에서 추출)가 필요합니다.",
  );
  process.exit(1);
}

const prefix = process.argv[2] ?? "";
const dir = path.join(root, "supabase", "migrations");
const files = (await fs.readdir(dir))
  .filter((f) => f.endsWith(".sql") && f.startsWith(prefix))
  .sort();

if (!files.length) {
  console.error(`적용할 파일이 없습니다: ${dir}/${prefix}*.sql`);
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const query = await fs.readFile(path.join(dir, f), "utf8");
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (r.ok) {
    console.log(`✓ ${f}`);
  } else {
    failed += 1;
    // 관리 API 는 SQL 오류를 4xx 본문에 담아 준다. 어느 파일에서 무엇이 틀렸는지 그대로 보여준다
    console.error(`✗ ${f}\n  HTTP ${r.status} ${text.slice(0, 600)}`);
    // 뒤 파일이 앞 파일의 표에 기대므로 여기서 멈춘다
    break;
  }
}

process.exit(failed ? 1 : 0);
