-- 백오피스 스키마.
--
-- 원래는 로컬 파일 SQLite(node:sqlite)였는데, Vercel 은 서버리스라 파일시스템이
-- 읽기 전용이고 인스턴스마다 초기화된다. 그래서 Postgres 로 옮긴다.
--
-- SQLite 시절 `PRAGMA table_info` 로 컬럼을 하나씩 덧붙이던 마이그레이션은
-- 여기서 처음부터 최종 형태로 정의한다.

create table if not exists settings (
  key   text primary key,
  value text not null
);

create table if not exists keyword_snapshots (
  id         bigint generated always as identity primary key,
  fetched_at timestamptz not null default now(),
  seeds      text not null default '',
  count      integer not null default 0,
  payload    jsonb not null
);

create index if not exists idx_snapshots_fetched on keyword_snapshots (id desc);

create table if not exists posts (
  id             bigint generated always as identity primary key,
  main_keyword   text not null,
  sub_keyword    text not null default '',
  title          text not null default '',
  body_html      text not null default '',
  body_markdown  text not null default '',
  tags           jsonb not null default '[]'::jsonb,
  meta_desc      text not null default '',
  -- SEO·그라운딩 결과. 저장 안 하면 초안을 다시 열었을 때 통째로 사라진다
  faq            jsonb not null default '[]'::jsonb,
  json_ld        text not null default '',
  sources        jsonb not null default '[]'::jsonb,
  visuals        jsonb not null default '[]'::jsonb,
  -- 자동 생성분과 손으로 다듬은 글의 성과를 나중에 갈라 보기 위한 표시
  auto_generated boolean not null default false,
  status         text not null default 'draft',
  posted_naver   boolean not null default false,
  posted_tistory boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_posts_updated on posts (updated_at desc);

-- 이 앱은 service_role 키로 서버에서만 접근한다. 브라우저에서 직접 붙는 경로가 없으므로
-- RLS 를 켜고 정책을 비워 두면, 혹시 anon 키가 새더라도 아무것도 읽히지 않는다.
alter table settings          enable row level security;
alter table keyword_snapshots enable row level security;
alter table posts             enable row level security;
