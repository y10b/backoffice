/**
 * 네이버 자동 발행 대기열.
 *
 * visit_posts 는 사진 원본을 저장하지 않는다(무료 티어 용량). 그런데 자동 발행은 휴대폰이 아니라
 * 클라우드 브라우저가 하므로 사진이 서버에 있어야 한다. 그래서 "올릴 준비" 를 누르는 순간의
 * 완성본 — 사진·대가성 이미지까지 data URL 로 박힌 네이버용 HTML — 을 Storage 에 한 파일로
 * 둔다. 발행이 끝나면 지운다. 테이블을 바꾸지 않으니 마이그레이션도 없다.
 */
import { supabase } from "./db";
import { DISCLOSURE_IMAGE_SLOT, SHOP_LINK_SLOT } from "./shopLinks";

const BUCKET = "naver-queue";
const path = (id: number) => `${id}.html`;

/** 사람이 채워야 할 자리 표시가 남았으면 사유를 돌려준다 */
export function unfilledReason(html: string): string | null {
  if (/\[사진\s*\d+\]/.test(html)) return "사진 자리가 비어 있습니다. 사진을 다시 올리고 분석한 화면에서 넣어 주세요.";
  if (html.includes(DISCLOSURE_IMAGE_SLOT)) return "대가성 문구 이미지가 없습니다. 이미지를 만든 뒤 넣어 주세요.";
  if (html.includes(SHOP_LINK_SLOT)) return "쇼핑 링크 자리가 비어 있습니다.";
  return null;
}

async function ensureBucket() {
  const s = supabase().storage;
  const { data } = await s.getBucket(BUCKET);
  if (data) return;
  const { error } = await s.createBucket(BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) throw new Error(`대기열 버킷 생성 실패: ${error.message}`);
}

export async function putQueued(id: number, html: string): Promise<void> {
  await ensureBucket();
  const { error } = await supabase()
    .storage.from(BUCKET)
    .upload(path(id), new Blob([html], { type: "text/html" }), { upsert: true, contentType: "text/html" });
  if (error) throw new Error(`대기열 저장 실패: ${error.message}`);
}

export async function getQueued(id: number): Promise<string | null> {
  const { data, error } = await supabase().storage.from(BUCKET).download(path(id));
  if (error || !data) return null;
  return data.text();
}

export async function removeQueued(id: number): Promise<void> {
  await supabase().storage.from(BUCKET).remove([path(id)]);
}

export async function listQueuedIds(): Promise<number[]> {
  await ensureBucket();
  const { data, error } = await supabase().storage.from(BUCKET).list("", { limit: 1000 });
  if (error) throw new Error(`대기열 조회 실패: ${error.message}`);
  return (data ?? [])
    .map((f) => Number(f.name.replace(/\.html$/, "")))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}
