/**
 * 카카오 로컬 API — 장소 조회.
 *
 * 원래는 네이버 지역검색을 쓰려 했으나 **쓸 수 없다.** 지역검색은 개발자센터의 `검색`
 * API 소속이고, 그 스코프는 신규 발급이 막혀 있다(DEVLOG 8장에서 실제로 호출해
 * `401 Scope Status Invalid` 를 확인했다). 같은 자리를 카카오가 메운다 — 신규 발급이
 * 되고, 상호·도로명주소·업종·좌표를 준다.
 *
 * 여기서 가져오는 것은 **공개된 사실뿐이다.** 남의 후기 문장이나 평점은 가져오지 않는다.
 * 후기를 요약해 본문에 넣으면 네이버 유사문서 필터에 걸려 글이 아예 노출되지 않는다.
 */

import { getSettings } from "./db";

const SEARCH_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";

export type Place = {
  name: string;
  /** 도로명주소. 없으면 지번으로 떨어진다 */
  address: string;
  /** 지번주소 */
  lotAddress: string;
  /** "음식점 > 한식 > 국밥" 처럼 계층으로 온다 */
  category: string;
  /** 카테고리 대분류. 음식점이 아닌 결과를 거를 때 쓴다 */
  categoryGroup: string;
  phone: string;
  /** 경도, 위도 (문자열로 온다) */
  x: string;
  y: string;
  /** 카카오맵 상세 페이지 */
  url: string;
};

export async function kakaoKey(): Promise<string> {
  const s = await getSettings(["kakao_rest_api_key"]);
  return s.kakao_rest_api_key || process.env.KAKAO_REST_API_KEY || "";
}

/**
 * 키워드로 장소를 찾는다.
 *
 * 음식점(FD6)·카페(CE7)로 좁힌다. `신림 국밥` 같은 질의에 학원이나 부동산이 섞여
 * 오는 것을 막는다. 사용자가 상호를 정확히 몰라도 되게 지역명을 함께 넣어 부르면 된다.
 */
export async function searchPlaces(query: string, size = 5): Promise<Place[]> {
  const key = await kakaoKey();
  if (!key) {
    throw new Error(
      "카카오 REST API 키가 없습니다. 설정 화면에서 등록하세요 (developers.kakao.com → 내 애플리케이션 → 앱 키 → REST API 키).",
    );
  }
  if (!query.trim()) return [];

  /*
   * category_group_code 는 코드 하나만 받는다. "FD6,CE7" 처럼 이어 보내면 400
   * (Request validation is failed) 이다 — 실제로 배포본에서 그렇게 터졌다.
   * 그래서 필터 없이 넉넉히 받아 음식점(FD6)·카페(CE7)만 남긴다. 둘 다 없으면 전부 돌려준다.
   */
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query.trim())}&size=${Math.min(15, size * 3)}`;
  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${key}` },
  });

  const text = await res.text();
  if (!res.ok) throw kakaoError(res.status, text);

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("카카오 응답을 JSON 으로 해석하지 못했습니다.");
  }

  const docs: any[] = json.documents ?? [];
  const eatery = docs.filter((d) => d.category_group_code === "FD6" || d.category_group_code === "CE7");
  return (eatery.length ? eatery : docs).slice(0, size).map(
    (d: any): Place => ({
      name: String(d.place_name ?? ""),
      address: String(d.road_address_name || d.address_name || ""),
      lotAddress: String(d.address_name ?? ""),
      category: String(d.category_name ?? ""),
      categoryGroup: String(d.category_group_name ?? ""),
      phone: String(d.phone ?? ""),
      x: String(d.x ?? ""),
      y: String(d.y ?? ""),
      url: String(d.place_url ?? ""),
    }),
  );
}

function kakaoError(status: number, body: string): Error {
  let detail = body;
  try {
    detail = JSON.parse(body)?.message ?? body;
  } catch {
    /* 원문 유지 */
  }
  if (status === 401) {
    return new Error(
      `카카오 REST API 키가 올바르지 않습니다 (HTTP 401). JavaScript 키가 아니라 **REST API 키**여야 합니다. 원문: ${detail}`,
    );
  }
  if (status === 403) {
    return new Error(
      `카카오 앱에 로컬 API 권한이 없습니다 (HTTP 403). 내 애플리케이션 → 카카오맵 활성화를 확인하세요. 원문: ${detail}`,
    );
  }
  if (status === 429) {
    return new Error(`카카오 API 호출 한도를 넘었습니다 (HTTP 429). 잠시 뒤 다시 시도하세요.`);
  }
  return new Error(`카카오 로컬 API 오류 (HTTP ${status}): ${detail}`);
}
