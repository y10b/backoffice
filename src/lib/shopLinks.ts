/**
 * 제품 후기의 제휴 링크와 대가성 표시.
 *
 * 서버(visit.ts)와 화면(visit/page.tsx)이 같이 쓴다. 그래서 import 가 하나도 없는 순수 모듈로 둔다.
 *
 * 대가성 표시 위치 — 공정위 추천·보증 심사지침(2024-12 개정)은 블로그 같은 문자 매체의
 * 경제적 이해관계 표시를 "게시물의 제목 또는 첫 부분" 에 두게 했다(예전의 "끝 부분" 이 빠졌다).
 * 첫 부분에 둘 때는 본문보다 크게 하거나 색을 달리해 쉽게 알아보게 해야 한다. 그래서 하단으로
 * 옮기지 않고, 기본은 맨 위의 크고 눈에 띄는 **이미지**로 둔다. 텍스트 첫 줄은 검색 미리보기가
 * "이 포스팅은 … 수수료를" 로 시작해 클릭을 깎는다 — 이미지면 미리보기는 그다음 문장부터 나온다.
 */

export type ShopKind = "naver" | "coupang" | "ohou" | "oliveyoung" | "other";
export type ShopLink = { shop: ShopKind; url: string; label?: string };
export type DisclosureMode = "image" | "text";

export const SHOP_KINDS: ShopKind[] = ["naver", "coupang", "ohou", "oliveyoung", "other"];
export const MAX_SHOP_LINKS = 6;

/**
 * program — 대가성 문구와 화면 선택지에 쓰는 제휴 프로그램 이름.
 * name — 링크 줄("👉 쿠팡에서 보기")에 쓰는 판매처 이름.
 * (ProductPanel·productTrend 의 SHOP 라벨은 검색 결과 페이지용 이름이라 따로 둔다)
 */
export const SHOP_INFO: Record<ShopKind, { program: string; name: string; placeholder: string }> = {
  naver: { program: "네이버 쇼핑 커넥트", name: "네이버 쇼핑", placeholder: "https://naver.me/..." },
  coupang: { program: "쿠팡 파트너스", name: "쿠팡", placeholder: "https://link.coupang.com/a/..." },
  ohou: { program: "오늘의집", name: "오늘의집", placeholder: "https://ohou.se/..." },
  oliveyoung: { program: "올리브영", name: "올리브영", placeholder: "https://oy.run/..." },
  other: { program: "기타", name: "판매처", placeholder: "https://..." },
};

/** 네이버 쇼핑 커넥트 대가성 문구 */
export const SHOP_CONNECT_DISCLOSURE = "이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.";
/** 쿠팡 파트너스가 요구하는 문구 그대로. 한 글자도 바꾸지 않는다 */
export const COUPANG_DISCLOSURE = "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.";

/** 본문 맨 앞의 대가성 문구 이미지 자리. 사진 자리 `[사진 N]` 과 같은 모양으로 한 줄에 둔다 */
export const DISCLOSURE_IMAGE_SLOT = "[대가성 문구 이미지]";
/** 모델이 링크를 넣을 자리 */
export const SHOP_LINK_SLOT = "[쇼핑 링크]";

const HTTPS = /^https:\/\/\S+$/;

export function isHttpsUrl(url: string): boolean {
  return HTTPS.test(url.trim());
}

/** 대가성 문구에 쓰는 프로그램 이름. 기타는 사람이 적은 이름, 없으면 "쇼핑몰" */
function programName(l: Pick<ShopLink, "shop" | "label">): string {
  if (l.shop === "other") return l.label?.trim() || "쇼핑몰";
  return SHOP_INFO[l.shop].program;
}

/** 링크 줄에 쓰는 이름. 사람이 이름을 적었으면 그것 */
function linkName(l: ShopLink): string {
  return l.label?.trim() || SHOP_INFO[l.shop].name;
}

function joinKo(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} 및 ${names[names.length - 1]}`;
}

/**
 * 링크 플랫폼들에 맞는 대가성 문구 한 덩어리.
 *
 * - 쿠팡이 있으면 쿠팡 문구를 원문 그대로 앞에 둔다
 * - 네이버만이면 쇼핑 커넥트 문구 그대로
 * - 나머지는 "이 포스팅은 A, B 및 C 제휴 활동의 일환으로, 구매 시 수수료를 제공받을 수 있습니다." 한 문장
 */
export function disclosureText(shops: (ShopKind | Pick<ShopLink, "shop" | "label">)[]): string {
  const items = shops.map((s) => (typeof s === "string" ? { shop: s } : s)).filter((s) => SHOP_KINDS.includes(s.shop));
  const hasCoupang = items.some((s) => s.shop === "coupang");
  const names: string[] = [];
  for (const s of items) {
    if (s.shop === "coupang") continue;
    const n = programName(s);
    if (!names.includes(n)) names.push(n);
  }
  const rest = !names.length
    ? ""
    : names.length === 1 && names[0] === SHOP_INFO.naver.program
      ? SHOP_CONNECT_DISCLOSURE
      : `이 포스팅은 ${joinKo(names)} 제휴 활동의 일환으로, 구매 시 수수료를 제공받을 수 있습니다.`;
  return [hasCoupang ? COUPANG_DISCLOSURE : "", rest].filter(Boolean).join(" ");
}

/**
 * 인터뷰에서 링크 목록을 꺼낸다. 예전 초안은 `shopLink`(네이버 하나)만 있으니 그것을 네이버 링크로 본다.
 * https 가 아닌 것, 모르는 플랫폼, 같은 주소는 버리고 최대 6개.
 */
export function normalizeShopLinks(iv: { shopLinks?: unknown; shopLink?: unknown } | null | undefined): ShopLink[] {
  const out: ShopLink[] = [];
  const raw = Array.isArray(iv?.shopLinks) ? iv!.shopLinks : [];
  for (const r of raw as Record<string, unknown>[]) {
    const shop = String(r?.shop ?? "") as ShopKind;
    const url = String(r?.url ?? "").trim();
    const label = String(r?.label ?? "").trim();
    if (!SHOP_KINDS.includes(shop) || !isHttpsUrl(url) || out.some((l) => l.url === url)) continue;
    out.push(label ? { shop, url, label } : { shop, url });
  }
  if (!Array.isArray(iv?.shopLinks)) {
    const old = String(iv?.shopLink ?? "").trim();
    if (isHttpsUrl(old)) out.push({ shop: "naver", url: old });
  }
  return out.slice(0, MAX_SHOP_LINKS);
}

/**
 * 서버 검증. 잘못된 행이 있으면 무엇이 잘못됐는지 돌려준다(빈 주소 행은 그냥 버린다).
 */
export function validateShopLinks(raw: unknown): { links: ShopLink[]; error?: string } {
  if (raw == null) return { links: [] };
  if (!Array.isArray(raw)) return { links: [], error: "shopLinks 는 배열이어야 합니다." };
  const rows = (raw as Record<string, unknown>[]).filter((r) => String(r?.url ?? "").trim());
  if (rows.length > MAX_SHOP_LINKS) return { links: [], error: `제휴 링크는 최대 ${MAX_SHOP_LINKS}개입니다.` };
  for (const r of rows) {
    const shop = String(r?.shop ?? "");
    if (!SHOP_KINDS.includes(shop as ShopKind)) return { links: [], error: `모르는 판매처입니다: ${shop}` };
    if (!isHttpsUrl(String(r.url))) return { links: [], error: `https 로 시작하는 주소여야 합니다: ${String(r.url).trim()}` };
  }
  return { links: normalizeShopLinks({ shopLinks: rows }) };
}

/** 우리가 넣은 링크 줄. 예전 "👉 [제품 보러가기](…)" 도 같은 모양이다 */
const LINK_LINE = /^👉 \[[^\]]*\]\(https:\/\/[^)\s]+\)\s*$/;
/** 우리가 넣은 텍스트 대가성 문구 줄(체험단 문구 "이 글은 업체로부터…" 는 건드리지 않는다) */
const DISCLOSURE_LINE = /^이 포스팅은 .*수수료를 제공받(습니다|을 수 있습니다)\.\s*$/;

/**
 * 제휴 링크와 대가성 표시를 본문에 박는다. 모델에 맡기면 문구를 빠뜨리거나 링크를 여러 번 넣는다.
 *
 * - mode "image"(기본): 맨 앞에 `[대가성 문구 이미지]` 한 줄. 텍스트 문구는 넣지 않는다
 * - mode "text": 맨 앞에 합친 대가성 문구 텍스트
 * - `[쇼핑 링크]` 자리마다 "👉 쿠팡에서 보기" 같은 링크 줄을 한 블록으로. 자리가 없으면 맨 끝에 한 블록
 *
 * 고쳐 쓰기로 다시 돌면 이전 초안에 이미 링크 줄·문구·이미지 자리가 있다. 먼저 그것들을 걷어내고
 * (링크 줄 블록은 `[쇼핑 링크]` 자리로 되돌린다) 다시 넣으므로 몇 번을 돌아도 결과가 같다.
 */
export function withShopLinks(markdown: string, links: ShopLink[], mode: DisclosureMode = "image"): string {
  const uniq: ShopLink[] = [];
  for (const l of links) if (isHttpsUrl(l.url) && !uniq.some((u) => u.url === l.url.trim())) uniq.push({ ...l, url: l.url.trim() });

  // 1. 이전에 넣은 것을 걷어낸다
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (t === DISCLOSURE_IMAGE_SLOT || DISCLOSURE_LINE.test(t)) continue;
    if (LINK_LINE.test(t) || t.includes(SHOP_LINK_SLOT)) {
      // 링크 줄이 이어진 블록은 자리 하나로
      if (lines[lines.length - 1] !== SHOP_LINK_SLOT) lines.push(SHOP_LINK_SLOT);
      continue;
    }
    lines.push(line);
  }
  let out = lines.join("\n");

  if (!uniq.length) {
    return out.split("\n").filter((l) => l !== SHOP_LINK_SLOT).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  // 2. 링크 블록
  const block = uniq.map((l) => `👉 [${linkName(l)}에서 보기](${l.url})`).join("\n");
  if (out.includes(SHOP_LINK_SLOT)) out = out.split("\n").map((l) => (l === SHOP_LINK_SLOT ? block : l)).join("\n");
  else out = `${out.trimEnd()}\n\n${block}`;

  // 3. 맨 앞 대가성 표시
  const head = mode === "text" ? disclosureText(uniq) : DISCLOSURE_IMAGE_SLOT;
  out = `${head}\n\n${out.trim()}`;
  return out.replace(/\n{3,}/g, "\n\n") + "\n";
}
