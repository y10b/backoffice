-- 티스토리 유입 데이터를 매일 쌓는다 (scripts/insights.mjs · src/lib/insights.ts).
--
-- GA4·서치콘솔 화면은 매번 API 로 조회하면 되지만, 그러면 "어떤 검색어가 노출은 되는데
-- 순위가 애매한가" 같은 질문을 기간을 넘어 모아 볼 수 없고, 글감 고르기(topicSignals)가
-- 매번 구글 API 를 몇 번씩 불러야 한다. 하루치씩 표로 떨어뜨려 두고 여기서 집계한다.
--
-- date 는 각 API 가 준 값 그대로다. GA4 는 속성 시간대(KST), 서치콘솔은 태평양 시간 기준
-- 하루라 두 표의 같은 날짜가 몇 시간 어긋난다 — 일 단위 추이를 보는 데는 문제없다.
-- 서치콘솔은 2~3일 늦게 확정되므로 수집은 매번 최근 7일을 지우고 다시 쓴다.
-- 그래서 모든 표에 (날짜 + 차원) 유니크가 있다.

-- 서치콘솔 searchAnalytics, 차원 [date, query, page].
-- page 는 서치콘솔이 주는 전체 URL(퍼센트 인코딩 그대로). 경로로 바꾸는 건 읽을 때 한다.
create table if not exists search_daily (
  id          bigint generated always as identity primary key,
  date        date not null,
  query       text not null,
  page        text not null,
  clicks      integer not null default 0,
  impressions integer not null default 0,
  ctr         numeric not null default 0,   -- 0~1
  position    numeric not null default 0,   -- 평균 순위 (1 이 맨 위)
  created_at  timestamptz not null default now(),
  unique (date, query, page)
);
create index if not exists idx_search_daily_date on search_daily (date desc);

-- GA4 runReport, 차원 [date, pagePath, pageTitle, sessionSource, sessionMedium].
-- 같은 글이 ?category= 꼬리나 제목 수정으로 여러 줄로 오므로 경로(쿼리 제거·디코드) 기준으로
-- 합쳐 넣는다. 제목은 조회수 많은 쪽 하나만 남긴다 — 그래서 유니크에 제목이 없다.
create table if not exists traffic_daily (
  id                 bigint generated always as identity primary key,
  date               date not null,
  page_path          text not null,
  page_title         text not null default '',
  source             text not null default '',   -- google, search.naver.com, (direct) …
  medium             text not null default '',   -- organic, referral, (none) …
  sessions           integer not null default 0,
  views              integer not null default 0,
  engaged_sessions   integer not null default 0,
  avg_engagement_sec numeric not null default 0, -- userEngagementDuration / sessions
  created_at         timestamptz not null default now(),
  unique (date, page_path, source, medium)
);
create index if not exists idx_traffic_daily_date on traffic_daily (date desc);

-- GA4 이벤트 수, 차원 [date, eventName, pagePath]. 계산기 사용(calculator_use)·스크롤처럼
-- "읽고 끝"이 아닌 행동이 어느 글에서 나는지 본다.
create table if not exists event_daily (
  id         bigint generated always as identity primary key,
  date       date not null,
  event_name text not null,
  page_path  text not null default '',
  count      integer not null default 0,
  created_at timestamptz not null default now(),
  unique (date, event_name, page_path)
);
create index if not exists idx_event_daily_date on event_daily (date desc);

-- 서버(service role)만 읽고 쓴다. anon 키로는 아무것도 보이지 않게 정책 없이 RLS 만 켠다
alter table search_daily enable row level security;
alter table traffic_daily enable row level security;
alter table event_daily enable row level security;
