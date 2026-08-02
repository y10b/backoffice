-- 쇼츠 렌더 작업 큐.
--
-- ffmpeg 는 Vercel 서버리스에서 못 돈다(바이너리 크기·실행 시간). 그렇다고 영상 기능만
-- 로컬에 묶어두면 배포본에서 아무것도 못 한다.
--
-- 그래서 방향을 뒤집는다. 브라우저는 https 페이지에서 http://localhost 를 부를 수 없지만
-- (혼합 콘텐츠 차단), 로컬에서 밖으로 나가는 건 막히지 않는다.
--   웹(어디서나)  → 작업 등록
--   로컬 워커      → 폴링해서 가져가 렌더 → 결과 반영
-- 포트 개방도 공인 IP도 필요 없고, 워커가 꺼져 있으면 작업은 큐에 남아 있다가 처리된다.

create table if not exists render_jobs (
  id          bigint generated always as identity primary key,
  status      text not null default 'queued',   -- queued | running | done | failed
  -- 렌더 입력 전체를 그대로 담는다. 필드가 늘 때마다 컬럼을 추가하지 않아도 된다
  options     jsonb not null,
  -- 워커가 채운다
  result_url  text not null default '',
  result_name text not null default '',
  size_bytes  bigint,
  error       text not null default '',
  -- 같은 작업을 두 워커가 동시에 집지 않도록 소유권을 표시한다
  claimed_by  text not null default '',
  claimed_at  timestamptz,
  attempts    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 워커는 "가장 오래된 queued 한 건"만 계속 찾는다
create index if not exists idx_render_jobs_queue
  on render_jobs (status, id);

alter table render_jobs enable row level security;

/*
 * 작업 하나를 원자적으로 집어 온다.
 *
 * select 로 고른 뒤 update 하면 두 워커가 같은 행을 집는 창이 생긴다.
 * update ... where id = (select ... for update skip locked) 로 한 문장에서 끝낸다.
 */
create or replace function claim_render_job(worker text)
returns setof render_jobs
language sql
as $$
  update render_jobs
     set status = 'running',
         claimed_by = worker,
         claimed_at = now(),
         attempts = attempts + 1,
         updated_at = now()
   where id = (
     select id from render_jobs
      where status = 'queued'
      order by id
      limit 1
      for update skip locked
   )
  returning *;
$$;
