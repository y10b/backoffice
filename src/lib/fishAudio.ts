import { getSettings } from "./db";

/**
 * Fish Audio — 썰 릴스의 한국어 음성.
 *
 * Azure 보다 목소리가 많고(한국어 공개 목소리 약 1,000개), 쇼츠·썰 화자에게서 온 목소리가 많아
 * 구어체가 자연스러울 가능성이 크다. 대신 한국어는 공식 2등급 지원이라 발음이 가끔 흔들리고,
 * 샘플링 방식이라 같은 문장도 매번 조금씩 다르게 나온다 — 그래서 줄마다 다시 만들 수 있게 한다.
 *
 * 예전 영상 갈래에서도 붙였지만 실제 호출은 못 해 봤다(DEVLOG 13장). 이번에 다시 쓴다.
 *
 * 모델:
 *   s2.1-pro-free  무료, 2026-11-30 종료 예고. 약관상 무료 사용자는 비상업 용도라 수익 계정엔 애매하다
 *   s2.1-pro       UTF-8 100만 바이트당 $15. 한글은 글자당 3바이트라 썰 한 편(400자)이 약 $0.02
 */

const API = "https://api.fish.audio";
export const FISH_MODELS = ["s2.1-pro-free", "s2.1-pro", "s2-pro"] as const;
export const DEFAULT_FISH_MODEL = "s2.1-pro-free";

export async function fishCreds(): Promise<{ apiKey: string; model: string } | null> {
  const s = await getSettings(["fish_api_key", "fish_model"]);
  const apiKey = s.fish_api_key || process.env.FISH_API_KEY || "";
  if (!apiKey) return null;
  return { apiKey, model: s.fish_model || process.env.FISH_MODEL || DEFAULT_FISH_MODEL };
}

/** Fish 목소리 ID 는 32자리 16진수다. 요청으로 들어온 값이 이 꼴이 아니면 쓰지 않는다 */
export const isFishVoiceId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);

/** 한 줄 → mp3. 속마음은 속삭이듯 작게 */
export async function fishSpeak(o: { text: string; voice: string; think?: boolean }): Promise<ArrayBuffer> {
  const creds = await fishCreds();
  if (!creds) throw new Error("Fish Audio API 키가 없습니다. 설정 화면에서 등록하세요.");

  const res = await fetch(`${API}/v1/tts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creds.apiKey}`,
      "content-type": "application/json",
      // 모델은 바디가 아니라 헤더로 간다. 바디에 넣으면 조용히 무시된다
      model: creds.model,
    },
    body: JSON.stringify({
      // 감정 태그([whispering])가 한국어 문장에도 먹는지는 확인 전이다. 안 먹어도 볼륨으로 속마음 티는 난다
      text: o.think ? `[whispering] ${o.text}` : o.text,
      reference_id: o.voice,
      format: "mp3",
      mp3_bitrate: 128,
      // 쇼츠 TTS 는 1.1~1.2배가 표준이다. 편집툴에서 배속하면 소리가 뭉개지니 엔진에서 빠르게 만든다
      prosody: { speed: 1.2, volume: o.think ? -6 : 0 },
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const raw = await res.text();
    let detail = raw.slice(0, 200);
    try {
      detail = JSON.parse(raw)?.message ?? detail;
    } catch {
      /* 원문 유지 */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? " API 키를 확인하세요."
        : res.status === 402
          ? ` 잔액이 없습니다. fish.audio 에서 API 잔액을 충전하거나 설정에서 모델을 ${DEFAULT_FISH_MODEL} 로 바꾸세요.`
          : res.status === 429
            ? " 요청이 몰렸습니다. 잠시 뒤 다시 하세요."
            : res.status === 503
              ? " Fish Audio 가 붐빕니다. 잠시 뒤 다시 하세요."
              : "";
    throw new Error(`Fish Audio 오류 (HTTP ${res.status}).${hint} ${detail}`);
  }
  const audio = await res.arrayBuffer();
  if (!audio.byteLength) throw new Error("Fish Audio 가 빈 음성을 돌려줬습니다. 다시 시도하세요.");
  return audio;
}

/**
 * 실존 인물 클론으로 보이는 목소리. 인기 목록 상위에 연예인·정치인 무단 클론이 섞여 있다
 * (2026-09 조사: 아이돌, 대통령, 아나운서 등). 그런 목소리로 수익 콘텐츠를 만들면 퍼블리시티권
 * 분쟁 위험이 있고, 모델이 예고 없이 지워지기도 한다. 이름으로 걸리는 것은 목록에서 뺀다.
 * 완벽하지 않다 — 평범한 제목의 무단 클론은 못 거른다. 가장 안전한 건 내 목소리 클론이다.
 */
const REAL_PERSON =
  /대통령|의원|장관|아나운서|앵커|기자|연예인|유명인|아이돌|가수|배우|모창|성대모사|클론|clone|aespa|에스파|카리나|karina|윈터|winter|닝닝|지젤|블랙핑크|blackpink|지수|jisoo|제니|jennie|로제|리사|뉴진스|newjeans|해린|haerin|하니|민지|다니엘|혜인|아이브|ive|장원영|원영|wonyoung|안유진|레이|bts|방탄|태형|taehyung|정국|jungkook|슈가|아이유|iu|노무현|문재인|박근혜|이명박|윤석열|이재명|김정은|트럼프|trump|손정은|유재석|강호동|침착맨|김종국|이효리|아이유|수지|박보검|차은우|손흥민/i;

/**
 * 이름 대신 **특징으로 설명된** 목소리만 남긴다("20대 여자_나긋나긋 쇼츠", "차분한 내레이션").
 * 막을 이름을 나열하는 방식은 끝이 없었다 — 실제로 목록에 애니 캐릭터·게임 아나운서·아이돌
 * 클론이 섞여 나왔다. 사람·캐릭터 이름이 제목인 목소리는 이 규칙으로 저절로 빠진다.
 */
const DESCRIPTIVE =
  /여자|남자|여성|남성|여대생|남대생|학생|목소리|보이스|내레이션|나레이션|해설|쇼츠|숏츠|썰|차분|나긋|밝은|발랄|중저음|저음|낮은|높은|20대|30대|40대|50대|아저씨|아줌마|할머니|할아버지|청년|직장인|오디오북|낭독|유튜브|유툽/;

export type FishVoice = { id: string; title: string; uses: number; tags: string[] };

/**
 * 한국어 공개 목소리. 많이 쓰인 순. 한글 제목 + 특징 설명 + 실존 인물 아님, 셋 다 맞아야 남는다.
 * 설명형 목소리가 드물어 두 쪽(200개)을 훑는다.
 */
export async function fishVoices(query = ""): Promise<FishVoice[]> {
  const creds = await fishCreds();
  const out: FishVoice[] = [];
  for (const page of [1, 2]) {
    const url = new URL(`${API}/model`);
    url.searchParams.set("language", "ko");
    url.searchParams.set("sort_by", "task_count");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("page_number", String(page));
    if (query.trim()) url.searchParams.set("title", query.trim());
    const res = await fetch(url, {
      headers: creds ? { authorization: `Bearer ${creds.apiKey}` } : {},
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`목소리 목록을 받지 못했습니다 (HTTP ${res.status}).`);
    const data = (await res.json()) as { items?: Record<string, unknown>[] };
    const items = data.items ?? [];
    for (const m of items) {
      const v = {
        id: String(m._id ?? ""),
        title: String(m.title ?? "").trim(),
        uses: Number(m.task_count ?? 0),
        tags: Array.isArray(m.tags) ? (m.tags as unknown[]).map(String) : [],
      };
      if (!isFishVoiceId(v.id) || !/[가-힣]/.test(v.title)) continue;
      if (REAL_PERSON.test(v.title) || v.tags.some((t) => REAL_PERSON.test(t))) continue;
      // 검색어를 줬으면 사람이 이름으로 찾는 것이다. 설명형 규칙은 목록을 둘러볼 때만 건다
      if (!query.trim() && !DESCRIPTIVE.test(v.title)) continue;
      out.push(v);
    }
    if (items.length < 100) break;
  }
  return out;
}
