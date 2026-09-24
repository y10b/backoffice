-- 영상 갈래(게임 쇼츠 · 유아 채널)를 걷어낸다.
--
-- 블로그·쓰레드·velog 는 글이고, 영상은 ffmpeg 워커와 별도 API 네 개(YouTube · Claude ·
-- Veo · Fish Audio)를 끌고 다녔다. 유지 비용에 비해 쓰지 않아 코드째 뺐고, 렌더 큐도
-- 같이 지운다. 결과 파일은 로컬 data/ 에만 있었으므로 DB 에서 잃는 건 작업 이력뿐이다.

drop function if exists claim_render_job(text);
drop table if exists render_jobs;

-- 영상 갈래에서만 쓰던 자격증명
delete from settings
 where key in ('youtube_api_key', 'anthropic_api_key', 'claude_model', 'veo_model',
               'fish_api_key', 'fish_model');

-- 렌더 결과를 담던 공개 버킷. 남겨두면 공개 URL 이 그대로 살아 있다
delete from storage.objects where bucket_id = 'shorts';
delete from storage.buckets where id = 'shorts';
