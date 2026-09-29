-- 방문 후기 갈래를 맛집 밖으로 넓힌다: 맛집(restaurant) · 제품 후기(product) · 일상(daily).
--
-- 사진에서 출발해 인터뷰를 거쳐 글을 쓰는 흐름은 같고, 사진에서 읽을 것·물을 것·쓰는
-- 법만 다르다. 그래서 새 테이블을 만들지 않고 종류 칸 하나를 더한다. 기존 글은 전부 맛집이다.

alter table visit_posts
  add column if not exists kind text not null default 'restaurant';

alter table visit_posts drop constraint if exists visit_posts_kind_check;
alter table visit_posts
  add constraint visit_posts_kind_check check (kind in ('restaurant', 'product', 'daily'));
