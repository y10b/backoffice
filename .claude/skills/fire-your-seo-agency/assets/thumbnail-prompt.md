# GitHub 소셜 프리뷰(1280×640) 생성 가이드

원칙: **글자는 이미지 모델에 맡기지 않는다** (오탈자·깨진 한글). 배경만 생성하고
타이포는 코드/피그마로 얹는 2단 방식이 정본. 급하면 B안(원샷)도 가능.

## A안 — 배경 생성 + 타이포 오버레이 (권장)

배경 프롬프트 (Midjourney/DALL-E/Stable Image 공용):

```
A dramatic dark navy tech background (deep #0D2137 to near-black gradient),
a single burning orange-red flame emerging from a paper invoice document
that is dissolving into small glowing data particles and search-bar icons,
subtle grid of faint chart lines in the far background, cinematic rim light,
high contrast, minimal composition with empty space on the left 60% for text,
no letters, no words, no typography, 16:9
```

오버레이 스펙 (피그마 또는 satori/sharp):
- 좌측 60% 영역, 좌정렬
- 1행: `fire-your-seo-agency` — Bold 72px, #F6F7F9
- 2행: `월 150만 원짜리 대행, AI 에이전트가 대체합니다` — Medium 34px, #F7941E
- 3행(작게): `SEO · AEO · GEO · LLMO · NEO(네이버)` — 24px, #AEB8C7
- 우측 하단: 🔥 이모지 또는 불꽃 배경 포인트와 겹치게

## B안 — 원샷 (영문 타이포까지 모델에 맡기는 빠른 버전)

```
Minimal GitHub social preview banner, 1280x640, dark navy background,
huge bold white monospace text "fire-your-seo-agency" centered-left,
a small orange flame icon replacing the hyphen dot, subtitle line in amber
"SEO · AEO · GEO · LLMO · NEO", clean flat vector style, subtle noise texture,
professional developer-tool aesthetic
```

⚠️ B안은 영문도 철자가 깨질 수 있음 — 생성 후 반드시 글자 검수. 한글은 절대 넣지 말 것.

## 로고(정사각 아바타)용

```
Flat vector logo icon, a stylized flame formed by a magnifying glass handle,
orange-red gradient flame (#ED1C24 to #F7941E) on deep navy circle background,
minimal, bold silhouette, no text, app-icon style, centered
```
