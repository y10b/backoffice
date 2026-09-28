import { getSettings } from "./db";
import { fetchRelatedKeywords, type SearchAdResult } from "./searchad";
import { geminiCall, geminiKeys, geminiModel } from "./gemini";
import { openaiJson, openaiKey } from "./openai";
import {
  bare,
  foodSettings,
  parseDiscovered,
  saveDiscovered,
  type DiscoveredFood,
} from "./foodTrend";

/**
 * 목록 밖 음식 찾기.
 *
 * `/eat` 은 정해 둔 음식 목록 안에서만 오르는 것을 찾는다. 탕후루처럼 목록에 없던 게
 * 뜨면 못 잡는다. 그래서 매일 한 번 검색광고 연관 키워드를 훑어 **밖에서 사 먹는 음식**
 * 이름만 골라 발견 목록(설정 `food_discovered`)에 넣는다.
 *
 *   시드(목록 + 일반) → 연관 키워드(월 1,000+) → 규칙 정리 → 모델 한 번 → upsert
 *
 * 연관 키워드에는 지역(신림맛집)·레시피(대하구이 만드는법)·브랜드·장소가 섞인다.
 * 규칙으로 걸러지는 건 규칙으로 걸러 모델에 넘기는 양을 줄이고, "이게 음식 이름인가"
 * 같은 판단만 모델에 맡긴다.
 */

/** 음식 목록만으로는 좁다. 요즘 뜨는 게 걸리게 넓은 시드를 같이 넣는다 */
export const GENERAL_FOOD_SEEDS = ["제철음식", "요즘 맛집", "맛집 추천", "디저트 맛집", "술집 안주"];

/** 이보다 적게 찾는 키워드는 유행이라 보기 어렵다 */
const MIN_SEARCHES = 1000;
/** 이 기간 안 보이면 발견 목록에서 뺀다 */
const STALE_DAYS = 14;
/** 모델에 넘기는 후보 상한. 검색수 순으로 자른다 */
const MAX_CANDIDATES = 150;
const HINTS_PER_CALL = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 이 말이 들어가면 먹으러 가는 검색이 아니다 */
const DROP_WORDS = [
  "만드는법", "만들기", "레시피", "칼로리", "효능", "가격", "손질", "보관", "굽는법", "삶는법",
  "끓이는법", "요리법", "영양", "부작용", "시세", "택배", "쇼핑", "밀키트", "원산지", "뜻",
];
/** 끝에 붙는 말. 떼고 남은 게 음식 이름이다 ("새우튀김맛집" → "새우튀김") */
// "집" 은 떼지 않는다. "술집" 이 "술" 이 되고 "홍대술집" 이 "홍대술" 이 된다. "국밥집" 은 모델이 국밥으로 합친다
const STRIP_SUFFIX = /(맛집추천|맛집|추천|근처|배달|포장|메뉴|전문점)$/;
/** 앞에 붙는 동네. "강남역" "성수동" 처럼 역·동으로 끝나는 두 글자 이상 */
const REGION_PREFIX = /^[가-힣]{2,4}(역|동)(?=[가-힣]{2,})/;

export type Candidate = { keyword: string; searches: number; cleaned: string };

/** 규칙 1차 정리. 음식일 수 없는 건 null */
export function cleanKeyword(keyword: string): string | null {
  let k = bare(keyword);
  if (DROP_WORDS.some((w) => k.includes(w))) return null;
  // 접미가 겹쳐 붙는 경우가 있다 ("곱창맛집추천")
  for (let i = 0; i < 3; i++) {
    const next = k.replace(STRIP_SUFFIX, "");
    if (next === k) break;
    k = next;
  }
  k = k.replace(REGION_PREFIX, "");
  if (k.length < 2 || k.length > 10) return null;
  if (/[a-z0-9]/i.test(k)) return null; // 브랜드·모델명·숫자 섞인 건 대개 음식이 아니다
  return k;
}

export function cleanCandidates(rows: { keyword: string; searches: number }[]): Candidate[] {
  const byClean = new Map<string, Candidate>();
  for (const r of rows) {
    if (r.searches < MIN_SEARCHES) continue;
    const cleaned = cleanKeyword(r.keyword);
    if (!cleaned) continue;
    const prev = byClean.get(cleaned);
    if (!prev || prev.searches < r.searches) byClean.set(cleaned, { keyword: r.keyword, searches: r.searches, cleaned });
  }
  return [...byClean.values()].sort((a, b) => b.searches - a.searches).slice(0, MAX_CANDIDATES);
}

/* ------------------------------------------------------------------ *
 * 모델 — "밖에서 사 먹는 음식·메뉴 이름" 만 고른다
 * ------------------------------------------------------------------ */

type PickedFood = { name: string; from: string; searches: number };

function buildPrompt(candidates: Candidate[], known: string[]): string {
  return [
    "너는 한국 외식 트렌드 편집자다. 아래 '후보' 는 네이버 검색 키워드를 정리한 것이다.",
    "이 중 **식당·가게에서 사 먹는 음식이나 메뉴 이름**만 골라라.",
    "",
    "규칙:",
    "- 지역·동네·역 이름만 남은 것(예: 신림, 강남), 가게·브랜드·프랜차이즈 이름, 장소·업종(예: 술집, 카페, 뷔페), 재료만 뜻하는 말, 집에서 해 먹는 요리 검색은 버린다.",
    "- 같은 음식의 변형은 하나로 합쳐 기본 이름으로 적는다 (예: 대하구이·대하소금구이 → 대하). 단 새우튀김처럼 따로 파는 메뉴는 그대로 둔다.",
    "- '이미 있는 목록' 과 같은 음식(변형 포함)은 결과에 넣지 마라.",
    "- name 은 사람들이 검색창에 칠 짧은 이름. from 은 그 음식을 고른 원래 후보 키워드(원문 그대로), searches 는 그 후보의 검색수.",
    "- 요즘 유행하는 메뉴의 줄임말(예: 두쫀쿠=두바이 쫀득 쿠키)도 파는 음식이면 넣는다. 이름은 사람들이 실제로 검색하는 형태(줄임말이면 줄임말) 그대로.",
    "- 확실하지 않으면 넣지 마라. 억지로 채우지 않는다.",
    "",
    `이미 있는 목록: ${known.join(", ")}`,
    "",
    "후보 (원래 키워드 → 정리된 이름 · 월 검색수):",
    ...candidates.map((c) => `- ${c.keyword} → ${c.cleaned} · ${c.searches}`),
    "",
    'JSON 으로만 답하라: { "foods": [{ "name": "", "from": "", "searches": 0 }] }',
  ].join("\n");
}

const FOODS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    foods: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          from: { type: "string" },
          searches: { type: "number" },
        },
        required: ["name", "from", "searches"],
      },
    },
  },
  required: ["foods"],
};

async function askGemini(prompt: string): Promise<PickedFood[]> {
  const payload = await geminiCall(
    await geminiModel(),
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        // gemini 스키마는 additionalProperties 를 받지 않는다
        responseSchema: {
          type: "object",
          properties: {
            foods: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, from: { type: "string" }, searches: { type: "number" } },
                required: ["name", "from", "searches"],
              },
            },
          },
          required: ["foods"],
        },
      },
    },
    { retries: 2 },
  );
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p: { thought?: boolean }) => !p.thought)
    .map((p: { text?: string }) => p.text ?? "")
    .join("");
  const parsed = JSON.parse(text);
  return Array.isArray(parsed?.foods) ? parsed.foods : [];
}

async function askOpenai(prompt: string): Promise<PickedFood[]> {
  const r = await openaiJson<{ foods: PickedFood[] }>({
    user: prompt,
    schema: FOODS_SCHEMA,
    schemaName: "discovered_foods",
    maxTokens: 8000,
    retries: 2,
  });
  return Array.isArray(r?.foods) ? r.foods : [];
}

/** Gemini 먼저, 없거나 실패하면 OpenAI. devlog 의 askModel 과 같은 순서다 */
async function pickFoods(prompt: string): Promise<PickedFood[]> {
  const errors: string[] = [];
  if ((await geminiKeys()).length) {
    try {
      return await askGemini(prompt);
    } catch (e) {
      errors.push(`Gemini: ${(e as Error).message.slice(0, 150)}`);
    }
  }
  if (await openaiKey()) {
    try {
      return await askOpenai(prompt);
    } catch (e) {
      errors.push(`OpenAI: ${(e as Error).message.slice(0, 150)}`);
    }
  }
  throw new Error(errors.length ? errors.join(" / ") : "Gemini·OpenAI 키가 모두 없어 음식을 고르지 못했습니다.");
}

/* ------------------------------------------------------------------ *
 * 실행
 * ------------------------------------------------------------------ */

export type DiscoverResult = {
  /** 이번에 모델이 고른 음식 수 */
  found: number;
  /** 그중 발견 목록에 처음 들어간 수 */
  added: number;
  /** 저장 후 발견 목록 전체 수 */
  total: number;
  foods: { name: string; from: string; searches: number }[];
  errors: string[];
};

export type DiscoverOptions = {
  /** 연관 키워드 조회를 바꿔 끼운다 (검색광고 자격증명이 없는 로컬 검증용) */
  related?: (seeds: string[]) => Promise<SearchAdResult>;
  /** 저장하지 않고 결과만 본다 */
  dryRun?: boolean;
};

export async function discoverFoods(o: DiscoverOptions = {}): Promise<DiscoverResult> {
  const related = o.related ?? fetchRelatedKeywords;
  const s = await foodSettings();
  const errors: string[] = [];

  /* 1. 연관 키워드 */
  const seeds = [...s.seeds, ...GENERAL_FOOD_SEEDS];
  const rows: { keyword: string; searches: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < seeds.length; i += HINTS_PER_CALL) {
    if (i > 0) await sleep(1000);
    const r = await related(seeds.slice(i, i + HINTS_PER_CALL));
    if (!r.ok) {
      errors.push(r.error ?? "연관 키워드 조회 실패");
      // 자격증명이 없거나 틀렸으면 나머지 묶음도 같은 답이다
      if (r.status === 0 || r.status === 401 || r.status === 403) break;
      continue;
    }
    for (const k of r.keywords) {
      const b = bare(k.keyword);
      if (k.totalSearches === null || seen.has(b)) continue;
      seen.add(b);
      rows.push({ keyword: k.keyword, searches: k.totalSearches });
    }
  }
  if (!rows.length) throw new Error(errors[0] ?? "연관 키워드가 없습니다.");

  /* 2. 규칙 정리 — 이미 목록에 있거나 뺀 것은 모델에 넘기지도 않는다 */
  const known = new Set([...s.seeds, ...s.excluded].map(bare));
  const candidates = cleanCandidates(rows).filter((c) => !known.has(c.cleaned));
  if (!candidates.length) return save([], s.excluded, o.dryRun, errors);

  /* 3. 모델 한 번 */
  const picked = await pickFoods(buildPrompt(candidates, [...s.seeds, ...s.excluded]));

  // 모델이 준 검색수보다 원래 키워드의 검색수를 믿는다. 같은 이름으로 합쳐진 건 큰 값
  const searchesOf = new Map(candidates.map((c) => [bare(c.keyword), c.searches]));
  const foods = new Map<string, PickedFood>();
  for (const p of picked) {
    const name = String(p?.name ?? "").trim();
    if (!name || known.has(bare(name))) continue;
    const searches = searchesOf.get(bare(String(p.from ?? ""))) ?? (Number(p.searches) || 0);
    if (searches < MIN_SEARCHES) continue;
    const prev = foods.get(bare(name));
    if (!prev || prev.searches < searches) foods.set(bare(name), { name, from: String(p.from ?? ""), searches });
  }

  return save([...foods.values()], s.excluded, o.dryRun, errors);
}

async function save(
  foods: PickedFood[],
  excluded: string[],
  dryRun: boolean | undefined,
  errors: string[],
): Promise<DiscoverResult> {
  const now = new Date().toISOString();
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const raw = await getSettings(["food_discovered"]);
  const skip = new Set(excluded.map(bare));
  const byName = new Map(parseDiscovered(raw.food_discovered).map((d) => [bare(d.name), d]));

  let added = 0;
  for (const f of foods) {
    const key = bare(f.name);
    if (skip.has(key)) continue;
    const prev = byName.get(key);
    if (prev) {
      byName.set(key, { ...prev, searches: f.searches, lastSeen: now, seenCount: prev.seenCount + 1 });
    } else {
      added += 1;
      byName.set(key, { name: f.name, searches: f.searches, firstSeen: now, lastSeen: now, seenCount: 1 });
    }
  }

  const list: DiscoveredFood[] = [...byName.values()]
    .filter((d) => !skip.has(bare(d.name)))
    .filter((d) => {
      const t = Date.parse(d.lastSeen);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => b.searches - a.searches);

  if (!dryRun) await saveDiscovered(list);
  return { found: foods.length, added, total: list.length, foods, errors };
}
