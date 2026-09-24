-- 개발 로그 → velog 초안 → 발행.
--
-- 원래 별도 레포(y10b/devlog)가 노션 DB 세 개를 저장소로 썼다. 승인 화면이 노션에,
-- 나머지 화면이 백오피스에 있으면 검토가 두 곳으로 갈린다. 여기로 옮기면서 노션을 뗐다.
-- 흐름은 그대로다: 매일 커밋 수집 → 주 1회 초안 → 사람이 승인 → 다음 아침 발행 →
-- 밤에 velog 반응 역동기화.

-- 하루·레포 단위의 커밋 묶음. 글의 재료이지 글이 아니다.
create table if not exists dev_logs (
  id           bigint generated always as identity primary key,
  date         date not null,
  repo         text not null,                 -- owner/name
  private      boolean not null default false,
  commit_count integer not null default 0,
  messages     jsonb not null default '[]'::jsonb,
  topics       jsonb not null default '[]'::jsonb,
  -- 글이 될 만한 날인지 0~5. 높을수록 "왜 그렇게 했는지"가 드러난 날
  score        integer not null default 0,
  -- 초안에 이미 쓰였는지. 같은 커밋으로 두 번 초안이 나오지 않게
  consumed     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- 같은 날 같은 레포는 한 줄. 수집을 다시 돌려도 중복이 안 생긴다
create unique index if not exists idx_dev_logs_date_repo on dev_logs (date, repo);
create index if not exists idx_dev_logs_recent on dev_logs (date desc, score desc);

-- velog 글. 자동 초안과 velog 에서 역동기화한 발행 이력이 한 표에 있다.
create table if not exists velog_posts (
  id             bigint generated always as identity primary key,
  title          text not null default '',
  body_markdown  text not null default '',
  tags           jsonb not null default '[]'::jsonb,
  -- 어떤 커밋 묶음에서 나왔는지 한 줄. "y10b/backoffice · 09-20~09-24 커밋 12개"
  source         text not null default '',
  -- 비공개 레포에서 나온 초안. 공개해도 되는지 사람이 봐야 한다
  from_private   boolean not null default false,
  auto_generated boolean not null default false,
  -- draft(검토 대기) | approved(발행 승인) | published | dropped
  status         text not null default 'draft',
  url            text not null default '',
  velog_id       text not null default '',
  -- 마지막 발행 시도의 오류. 비어 있지 않으면 화면에 빨갛게 띄운다
  error          text not null default '',
  likes          integer not null default 0,
  comments       integer not null default 0,
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_velog_posts_recent on velog_posts (status, id desc);
-- 역동기화가 같은 글을 두 번 만들지 않게. 빈 url 은 여러 개일 수 있다
create unique index if not exists idx_velog_posts_url on velog_posts (url) where url <> '';

alter table dev_logs    enable row level security;
alter table velog_posts enable row level security;
