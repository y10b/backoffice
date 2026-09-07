-- 쓰레드 제휴 게시물 후보.
--
-- 블로그 글(posts)과 섞지 않는다. 둘은 수명도 손질 방식도 다르다 —
-- 블로그 글은 2,000자짜리 한 편을 오래 다듬어 발행하고, 쓰레드 글은 500자짜리를
-- 여러 개 만들어 그날 올릴 것만 고른다. 한 목록에 두면 긴 글이 짧은 글에 묻힌다.
--
-- 깃액션이 매일 채워 넣고(서버를 거치지 않는다), 화면에서는 읽고 고르고 손질한다.

create table if not exists threads_posts (
  id            bigint generated always as identity primary key,

  -- 어떤 검색 키워드에서 나왔는지. 같은 키워드를 다시 쓰지 않으려면 필요하다
  keyword       text not null,
  -- 뽑을 때 근거가 된 숫자. 나중에 "이게 왜 후보였나"를 되짚을 수 있어야 한다
  searches      integer,
  bid           integer,

  -- 무엇을 말할지 한 문장
  angle         text not null default '',
  -- 첫 줄 후보들. 쓰레드는 첫 줄이 전부라 여러 개를 두고 고른다
  hooks         jsonb not null default '[]'::jsonb,
  -- 본문. 사용 소감 자리는 비워둔 채로 들어온다
  draft         text not null default '',
  -- 올리기 전에 사람이 확인할 것
  checklist     jsonb not null default '[]'::jsonb,

  -- 제휴 링크. 쿠팡·토스 어느 쪽이든 사람이 넣는다
  affiliate_url text not null default '',

  -- draft | ready | posted | dropped
  status        text not null default 'draft',
  posted_at     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 화면은 늘 "최근 것부터, 아직 안 올린 것 위주"로 본다
create index if not exists idx_threads_posts_recent
  on threads_posts (status, id desc);

/*
 * 같은 키워드로 후보가 매일 쌓이는 걸 막는다.
 *
 * 검색량 상위 키워드는 며칠씩 그대로라, 막지 않으면 같은 '로봇청소기'가 일주일 내내
 * 다시 들어온다. 이미 올린(posted) 것은 시간이 지나 다시 다뤄도 되므로 제외한다.
 */
create unique index if not exists idx_threads_posts_keyword_open
  on threads_posts (keyword)
  where status in ('draft', 'ready');

alter table threads_posts enable row level security;
