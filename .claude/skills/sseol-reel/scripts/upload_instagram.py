"""인스타그램 릴스 업로드 (Instagram Graph API, resumable 업로드 - 영상 공개 URL 필요 없음).

  python3 upload_instagram.py VIDEO.mp4 --caption-file CAPTION.txt [--thumb-ms 2000]          # 점검만 (dry run)
  python3 upload_instagram.py VIDEO.mp4 --caption-file CAPTION.txt [--thumb-ms 2000] --yes    # 실제 게시

필요한 환경변수 (환경 설정의 시크릿/환경변수로 등록. 채팅에 붙여넣지 말 것):
  IG_USER_ID       인스타 비즈니스/크리에이터 계정의 IG User ID (숫자)
  IG_ACCESS_TOKEN  instagram_content_publish 권한이 있는 액세스 토큰
선택: IG_GRAPH_HOST (기본 graph.facebook.com, 인스타 로그인 토큰이면 graph.instagram.com), IG_GRAPH_VERSION (기본 v21.0)
네트워크 허용 필요: graph.facebook.com(또는 graph.instagram.com), rupload.facebook.com
"""
import argparse, json, os, ssl, sys, time, urllib.error, urllib.parse, urllib.request

HOST = os.environ.get("IG_GRAPH_HOST", "graph.facebook.com")
VER = os.environ.get("IG_GRAPH_VERSION", "v21.0")
_ca = os.environ.get("SSL_CERT_FILE") or ("/root/.ccr/ca-bundle.crt" if os.path.exists("/root/.ccr/ca-bundle.crt") else None)
CTX = ssl.create_default_context(cafile=_ca) if _ca else ssl.create_default_context()


def call(method, url, params=None, data=None, headers=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=300) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        sys.exit(f"❌ {method} {url.split('?')[0]} → HTTP {e.code}: {body[:500]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--caption-file", required=True)
    ap.add_argument("--thumb-ms", type=int, default=None, help="커버로 쓸 프레임 위치(밀리초)")
    ap.add_argument("--no-feed", action="store_true", help="피드에는 안 보이고 릴스 탭에만")
    ap.add_argument("--yes", action="store_true", help="실제로 게시 (없으면 점검만)")
    a = ap.parse_args()

    uid, tok = os.environ.get("IG_USER_ID"), os.environ.get("IG_ACCESS_TOKEN")
    missing = [k for k, v in (("IG_USER_ID", uid), ("IG_ACCESS_TOKEN", tok)) if not v]
    if missing:
        sys.exit(f"❌ 환경변수 없음: {', '.join(missing)} (references/instagram-setup.md 참고)")
    caption = open(a.caption_file, encoding="utf-8").read().strip()
    size = os.path.getsize(a.video)
    base = f"https://{HOST}/{VER}"

    me = call("GET", f"{base}/{uid}", {"fields": "username", "access_token": tok})
    print(f"계정: @{me.get('username', '?')} | 영상 {size / 1e6:.1f}MB | 캡션 {len(caption)}자")
    if not a.yes:
        print("점검 완료 (dry run). 실제 게시하려면 --yes")
        return

    params = {"media_type": "REELS", "upload_type": "resumable", "caption": caption,
              "share_to_feed": "false" if a.no_feed else "true", "access_token": tok}
    if a.thumb_ms is not None:
        params["thumb_offset"] = str(a.thumb_ms)
    cont = call("POST", f"{base}/{uid}/media", params)
    cid = cont["id"]
    upload_uri = cont.get("uri") or f"https://rupload.facebook.com/ig-api-upload/{VER}/{cid}"
    print("컨테이너 생성:", cid)

    with open(a.video, "rb") as f:
        call("POST", upload_uri, data=f.read(),
             headers={"Authorization": f"OAuth {tok}", "offset": "0", "file_size": str(size)})
    print("업로드 완료, 인스타 처리 대기 중...")

    for _ in range(60):  # 최대 약 5분
        st = call("GET", f"{base}/{cid}", {"fields": "status_code,status", "access_token": tok})
        code = st.get("status_code")
        if code == "FINISHED":
            break
        if code in ("ERROR", "EXPIRED"):
            sys.exit(f"❌ 인스타 처리 실패: {st}")
        time.sleep(5)
    else:
        sys.exit("❌ 처리 시간 초과. 잠시 후 다시 시도")

    pub = call("POST", f"{base}/{uid}/media_publish", {"creation_id": cid, "access_token": tok})
    info = call("GET", f"{base}/{pub['id']}", {"fields": "permalink", "access_token": tok})
    print("✅ 게시 완료:", info.get("permalink", pub["id"]))


if __name__ == "__main__":
    main()
