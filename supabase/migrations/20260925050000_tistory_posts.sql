-- 실제로 올라간 티스토리 글 (src/lib/tistory.ts syncTistoryPosts).
--
-- 백오피스는 자기가 만든 초안(posts)만 알고, 사람이 손으로 올리거나 고친 글·카테고리는
-- 모른다. 그래서 (1) 올라간 글마다 카테고리·유입을 한 화면에서 볼 수 없었고, (2) 매일 초안이
-- 이미 있는 글과 같은 키워드로 나와 글끼리 순위를 나눠 먹었다(초안 "프리랜서 종합소득세" vs
-- 기존 "프리랜서 종합소득세 신고 방법 총정리"). 사이트맵과 글 페이지를 읽어 여기 쌓아 두고,
-- 초안 고를 때 제목으로 겹침을 본다.
--
-- 공개 글만 들어온다 — 비공개 글은 사이트맵에 없다. 사이트맵에서 사라진 글(비공개 전환·삭제)은
-- 지우지 않는다. last_seen 이 멈추는 것으로 알 수 있고, 그 사이 쌓인 유입 기록과 이어 볼 수 있다.
create table if not exists tistory_posts (
  id           bigint generated always as identity primary key,
  -- 사이트맵 <loc> 그대로(퍼센트 인코딩). 서치콘솔 page 와 같은 모양이라 그대로 맞춰 볼 수 있다
  url          text not null unique,
  slug         text not null default '',        -- /entry/ 뒤, 디코드한 것
  title        text not null default '',        -- og:title
  -- 블로그 안 카테고리(세금·신고 / 보험·연금 / 지원금·수당 / 기타 …). 재편 중이라 옛 이름도 올 수 있다
  category     text not null default '',
  -- article:section — 티스토리 홈 주제('생활정보'). 블로그 카테고리와 다른 것이라 따로 둔다
  home_topic   text not null default '',
  published_at timestamptz,                     -- article:published_time
  lastmod      timestamptz,                     -- 사이트맵 <lastmod> (수정 시각)
  last_seen    date not null default current_date, -- 마지막으로 사이트맵에서 본 날 (KST, 앱이 넣는다)
  created_at   timestamptz not null default now()
);
create index if not exists idx_tistory_posts_published on tistory_posts (published_at desc);

-- 서버(service role)만 읽고 쓴다
alter table tistory_posts enable row level security;

-- 초안이 어느 카테고리로 들어갈지 (classifyCategory 추정). 발행할 때 카테고리를 고르는 기준이자
-- 올라간 글 목록과 같은 이름으로 묶어 보려고 둔다
alter table posts add column if not exists category text not null default '';

-- 이 초안이 기존 글의 개정판이면 그 글 URL(tistory_posts.url 과 같은 인코딩). 빈 문자열이면 새 글.
-- 개정판을 새 글로 올리면 같은 키워드 글이 둘이 되어 순위를 나눠 먹는다 — 화면이 "기존 글 보강"으로
-- 표시하고, 사람은 기존 글을 열어 본문을 교체한다
alter table posts add column if not exists rewrite_of text not null default '';

-- 적용 후 한 번 실행할 것 (마이그레이션 자체에는 넣지 않는다 — id 는 이 DB 에만 맞는 값이다):
-- 2026-09-25 에 먼저 만들어진 초안 #86("프리랜서 종합소득세")은 기존 글의 보강이다.
--
-- update posts
--    set rewrite_of = 'https://testao.tistory.com/entry/%ED%94%84%EB%A6%AC%EB%9E%9C%EC%84%9C-%EC%A2%85%ED%95%A9%EC%86%8C%EB%93%9D%EC%84%B8-%EC%8B%A0%EA%B3%A0-%EB%B0%A9%EB%B2%95-%EC%B4%9D%EC%A0%95%EB%A6%AC-2026-%EC%B5%9C%EC%8B%A0%ED%8C%90',
--        category   = '세금·신고'
--  where id = 86;
