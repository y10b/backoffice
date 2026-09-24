-- 블로그 채널 분리(naver · tistory) + 키워드 풀.
--
-- 티스토리 유입이 0 이었다. 시드 12개가 서로 다른 주제였고, 월 검색 1,000 이상 ·
-- 수익 잠재력 순으로 뽑다 보니 레드오션 키워드만 나왔다. 그래서 2주 동안은 글을 쓰지
-- 않고 키워드만 매일 모아, 쌓인 것을 보고 주제를 정한다.

-- 글이 어느 블로그용인지. 네이버(맛집·여행)와 티스토리(n잡러 돈 관리)는 주제가 달라
-- 목록도 크론도 따로 돈다. 기존 글은 전부 티스토리 크론이 만든 것이라 기본값을 tistory 로 둔다.
alter table posts add column if not exists channel text not null default 'tistory';
create index if not exists idx_posts_channel on posts (channel, updated_at desc);

-- 매일 모은 키워드. 스냅샷(keyword_snapshots)은 조회 한 번의 통짜 JSON 이라 날짜를 넘어
-- 비교할 수 없다. 여기는 키워드 한 줄이 한 행이고, 다시 나오면 갱신해 "며칠째 보이는지"가 쌓인다.
create table if not exists keyword_pool (
  id            bigint generated always as identity primary key,
  channel       text not null,            -- naver | tistory
  seed          text not null,            -- 어느 시드에서 나왔나
  keyword       text not null,
  searches      integer,                  -- 월간 검색(PC+모바일)
  mobile_ratio  numeric,                  -- %
  bid           integer,                  -- 광고 단가(원)
  ad_absorption numeric,                  -- % — 낮을수록 정보성, 블로그로 갈 여지가 크다
  revenue_score numeric,
  competition   text not null default '', -- 광고 경쟁정도(높음/중간/낮음), 있으면
  -- 띄어쓰기 기준 단어 수. 긴 키워드 우선에 쓴다. 키워드도구는 띄어쓰기를 빼고 주므로
  -- 글자 수로 보정한 값이다 (src/lib/keywordPool.ts 의 wordCount)
  word_count    integer not null default 1,
  -- 날짜는 KST 기준으로 앱이 넣는다. 기본값은 직접 넣을 때를 위한 것
  first_seen    date not null default current_date,
  last_seen     date not null default current_date,
  -- 며칠에 걸쳐 보였나. 같은 날 다시 돌려도 늘지 않는다 — 꾸준히 나오는 키워드를 가리려고
  seen_count    integer not null default 1,
  created_at    timestamptz not null default now()
);

-- 채널마다 키워드 한 줄. 매일 수집이 upsert 로 이 줄을 갱신한다
create unique index if not exists idx_keyword_pool_channel_keyword on keyword_pool (channel, keyword);
-- 화면 기본 조회: 최근 N일에 보인 것, 검색량 순
create index if not exists idx_keyword_pool_recent on keyword_pool (channel, last_seen desc, searches desc);

alter table keyword_pool enable row level security;
