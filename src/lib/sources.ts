import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 직접 받아온 영상 소재 보관소.
 *
 * archive.org 처럼 URL 로 바로 긁을 수 있는 곳만으로는 부족하다. 국내 공공 아카이브
 * (e영상역사관 대한뉴스 등)는 공공누리 1유형이라 상업적 편집이 허용되지만, 다운로드가
 * KTV 나누리 회원가입 + 영상 요청이라 자동화가 안 된다.
 *
 * 한 번 받아두면 계속 쓸 수 있으므로, 받은 파일을 여기 넣고 렌더 입력으로 고른다.
 *
 * 출처와 라이선스를 함께 적게 한다. 나중에 이 영상을 어디서 가져왔는지 모르면
 * 발행 설명란에 출처를 못 쓰고, 공공누리는 출처 표시가 이용 조건이다.
 */
const SOURCE_DIR = path.join(process.cwd(), "data", "sources");
const META_FILE = path.join(SOURCE_DIR, "index.json");

const ALLOWED = new Map<string, string>([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"],
  // 내레이션 오디오. 영상 클립을 이어 붙일 때 오디오 트랙으로 들어간다
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"],
  [".opus", "audio/opus"],
]);

/** 쇼츠 소재라 원본이 아주 클 이유가 없다 */
export const MAX_BYTES = 500 * 1024 * 1024;

export type SourceMeta = {
  name: string;
  originalName: string;
  /** 어디서 받았는지 (예: e영상역사관 대한뉴스 제1234호) */
  origin: string;
  /** 라이선스 (예: 공공누리 제1유형) */
  license: string;
  sizeBytes: number;
  addedAt: string;
  /** 렌더 입력으로 넣을 로컬 경로 */
  path: string;
};

export function safeName(original: string): string | null {
  const ext = path.extname(original).toLowerCase();
  if (!ALLOWED.has(ext)) return null;
  const stem = path
    .basename(original, path.extname(original))
    .normalize("NFC")
    .replace(/[^0-9A-Za-z가-힣._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 50);
  return `${Date.now()}-${crypto.randomBytes(3).toString("hex")}${stem ? `-${stem}` : ""}${ext}`;
}

/** 보관소 밖을 가리키는 이름을 막는다 */
export function resolveSource(name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (!ALLOWED.has(path.extname(name).toLowerCase())) return null;
  const full = path.resolve(SOURCE_DIR, name);
  if (!full.startsWith(path.resolve(SOURCE_DIR) + path.sep)) return null;
  return full;
}

async function readMeta(): Promise<Record<string, SourceMeta>> {
  try {
    return JSON.parse(await fs.readFile(META_FILE, "utf8"));
  } catch {
    // 아직 없거나 깨졌으면 빈 목록에서 시작한다. 파일 자체는 디스크에 남아 있다
    return {};
  }
}

async function writeMeta(meta: Record<string, SourceMeta>): Promise<void> {
  await fs.mkdir(SOURCE_DIR, { recursive: true });
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2));
}

export async function saveSource(
  originalName: string,
  bytes: Uint8Array,
  info: { origin: string; license: string },
): Promise<SourceMeta> {
  const name = safeName(originalName);
  if (!name) {
    throw new Error(
      `지원하지 않는 형식입니다. ${[...ALLOWED.keys()].join(", ")} 만 올릴 수 있습니다.`,
    );
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (${Math.round(MAX_BYTES / 1024 / 1024)}MB 이하).`);
  }

  try {
    await fs.mkdir(SOURCE_DIR, { recursive: true });
    await fs.writeFile(path.join(SOURCE_DIR, name), bytes);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      throw new Error(
        "이 환경에서는 파일을 저장할 수 없습니다. 배포본은 파일시스템이 읽기 전용이라 소재 업로드는 로컬에서만 됩니다.",
      );
    }
    throw e;
  }

  const entry: SourceMeta = {
    name,
    originalName,
    origin: info.origin.trim(),
    license: info.license.trim(),
    sizeBytes: bytes.byteLength,
    addedAt: new Date().toISOString(),
    path: path.join(SOURCE_DIR, name),
  };

  const meta = await readMeta();
  meta[name] = entry;
  await writeMeta(meta);
  return entry;
}

export async function listSources(): Promise<SourceMeta[]> {
  try {
    await fs.mkdir(SOURCE_DIR, { recursive: true });
    const meta = await readMeta();
    const names = await fs.readdir(SOURCE_DIR);
    const out: SourceMeta[] = [];
    for (const name of names) {
      if (!ALLOWED.has(path.extname(name).toLowerCase())) continue;
      const stat = await fs.stat(path.join(SOURCE_DIR, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      // 메타가 없어도(직접 복사해 넣은 경우) 목록에는 보여준다
      out.push(
        meta[name] ?? {
          name,
          originalName: name,
          origin: "",
          license: "",
          sizeBytes: stat.size,
          addedAt: stat.mtime.toISOString(),
          path: path.join(SOURCE_DIR, name),
        },
      );
    }
    return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  } catch {
    return [];
  }
}

export async function deleteSource(name: string): Promise<void> {
  const full = resolveSource(name);
  if (!full) throw new Error("잘못된 파일 이름입니다.");
  await fs.unlink(full).catch(() => {});
  const meta = await readMeta();
  delete meta[name];
  await writeMeta(meta);
}
