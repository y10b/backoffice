# 인스타 자동 업로드 설정 (한 번만)

인스타그램 공식 API(Instagram Graph API)로 릴스를 올린다. 개인 계정은 API 업로드가 안 되므로 아래 조건이 필요하다.

## 1. 계정 준비
1. 인스타 앱 → 설정 → 계정 유형 → **프로페셔널 계정(크리에이터 또는 비즈니스)** 으로 전환 (무료)
2. (페이스북 로그인 방식이면) 페이스북 페이지를 하나 만들고 인스타 계정과 연결

## 2. 토큰 발급
1. https://developers.facebook.com 에서 앱 생성 (유형: 비즈니스)
2. 제품 추가: **Instagram** (Instagram 로그인 방식) 또는 Facebook 로그인
3. 권한: `instagram_business_basic` + `instagram_business_content_publish` (인스타 로그인 방식)
   또는 `instagram_basic` + `instagram_content_publish` + `pages_show_list` (페이스북 로그인 방식)
4. 본인 계정으로 **장기(60일) 액세스 토큰** 발급, 그 계정의 **IG User ID**(숫자) 확인
   - 인스타 로그인 방식 토큰이면 `IG_GRAPH_HOST=graph.instagram.com` 도 설정

본인 계정에 본인이 올리는 용도면 앱 검토(App Review) 없이 개발 모드로 쓸 수 있다.

## 3. Claude 환경에 등록
**토큰을 채팅에 붙여넣지 말 것.** 클라우드 환경 설정(세션 제목 옆 환경 메뉴 → Edit)에서:

- 시크릿/환경변수: `IG_USER_ID`, `IG_ACCESS_TOKEN` (필요하면 `IG_GRAPH_HOST`)
- 네트워크 허용 도메인: `graph.facebook.com`, `rupload.facebook.com` (인스타 로그인 방식이면 `graph.instagram.com`도)
- 새 세션부터 적용됨

## 4. 확인
```bash
python3 .claude/skills/sseol-reel/scripts/upload_instagram.py VIDEO.mp4 --caption-file CAPTION.txt
```
`--yes` 없이 돌리면 계정 이름만 확인하고 아무것도 안 올린다.

## 참고
- 토큰은 60일마다 갱신 필요 (만료되면 HTTP 190 에러)
- API 게시 한도: 24시간 50개
- API 게시에는 인스타 음악 라이브러리를 붙이는 기능이 없다 (API로 올리는 그 릴스에만 해당). 게시 후 앱에서 음악을 추가할 수 있는지는 앱 버전·계정마다 다를 수 있으니, 음악이 꼭 필요한 영상은 MP4를 받아 앱에서 직접 올린다
