import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 글에 넣을 이미지 보관소.
 *
 * 로컬 파일로 둔다. Vercel 은 파일시스템이 읽기 전용이라 배포본에서는 업로드가 안 되고,
 * 그 사실을 오류 문구로 분명히 알린다. 이미지 편집·삽입은 로컬에서 하고, 실제 발행 때는
 * 티스토리 에디터가 자기 서버로 다시 올린다.
 *
 * data/ 는 .gitignore 대상이라 이미지가 저장소에 딸려 올라가지 않는다.
 */
const IMAGE_DIR = path.join(process.cwd(), "data", "images");

/** 확장자 화이트리스트. svg 는 스크립트를 품을 수 있어 뺀다 */
const ALLOWED = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
]);

export const MAX_BYTES = 10 * 1024 * 1024;

export function contentTypeOf(name: string): string | null {
  return ALLOWED.get(path.extname(name).toLowerCase()) ?? null;
}

/**
 * 저장할 이름을 만든다.
 *
 * 사용자가 준 이름을 그대로 쓰면 `../../.env.local` 같은 경로 탈출이 가능하다.
 * 확장자만 원본에서 가져오고 본체는 난수로 새로 짓는다. 원본 이름은 화면 표시용으로
 * 앞부분만 남긴다.
 */
export function safeFileName(original: string): string | null {
  const ext = path.extname(original).toLowerCase();
  if (!ALLOWED.has(ext)) return null;

  const stem = path
    .basename(original, path.extname(original))
    .normalize("NFC")
    .replace(/[^0-9A-Za-z가-힣._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);

  const rand = crypto.randomBytes(4).toString("hex");
  return `${Date.now()}-${rand}${stem ? `-${stem}` : ""}${ext}`;
}

/** 요청으로 들어온 이름이 보관소 안의 실제 파일을 가리키는지 확인한다 */
export function resolveStored(name: string): string | null {
  // 경로 구분자가 섞여 있으면 애초에 파일명이 아니다
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (!ALLOWED.has(path.extname(name).toLowerCase())) return null;

  const full = path.resolve(IMAGE_DIR, name);
  // resolve 후에도 보관소 밖을 가리키면 거부한다 (심볼릭 링크·상위 경로 방어)
  if (!full.startsWith(path.resolve(IMAGE_DIR) + path.sep)) return null;
  return full;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
}

/** 읽기 전용 파일시스템(Vercel)에서 나는 오류를 알아볼 수 있는 문구로 바꾼다 */
function writeError(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
    return new Error(
      "이 환경에서는 파일을 저장할 수 없습니다. 배포본(Vercel)은 파일시스템이 읽기 전용이라 이미지 업로드는 로컬에서만 됩니다.",
    );
  }
  return new Error(`이미지 저장 실패: ${(e as Error).message}`);
}

export async function saveImage(
  original: string,
  bytes: Uint8Array,
): Promise<{ name: string; size: number }> {
  const name = safeFileName(original);
  if (!name) {
    throw new Error(
      `지원하지 않는 형식입니다. ${[...ALLOWED.keys()].join(", ")} 만 올릴 수 있습니다.`,
    );
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (${Math.round(MAX_BYTES / 1024 / 1024)}MB 이하).`);
  }
  try {
    await ensureDir();
    await fs.writeFile(path.join(IMAGE_DIR, name), bytes);
  } catch (e) {
    throw writeError(e);
  }
  return { name, size: bytes.byteLength };
}

export type StoredImage = {
  name: string;
  size: number;
  uploadedAt: string;
  /** 본문에 넣을 주소. 마크다운 `![설명](url)` 로 쓴다 */
  url: string;
};

export async function listImages(): Promise<StoredImage[]> {
  try {
    await ensureDir();
    const names = await fs.readdir(IMAGE_DIR);
    const out: StoredImage[] = [];
    for (const name of names) {
      if (!contentTypeOf(name)) continue;
      const stat = await fs.stat(path.join(IMAGE_DIR, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      out.push({
        name,
        size: stat.size,
        uploadedAt: stat.mtime.toISOString(),
        url: `/api/images/${encodeURIComponent(name)}`,
      });
    }
    // 최근 올린 것이 위로
    return out.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  } catch {
    // 보관소가 없거나 못 읽으면 빈 목록으로 둔다. 화면이 죽을 이유는 없다
    return [];
  }
}

export async function deleteImage(name: string): Promise<void> {
  const full = resolveStored(name);
  if (!full) throw new Error("잘못된 파일 이름입니다.");
  try {
    await fs.unlink(full);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw writeError(e);
  }
}

export async function readImage(
  name: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const full = resolveStored(name);
  const contentType = contentTypeOf(name);
  if (!full || !contentType) return null;
  try {
    return { bytes: await fs.readFile(full), contentType };
  } catch {
    return null;
  }
}
