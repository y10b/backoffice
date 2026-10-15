"""예시 대본: 여자화장실 착각 썰 ('화장실 보스전' 버전, 약 62초).
렌더: python3 ../scripts/render.py toilet_boss.py --out OUTDIR
"""
NAME = "여자화장실_썰_보스전"
TITLE = "🚻 여자화장실 착각 썰"
COVER_AT = (0, 1)  # 커버 = 0번 장면 1번 대사 직전 화면

SCRIPT = [
    # ── 훅: 결말 + 보스전 프레이밍
    dict(pal=RED, cap_y=1300, visuals=[(0, lambda bt: (lambda tl: eyes_img(tl + 0.6)), W // 2, 860, "pop", None),
                                      (1, boss_bar(), W // 2, 520, "slideL", "whoosh")], beats=[
        ("썸녀 만나기 1분 전, 여자화장실에서 보스를 만났어요.", "talk", ["썸녀 만나기 [p:1분 전]", "[r:여자화장실에서 보스 만남]"],
         dict(sfx="boom", shake=22, flash=(255, 40, 40), size=92)),
        ("보스 이름은, 화장실 아주머니.", "smug", "보스: [r:화장실 아주머니] 👵", dict()),
    ]),
    dict(pal=DARK, cap_y=900, rewind=True, visuals=[], beats=[
        ("어쩌다 이렇게 됐냐면요.", "smug", "⏪ [y:10분 전]", dict(sfx="rewind", size=140, gap=0.2)),
    ]),
    # ── 썸녀 지각: 겉 vs 속
    dict(pal=NAVY, cap_y=1320, visuals=[(0, phone_from([(0, 0.4, "L", "미안ㅠㅠ 1시간 늦을 듯"), (0, 1.6, "R", "괜찮아~ 천천히 와 😊")]), W // 2, 820, "slideup", "whoosh")], beats=[
        ("썸녀가 1시간 늦는대서, 쿨하게 괜찮다고 했죠.", "talk", "겉: [c:괜찮아~ 천천히 와] 😊", dict(sfx="ding")),
        ("속으로는, 1시간??!!", "yell", "속: [r:1시간??!!] 🤯", dict(shake=16)),
    ]),
    # ── 퀘스트 발생
    dict(pal=TEAL, cap_y=1300, visuals=[(1, quest_banner(), W // 2, 760, "pop", "boom")], beats=[
        ("역을 어슬렁거리는데, 배에서 신호가 와요.", "talk", "역에서 어슬렁... 꾸르륵 🌀", dict()),
        ("긴급 퀘스트! 화장실을 찾아라!", "yell", "[r:긴급 상황] 🚨", dict(shake=24, flash=(255, 160, 40))),
    ]),
    # ── 표시 = 테트리스
    dict(pal=NAVY, cap_y=1260, visuals=[(0, sign_img("A"), 330, 780, "slideL", "whoosh"), (0, sign_img("B"), 750, 780, "slideR", None),
                                       (1, text_img("?", size=150, default="y"), 330, 560, "pop", None),
                                       (1, text_img("?", size=150, default="y"), 750, 560, "pop", None)], beats=[
        ("화장실 찾았는데 표시가,", "talk", "화장실 찾았는데 표시가...", dict()),
        ("아니 쌰갈!!!", "scream", ["아니 [r:쌰갈!!!!!!]"], dict(sfx="boom", size=150, shake=34, flash=(255, 40, 40))),
        ("이건 표시가 아니라 테트리스잖아요!", "rap", "이건 표시가 아니라 [y:테트리스] 🧱", dict(shake=10)),
        ("몰라요! 급해요! 50% 확률에 인생 걸었어요!", "rap", "[y:50% 확률]에 인생 걸기 🎲", dict(sfx="whoosh", shake=12)),
    ]),
    # ── IQ 하락
    dict(pal=TEAL, cap_y=1020, visuals=[(0, emoji_img("🚽", 280), W // 2, 640, "pop", None)], beats=[
        ("근데 소변기가 없네?", "smug", "어...? [y:소변기가 없네?]", dict()),
        ("여기서 제 IQ가 떨어져요.", "deadpan", "🧠 IQ [r:-50] 📉", dict(sfx="boom")),
        ("뭐, 그럴 수 있지~", "chill", "[c:뭐... 그럴 수 있지~] 😌", dict(gap=0.3)),
    ]),
    # ── 보스 등장
    dict(pal=DARK, cap_y=1340, visuals=[(0, lambda bt: (lambda tl: mirror_img("😌" if tl < bt[2] else "😳")), W // 2, 800, "pop", "whoosh")], beats=[
        ("여유롭게 손 씻는데,", "chill", "여유롭게 손 씻는 중 🎶", dict()),
        (None, None, "[g:끼이익...] 🚪", dict(sfx="creak", shake=12, dur=0.9, size=110)),
        ("흐음...?", "ajumma", "[r:보스 등장]: \"흐음...?\"", dict(sfx="boom", shake=16, gap=0.25)),
    ]),
    dict(pal=RED, cap_y=1240, visuals=[(0, lambda bt: (lambda tl: eyes_img(tl)), W // 2, 800, "pop", None), (0, boss_bar(), W // 2, 470, "pop", None)], beats=[
        ("아. 여기, 여자화장실이구나.", "deadpan", ["아...", "[r:여기 여자화장실이구나]"], dict(sfx="boom", shake=24, flash=(255, 30, 30), gap=0.35, size=100)),
    ]),
    # ── 선택지
    dict(pal=NAVY, cap_y=480, visuals=[(0, choice_menu(
            ["1. 도망간다 ➡️ [r:범인 확정]", "2. 사과한다 ➡️ [r:자백]", "3. [y:아무 일 없는 척]"]), W // 2, 960, "pop", "whoosh")], beats=[
        ("머릿속에 선택지가 떴어요.", "talk", "머릿속에 [c:선택지] 등장", dict()),
        ("1번 도망. 범인 확정.", "rap", "도망가면 [r:범인 확정]", dict()),
        ("2번 사과. 그건 자백.", "rap", "사과하면 [r:자백]", dict()),
        ("3번. 아무 일 없는 척.", "smug", "정답: [y:아무 일 없는 척] ✨", dict(sfx="ding", gap=0.3)),
    ]),
    # ── 연기
    dict(pal=NAVY, cap_y=860, visuals=[(1, emoji_img("🏆", 240), W // 2, 1240, "pop", "ding")], beats=[
        ("이미 깨끗한 손 한 번 더 씻고, 평소엔 안 하는 앞머리 정리까지.", "talk", ["✅ 손 한 번 더 씻기 [g:(이미 깨끗함)]", "✅ 앞머리 정리 [g:(평소엔 안 함)]"], dict(size=70)),
        ("이건 연기대상감이에요.", "yell", "[y:연기대상] 수상 각 🎬", dict(shake=10)),
    ]),
    dict(pal=DARK, cap_y=1100, visuals=[(0, lambda bt: (lambda tl: eyes_img(tl, stare=True)), W // 2, 700, "pop", None)], beats=[
        ("보스의 레이저 스캔 결과는...", "tense", "🔍 보스가 스캔 중...", dict()),
        ("수상하지만 통과!", "smug", "결과: [r:수상함] 그러나 [c:통과] ✅", dict(sfx="ding")),
    ]),
    # ── 탈출 + 디자이너 소환
    dict(pal=TEAL, cap_y=1200, visuals=[(0, sign_img("A", 260), 360, 760, "slideL", "whoosh"), (0, sign_img("B", 260), 720, 760, "slideR", None)], beats=[
        ("탈출해서 표시 다시 봤는데, 다시 봐도 모르겠어요!!", "yell", "다시 봐도 [r:모르겠어요!!]", dict(shake=16)),
        ("디자이너님, 제발 한글로 써 주세요!!", "plead", "디자이너님 [y:한글로] 써주세요 🙏", dict(gap=0.25)),
    ]),
    # ── 1분 뒤
    dict(pal=NAVY, cap_y=1300, visuals=[(1, phone_from([(1, 0.0, "L", "나 도착했어~!")], h=480, start=1), W // 2, 800, "slideup", None)], beats=[
        ("그리고 딱 1분 뒤,", "smug", "그리고 [y:딱 1분 뒤]", dict()),
        ("나 도착했어~!", "she", "썸녀 [p:도착] 💘", dict(sfx="ding")),
        ("1분만 빨랐으면, 썸 끝. 인생 끝.", "deadpan", ["1분만 빨랐으면", "[r:썸 끝. 인생 끝.] 😱"], dict(sfx="boom", shake=18)),
    ]),
    # ── 다음 썰 예고
    dict(pal=NAVY, cap_y=520, visuals=[(0, teaser_card(["그 후로", "[r:썸 깨진 썰] 💔"]), W // 2, 930, "pop", "whoosh"), (1, follow_btn(), W // 2, 1300, "pop", None)], beats=[
        ("근데 그 썸, 결국 깨졌어요.", "deadpan", "근데 그 썸... [r:결국 깨짐] 💔", dict(gap=0.2)),
        ("이유는 다음 썰에서. 궁금하면 팔로우!", "yell", "궁금하면 [y:팔로우] 👆", dict(sfx="ding", gap=0.6)),
    ]),
]
