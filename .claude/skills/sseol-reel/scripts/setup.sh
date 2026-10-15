#!/usr/bin/env bash
# 썰 릴스 렌더링 준비: 파이썬 패키지 + 한글 폰트 + 이모지 폰트. 여러 번 실행해도 안전.
set -euo pipefail
CACHE="${SSEOL_CACHE:-$HOME/.cache/sseol-reel}"
FONTS="$CACHE/fonts"
mkdir -p "$FONTS"

command -v ffmpeg >/dev/null || { echo "❌ ffmpeg 없음 (apt-get install -y ffmpeg 필요)"; exit 1; }
python3 -c "import PIL, numpy, edge_tts" 2>/dev/null || pip install -q pillow numpy edge-tts 2>&1 | grep -v "root user" || true

# Google Fonts(OFL) 한글 폰트. github raw가 막힌 환경이 있어서 jsDelivr 먼저.
fetch() {  # fetch <저장파일> <google/fonts 안의 경로>
  [ -s "$FONTS/$1" ] && return 0
  for base in "https://cdn.jsdelivr.net/gh/google/fonts@main" "https://github.com/google/fonts/raw/main"; do
    curl -sSLf -o "$FONTS/$1" "$base/$2" && return 0
  done
  echo "❌ 폰트 다운로드 실패: $1"; return 1
}
fetch BlackHanSans.ttf ofl/blackhansans/BlackHanSans-Regular.ttf
fetch Jua.ttf ofl/jua/Jua-Regular.ttf

if [ ! -f /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf ] && [ ! -s "$FONTS/NotoColorEmoji.ttf" ]; then
  curl -sSLf -o "$FONTS/NotoColorEmoji.ttf" "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf" \
    || echo "⚠️ 이모지 폰트 다운로드 실패: 이모지가 안 보일 수 있음"
fi
echo "✅ 준비 완료 (캐시: $CACHE)"
