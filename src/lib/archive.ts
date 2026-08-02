/**
 * Internet Archive 영상 소재.
 *
 * 유튜브 CC 검색과 달리 여기는 **파일을 직접 내려받는 것이 허용**된다. 공개 도메인이거나
 * 재사용 가능한 라이선스로 올라온 것들이고, archive.org 가 다운로드 URL 을 공개한다.
 * 그래서 실제로 편집에 쓸 소재는 이쪽이 안전하다.
 *
 * 키가 필요 없어 설정 없이 바로 쓴다.
 */
const SEARCH = "https://archive.org/advancedsearch.php";
const METADATA = "https://archive.org/metadata";
const DOWNLOAD = "https://archive.org/download";

/** 편집에 쓸 만한 컨테이너만. 스트리밍 전용 포맷은 ffmpeg 가 다루기 번거롭다 */
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ogv)$/i;

export type ArchiveItem = {
  identifier: string;
  title: string;
  creator: string;
  year: string;
  /** archive.org 가 표기한 라이선스 URL. 공개 도메인이면 비어 있을 수 있다 */
  licenseUrl: string;
  description: string;
  detailUrl: string;
  thumbnail: string;
};

export type ArchiveFile = {
  name: string;
  format: string;
  sizeBytes: number | null;
  /** 초 단위. 메타데이터에 없을 수도 있다 */
  durationSec: number | null;
  downloadUrl: string;
};

function toSeconds(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v !== "string" || !v.trim()) return null;
  // "1:02:03" 또는 "123.4" 두 형태가 섞여 온다
  const parts = v.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const sec = parts.reduce((acc, n) => acc * 60 + n, 0);
  return Number.isFinite(sec) ? Math.round(sec) : null;
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 영상 소재 검색.
 * `mediatype:movies` 로 좁히고, 접근이 막힌 항목(`access-restricted`)은 제외한다.
 */
export async function searchArchive(
  query: string,
  rows = 20,
): Promise<ArchiveItem[]> {
  const q = `${query} AND mediatype:(movies) AND NOT access-restricted-item:true`;
  const url = new URL(SEARCH);
  url.searchParams.set("q", q);
  for (const f of ["identifier", "title", "creator", "year", "licenseurl", "description"]) {
    url.searchParams.append("fl[]", f);
  }
  url.searchParams.set("rows", String(Math.min(Math.max(rows, 1), 50)));
  url.searchParams.set("page", "1");
  url.searchParams.set("output", "json");
  /*
   * 정렬을 걸지 않는다.
   *
   * `downloads desc` 로 두면 검색어와 무관한 인기 항목이 위로 올라온다. 실제로
   * `"korean war"` 를 넣었는데 `Duck and Cover`, `Nazi Concentration Camps` 가 나왔다.
   * 다운로드 수가 압도적이라 관련도를 눌러버린 것이다.
   *
   * 정렬을 비우면 archive.org 가 관련도순으로 준다. 쇼츠 소재는 "많이 받은 것"보다
   * "주제에 맞는 것"이 중요하다.
   */

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Archive.org 검색 실패 (HTTP ${res.status})`);

  const data: any = await res.json();
  const docs = data?.response?.docs ?? [];
  return docs.map((d: any): ArchiveItem => {
    const id = String(d.identifier ?? "");
    return {
      identifier: id,
      title: String(first(d.title) ?? id),
      creator: String(first(d.creator) ?? ""),
      year: String(first(d.year) ?? ""),
      licenseUrl: String(first(d.licenseurl) ?? ""),
      description: String(first(d.description) ?? "").slice(0, 300),
      detailUrl: `https://archive.org/details/${id}`,
      thumbnail: `https://archive.org/services/img/${id}`,
    };
  });
}

/**
 * 항목에 딸린 실제 영상 파일 목록.
 * 같은 영상이 여러 화질로 올라와 있어서, 편집에 쓸 하나를 고르려면 이걸 봐야 한다.
 */
export async function archiveFiles(identifier: string): Promise<ArchiveFile[]> {
  const res = await fetch(`${METADATA}/${encodeURIComponent(identifier)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Archive.org 메타데이터 실패 (HTTP ${res.status})`);

  const data: any = await res.json();
  const files = Array.isArray(data?.files) ? data.files : [];

  return files
    .filter((f: any) => VIDEO_EXT.test(String(f?.name ?? "")))
    .map(
      (f: any): ArchiveFile => ({
        name: String(f.name),
        format: String(f.format ?? ""),
        sizeBytes: Number.isFinite(Number(f.size)) ? Number(f.size) : null,
        durationSec: toSeconds(f.length),
        downloadUrl: `${DOWNLOAD}/${encodeURIComponent(identifier)}/${encodeURI(String(f.name))}`,
      }),
    )
    // 용량이 작은 것부터. 쇼츠로 자를 거라 원본 최고화질이 필요하지 않고, 받는 시간이 짧다
    .sort((a: ArchiveFile, b: ArchiveFile) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
}

/**
 * 라이선스 표기를 사람이 읽는 말로.
 *
 * 처음에는 표기가 없으면 "대개 공개 도메인"이라고 안내했는데, 그건 틀렸다.
 * archive.org 는 누구나 올릴 수 있어서 **표기 없음은 그냥 업로더가 안 적은 것**이다.
 * 실제로 `seoul korea` 를 찾으니 SBS 뉴스 클립이 표기 없이 여럿 올라와 있었다.
 * 명백한 방송사 저작물인데 "공개 도메인"이라고 띄우면 그대로 쓰다가 사고가 난다.
 *
 * 그래서 확인된 것만 확인됐다고 말하고, 나머지는 직접 확인하라고 되돌린다.
 */
export type LicenseInfo = {
  label: string;
  /** 재사용해도 되는지 확인됐는가. 화면에서 이 값으로 색을 가른다 */
  confirmed: boolean;
};

export function licenseLabel(licenseUrl: string): LicenseInfo {
  if (!licenseUrl) return { label: "표기 없음 — 직접 확인 필요", confirmed: false };
  const u = licenseUrl.toLowerCase();
  if (u.includes("publicdomain") || u.includes("/zero/")) {
    return { label: "공개 도메인 (CC0)", confirmed: true };
  }
  const m = /creativecommons\.org\/licenses\/([a-z-]+)\//.exec(u);
  // nc(비상업)·nd(변경금지)는 쇼츠로 가공해 수익화하는 데 맞지 않는다
  if (m) {
    const code = m[1].toUpperCase();
    const restricted = /NC|ND/.test(code);
    return {
      label: `CC ${code}${restricted ? " — 가공·수익화 제한" : ""}`,
      confirmed: !restricted,
    };
  }
  return { label: licenseUrl, confirmed: false };
}
