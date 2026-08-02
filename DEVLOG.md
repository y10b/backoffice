# 개발 로그

이 백오피스를 만들면서 내린 결정과, 도중에 발견한 것들을 정리한 문서입니다.

> 이 저장소는 공개 저장소입니다. 작업 중 실제 네이버 세션 쿠키로 테스트했지만,
> 쿠키·API 키는 이 문서를 포함해 저장소 어디에도 기록하지 않았습니다.
> 인증 정보는 `.gitignore`된 로컬 `data/backoffice.db`에만 저장됩니다.

## 1. 요구사항

크리에이터 어드바이저에서 네이버 트렌드·주제별 인기 키워드를 확인하고, **메인 키워드 + 서브
키워드**로 제목을 잡아 글을 쓴 뒤, 같은 글을 티스토리에도 올리는 백오피스.

## 2. 초기 결정

| 항목 | 선택 | 이유 |
|---|---|---|
| 데이터 수집 | 쿠키 + 내부 API 직접 호출 | Playwright 자동 로그인은 캡차/2FA에 막히고 느림 |
| 발행 | 복사용 결과물만 생성 | 네이버 글쓰기 API 폐지, 티스토리 Open API 종료 |
| 본문 생성 | Gemini | 사용자 보유 키 |
| 형태 | Next.js 로컬 웹앱 | GUI로 키워드 조회·편집·미리보기 관리 |

의존성은 Next/React뿐입니다. SQLite는 Node 22.5+ 내장 `node:sqlite`를 써서 네이티브 빌드가
없습니다.

## 3. 깨지기 쉬운 부분에 대한 설계

크리에이터 어드바이저는 공개 API가 아니라 경로와 응답 스키마가 예고 없이 바뀝니다. 그래서 둘 다
코드에 고정하지 않았습니다.

- **경로** — DB에 저장된 편집 가능한 프리셋. UI에서 수정하거나, DevTools `Copy as cURL`을
  붙여넣으면 [`src/lib/curl.ts`](src/lib/curl.ts)가 URL을 파싱해 바로 조회
- **응답 스키마** — [`src/lib/naver.ts`](src/lib/naver.ts)의 파서가 JSON을 재귀로 훑어
  "키워드처럼 생긴 문자열 필드를 가진 객체 배열" 중 가장 큰 것을 선택. `keyword` /
  `queryKeyword` / `query` 등 필드명 변형과 중첩 구조를 흡수하고, 실패하면 원본 JSON을 UI에 노출

## 4. 검증

- `npm run build` 통과, 서버 기동·DB 생성·API 응답 확인
- 순수 로직 29개 검증: 응답 스키마 4종 파싱, cURL 셸 인용 규칙(작은/큰따옴표, 백슬래시
  continuation, `-X` 플래그 스킵), 마크다운 변환, XSS 이스케이프

변환기 버그 하나를 잡았습니다. 마크다운 `##`이 `<h3>`로 나가 제목(h1) 다음 h2를 건너뛰었고,
`#`만 h2로 끌어올리고 나머지는 유지하도록 [수정](src/lib/markdown.ts)했습니다.

## 5. 실제 호출에서 막힌 지점 — 요청 서명

실제 세션 쿠키로 테스트하자 전 엔드포인트가 `403 {"status":"fail","message":"Forbidden"}`을
반환했습니다. 로그인 리다이렉트 HTML이 아니라 API 핸들러가 낸 JSON이라 경로 문제가 아니었습니다.

프론트엔드 번들(`/assets/index-*.js`)을 확인해 실제 구조를 파악했습니다.

모든 호출은 `` `/api/v6${path}` ``로 조립되고, 실제 경로는 이렇습니다.

```
/api/v6/accounts/channels
/api/v6/home/popular-category-keyword   ?service=&channelId=&date=
/api/v6/home/popular-demo-keyword       ?service=&channelId=&date=
/api/v6/home/weekly-recommendation      ?service=&date=
/api/v6/home/soaring-contents           ?service=&channelId=&interval=&date=
/api/v6/trend/query-demo-distribution   ?interval=&date=&keyword=
/api/v6/inflow-analysis/referrer-query-rank ?service=&channelId=&metric=&interval=&date=&ct=&limit=
/api/v6/dashboard/channel-ranks         ?service=&channelId=
```

`service`는 `naver_blog`, `channelId`는 블로그 아이디입니다.

문제는 경로가 아니었습니다. 모든 요청에 **HMAC 서명 헤더**가 붙습니다.

```
X-CA-Nonce   crypto.randomUUID()
X-CA-Ts      Date.now()
X-CA-Sig     HMAC("METHOD|...|ts|nonce", <__ca_key 쿠키에서 파생한 키>)
```

응답이 `403` + `code: "CA_KEY_INVALID"`면 `/api/v6/accounts/channels`를 다시 호출해 CA 키를
재발급받고 원 요청을 1회 재시도합니다. 그래서 **`/accounts/*`만 서명 없이 통과**하고(키 발급
엔드포인트라서), 나머지는 전부 403이 됩니다. 실제로 `/accounts/channels`는 정상 응답했습니다.

이건 스크립트 접근을 막으려고 네이버가 의도적으로 넣은 통제입니다. 서명 알고리즘을 복제해
우회하는 방향은 택하지 않았습니다.

## 6. 대안 — 공식 API

키워드 리서치 목적에는 오히려 공식 API 쪽이 낫습니다. 쿠키 만료도, 무단 우회도 없습니다.

| API | 얻는 것 | 발급처 |
|---|---|---|
| 네이버 검색광고 · 키워드도구 | 연관 키워드 + 월간 검색수(PC/모바일) + 경쟁정도 | searchad.naver.com |
| 네이버 데이터랩 · 검색어 트렌드 | 키워드별 검색 추이 (상대지수) | developers.naver.com |

메인 키워드의 검색량과 연관 키워드를 뽑는 용도로는 검색광고 키워드도구가 크리에이터 어드바이저보다
직접적입니다. 내 블로그 유입 통계가 꼭 필요할 때만 크리에이터 어드바이저 UI에서 직접 확인해
붙여넣는 경로를 남겨두면 됩니다.

## 7. 현재 상태

- 글 작성 → 미리보기 → 네이버/티스토리 복사 → 글 목록 관리: **동작함**
- 키워드 자동 수집: **막힘** (위 서명 이슈). 수동 입력 및 cURL 붙여넣기 경로는 살아 있음
- 다음 단계: 키워드 소스를 공식 API로 교체
