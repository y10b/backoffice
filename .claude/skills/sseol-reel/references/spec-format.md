# 대본(spec) 파일 형식

대본은 파이썬 파일 하나다. `render.py`가 실행할 때 `scripts/assets.py`의 모든 함수·상수(`W`, `H`, 팔레트, 소품 함수)를 미리 넣어주므로 import 없이 쓴다. 완성 예시는 `examples/toilet_boss.py`.

```python
NAME = "파일이름_썰"            # 결과물 파일명 (확장자 없이)
TITLE = "🚻 여자화장실 착각 썰"   # 화면 상단 고정 타이틀 알약
COVER_AT = (0, 1)              # 커버 = (장면 번호, 대사 번호) 직전 화면. 보통 훅이 다 뜬 순간
VOICES = {"boss": (SHE, "-20%", "-40Hz", "+0%")}   # (선택) 프리셋 추가/덮어쓰기
SCRIPT = [ 장면, 장면, ... ]
```

## 장면 (scene)

```python
dict(pal=RED, cap_y=1290, rewind=False,
     visuals=[(대사번호, 그림, x, y, 등장, 효과음), ...],
     beats=[대사, 대사, ...])
```

- `pal`: 배경 팔레트 `NAVY`(기본), `DARK`(긴장/밤), `RED`(위기/클라이맥스), `TEAL`(전환/이동), `PINK`(연애)
- `cap_y`: 자막 중심 y. 화면 1080x1920, **안전 영역 y 400~1500**. 위쪽 200은 인스타 UI, 아래 400은 캡션/버튼에 가려짐
  - 그림이 위에 있으면 자막 1200~1340, 그림이 아래면 450~550, 그림 없으면 850~1000
- `rewind=True`: 되감기 주사선 효과 (⏪ 10분 전 장면용, `sfx="rewind"`와 같이)
- `visuals`: 장면이 끝날 때까지 남는 그림
  - `대사번호`: 이 장면 몇 번째 대사(0부터)에 등장
  - `그림`: PIL 이미지, 또는 **팩토리** `lambda bt: ...` (bt = 장면 시작 기준 각 대사 시작 초 리스트) → 이미지나 `tl -> 이미지` 함수 반환. `tl`은 그 그림이 등장한 뒤 흐른 초
  - `등장`: `"pop"` `"slideL"` `"slideR"` `"slideup"`
  - `효과음`: `None` 또는 아래 효과음 이름
  - 대사가 바뀔 때마다 그림이 살짝 '툭' 커지는 펀치 줌은 자동

## 대사 (beat)

```python
("읽을 대사", "감정프리셋", "자막", dict(옵션))
```

- `읽을 대사`: TTS가 읽을 문장. `None`이면 말 없는 박자 → `dur` 필수 (예: 끼이익 효과음만)
- `자막`: 문자열 또는 여러 줄 리스트. `None`이면 이전 자막 유지 (한 자막에 여러 대사를 이어 붙일 때)
  - 색 문법: `[r:빨강]` `[y:노랑]` `[c:하늘]` `[p:분홍]` `[g:회색]`, 나머지는 흰색
  - 이모지 그대로 사용 가능. **`→` `…` `·` 는 폰트에 없음** → `➡️`, `...` 사용
  - 자막은 TTS 대사보다 **짧게 요약/펀치라인화**. 대사를 그대로 옮기지 말 것
- 옵션: `sfx` 효과음, `shake` 화면+자막 흔들림(10 약함~34 최강), `flash` 번쩍 색 `(255,40,40)`, `gap` 대사 뒤 쉼(초, 기본 0.08; 개그 타이밍엔 0.3~0.5), `size` 자막 크기(기본 92, 펀치라인 110~150), `dur` 말 없는 박자 길이

## 감정 프리셋 (render.py `PRESETS`)

| 이름 | 용도 |
|---|---|
| `talk` | 기본 해요체 수다 |
| `yell` | 흥분 |
| `scream` | 빡쳐서 샤우팅 ("아니 쌰갈!!!") |
| `rap` | 다다다 쏟아내기 (나열, 변명) |
| `smug` | 뜸 들이기, 떡밥 ("근데 진짜 문제는요?") |
| `deadpan` | 무표정 현타 ("아. 여기 여자화장실이구나.") |
| `whisper` | 작게 속삭임 |
| `tense` | 긴장 |
| `chill` | 태평 ("뭐, 그럴 수 있지~") |
| `plead` | 애원 |
| `she` / `ajumma` / `guy` | 등장인물 목소리 (여자 밝게 / 아주머니 / 남자 낮게) |

목소리는 edge-tts `ko-KR-InJoonNeural`(남, `ME`) / `ko-KR-SunHiNeural`(여, `SHE`) / `ko-KR-HyunsuMultilingualNeural`(남). 화자가 여자면 `VOICES`로 기본 프리셋들의 목소리를 `SHE`로 바꾼다.

## 효과음

`pop`(자막 뜰 때 자동) `whoosh` `boom` `ding`(카톡) `creak`(문) `beep` `rewind` `thud`(묵직한 쿵, 고구마) `fizz`(탄산 치익, 사이다)

## 소품 함수 (assets.py)

| 함수 | 설명 |
|---|---|
| `text_img(lines, size)` | 자막 문법 텍스트 이미지 |
| `emoji_img("😱", 260)` | 큰 이모지 |
| `pill("텍스트", size, bg, fg)` | 알약 라벨 |
| `eyes_img(tl, stare=False)` | 째려보는 눈 (함수형: `lambda bt: (lambda tl: eyes_img(tl))`) |
| `phone_from([(대사번호, 지연초, "L"/"R", "메시지")], h=640, start=0, title="썸녀 💘")` | 카톡 휴대폰 (팩토리) |
| `mirror_img("😳")` | 거울 속 표정 |
| `sign_img("A"/"B", 300)` | 헷갈리는 네모 화장실 표시 |
| `boss_bar("이름 [y:Lv.99]")` | 게임 보스 체력바 |
| `quest_banner("제목", "[g:부제]")` | 긴급 퀘스트 알림 |
| `choice_menu(["1. ...", "2. ...", "3. [y:정답]"], pick=None, show_from=1, pick_at=None)` | 선택지 UI (팩토리). i번째 선택지는 `show_from+i`번 대사에 등장. `pick`(기본 마지막)이 `pick_at`번 대사에 선택 (없으면 마지막 선택지 0.5초 뒤). 퀴즈 훅은 `pick_at`=정답 공개 대사 |
| `teaser_card(["그 후로", "[r:썸 깨진 썰] 💔"])` | 다음 썰 예고 카드 |
| `follow_btn()` | ➕ 팔로우 버튼 |

새 소품이 필요하면 assets.py 스타일(PIL로 그린 RGBA 이미지 반환)로 대본 파일 안에 함수를 직접 정의해도 된다.

## 장면 배경 / 캐릭터 연기

장면 dict에 추가 옵션:
- `bg=함수`: 장면 배경. `place_station`(역), `place_room_night`(밤 방), `place_speedlines`(만화 집중선, 빡침/충격), 기본은 빛 번짐. 새 장소는 `(sc, t) -> 1080x1920 RGBA` 함수로 대본 안에 그려서 넘긴다
- `cap_box=True`: 밝은 배경에서 자막 뒤에 어두운 박스

### 그림 캐릭터 `cast()` (기본으로 이걸 쓴다)

```python
(0, cast("me", {0: "phone", 2: "shock"}, talk=[0, 2]), 290, 1660, "none", None)
(1, cast("she", {1: "love"}, talk=[1], flip=True, start=1), 800, 1660, "slideR", "whoosh")
```
- x, y = **발 위치**. 두 명이면 x 290 / 800, 한 명이면 W // 2. y 1640~1680
- 표정: `neutral` `happy` `phone`(=`love`) `shock` `angry` `deadpan` `sad` `smug`(=`shrug`, "왜?" 말풍선 포함)
- `talk`: 말하는 대사 번호 (통통 튐). 빡침은 자동으로 떨림, 놀람은 점프, 표정 바뀔 때 '툭'
- `flip=True`: 왼쪽을 보게 (오른쪽에 선 사람). smug 컷은 글자 때문에 안 뒤집힘
- `start`: 등장 대사 번호 (visual 첫 값과 같게)
- 캐릭터가 화면 아래쪽을 차지하므로 자막은 `cap_y` 650~750, 다른 소품은 피해서 배치

등록된 캐스트 (`cast/`): `me` 나 · `buddy` 안경 절친 · `hunk` 훈남/소개팅남 · `she` 썸녀 · `chic` 단발 여사친 (+ 추가되는 것들, `cast/*/meta.json`의 label 참고)

새 캐릭터 등록: 초록 배경 2x4 시트(1 기본 2 웃음 3 폰 4 놀람 5 빡침 6 현타 7 슬픔 8 뻔뻔)를 받아
`python3 scripts/make_cast.py SHEET.png 이름 --label "설명"`. 시트 프롬프트는 references/cast-prompt.md

`actor()`는 코드로 그린 막대 캐릭터 (캐스트에 없는 인물용 임시 대역)
