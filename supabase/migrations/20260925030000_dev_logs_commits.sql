-- 커밋 제목 첫 줄만으로는 글이 얕다. 초안 단계에서 실제 diff 를 다시 읽으려면 SHA 가
-- 필요하다. 수집 때 SHA 와 커밋 본문 전체를 함께 남긴다.
alter table dev_logs add column if not exists commits jsonb not null default '[]'::jsonb;
