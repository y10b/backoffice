-- 방문 후기 초안.
--
-- posts 와 섞지 않는다. 방향이 반대이기 때문이다 — posts 는 키워드에서 출발해 글을
-- 만들고(main_keyword 가 not null 인 이유), 여기는 이미 다녀온 가게의 사진에서
-- 출발한다. 키워드는 나중에 따라붙는다. 한 테이블에 두면 어느 쪽에도 안 맞는
-- 컬럼이 절반씩 비게 되고, 목록 화면도 서로 다른 것을 보여줘야 한다.
--
-- 사진 원본은 저장하지 않는다. 분석 결과만 남긴다. 발행은 사용자가 휴대폰에서 직접
-- 하므로 서버가 원본을 들고 있을 이유가 없고, 무료 티어 용량도 아낀다.

create table if not exists visit_posts (
  id            bigint generated always as identity primary key,

  -- 사용자가 넣은 값 그대로. 카카오 조회가 실패해도 무엇을 찾으려 했는지는 남아야 한다
  place_query   text not null,
  -- "2024년 가을쯤" 처럼 대략이어도 된다. EXIF 를 쓰지 않으므로 사람이 적는다
  visited_on    text not null default '',

  -- 카카오 로컬에서 확인된 공개 정보. 못 찾으면 null 이고 warnings 에 사유가 남는다
  place         jsonb,
  -- 사진 분석 결과 (PhotoAnalysis)
  analysis      jsonb not null default '{}'::jsonb,
  -- 30초 인터뷰 답 (Interview)
  interview     jsonb not null default '{}'::jsonb,
  -- 이 글의 상황 한 줄. "이 블로그 첫 글", "여수 여행 2일차"
  situation     text not null default '',

  -- 생성 결과
  titles        jsonb not null default '[]'::jsonb,
  title         text not null default '',          -- 고른 제목
  body_markdown text not null default '',
  body_html     text not null default '',
  tags          jsonb not null default '[]'::jsonb,
  photo_order   jsonb not null default '[]'::jsonb,

  -- 사람이 확인해야 할 것. 폐업 의심·가격 근거 없음·근거 약한 문장이 모인다.
  -- 비어 있지 않으면 화면에서 경고로 띄운다
  warnings      jsonb not null default '[]'::jsonb,
  needs_check   jsonb not null default '[]'::jsonb,

  -- analyzed | drafted | ready | posted | dropped
  status        text not null default 'analyzed',
  posted_at     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 화면은 늘 "최근 것부터, 아직 안 올린 것 위주"로 본다
create index if not exists idx_visit_posts_recent
  on visit_posts (status, id desc);

/*
 * 같은 가게를 실수로 두 번 분석하는 것만 막는다.
 *
 * threads_posts 와 달리 자동 생성이 아니라 사람이 사진을 올려야 들어오므로 매일
 * 쌓일 일은 없다. 다만 아이폰에서 두 번 눌러 중복이 생기는 건 흔하다. 이미 올린
 * (posted) 것은 재방문해서 다시 쓸 수 있으므로 제외한다.
 */
create unique index if not exists idx_visit_posts_place_open
  on visit_posts (place_query, visited_on)
  where status in ('analyzed', 'drafted', 'ready');

alter table visit_posts enable row level security;
