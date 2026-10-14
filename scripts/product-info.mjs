/**
 * 트렌드로 고른 상품군의 "정보·비교 글" 을 만들어 네이버에 올린다. 매일 루틴이 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/product-info.mjs draft [--keyword 전기요]      글만 만들어 출력
 *   node --import ./scripts/ts-register.mjs scripts/product-info.mjs run [--keyword X] [--private] [--dry-run]
 *
 *   데이터랩 검색어트렌드로 오르는 상품 키워드 → 하이마트 검색 상위 상품 3개(이름·가격·주소)
 *   → Gemini 로 정보·비교 글 → naver-publish 의 publishPost (세시간전 링크·AI 이미지·카테고리)
 *
 * 후기가 아니다. 써 보지 않은 제품을 써 본 것처럼 쓰면 기만 광고이고 세시간전 정산 환수 사유다.
 * 그래서 1인칭 사용 표현은 프롬프트로 막고, 나온 글을 정규식으로 한 번 더 걸러 걸리면 올리지 않는다.
 * 상품 설명은 상품명에 적힌 것과 가격만 쓴다 — 상세페이지를 읽지 않았으니 기능을 지어내면 안 된다.
 *
 * 판매처는 롯데하이마트 하나다. 세시간전에서 승인 없이 링크가 되고, 클라우드에서 검색이 열린다
 * (Gmarket 403, 오늘의집 Access Denied, 2026-10-14 확인).
 */
import { createRequire } from "node:module";
import { getSetting, setSetting } from "../src/lib/db.ts";
import { geminiCall, geminiModel, parseGrounding } from "../src/lib/gemini.ts";
import { markdownToHtml } from "../src/lib/markdown.ts";
import { productTrends } from "../src/lib/productTrend.ts";
import { disclosureText } from "../src/lib/shopLinks.ts";
import { ANTI_AI, PERSONA } from "../src/lib/visit.ts";
import { publishPost } from "./naver-publish.mjs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const [cmd] = args.filter((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** 하이마트가 파는 상품군만 */
const TREND_CATEGORIES = ["living", "digital"];
/** 같은 키워드를 다시 쓰지 않는 기간 */
const REUSE_DAYS = 30;
const HISTORY_KEY = "naver_info_history";
/** 정보 글 카테고리. 블로그에 없으면 naver-publish 가 상품 기본 카테고리로 넘어간다 */
const INFO_CATEGORY = process.env.NAVER_INFO_CATEGORY || "쇼핑 정보";

/** 써 본 척하는 문장. 하나라도 있으면 올리지 않는다 */
const FIRST_PERSON =
  /써\s?보니|써\s?봤|써\s?본\s?결과|사용해\s?보니|사용해\s?봤|직접\s?(써|사용|구매|사)|제가\s?(써|사용|구매|샀)|구매했|샀는데|샀어요|내돈내산|실사용|한\s?달\s?(써|사용)|몇\s?주\s?(써|사용)/;
/** 결과를 보장하거나 과장하는 말 */
const HYPE = /무조건|100\s?%|최저가|완벽한|역대급|인생템|필수템|강력\s?추천/;

const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function loadPlaywright() {
  for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) {
    try {
      return require(p);
    } catch {
      /* 다음 후보 */
    }
  }
  throw new Error("playwright 를 찾지 못했습니다.");
}

async function history() {
  try {
    return JSON.parse((await getSetting(HISTORY_KEY)) || "[]");
  } catch {
    return [];
  }
}

/** 최근 4주 검색량이 가장 많이 오른, 최근에 안 쓴 키워드 */
async function pickKeyword() {
  const since = Date.now() - REUSE_DAYS * 86400000;
  const used = new Set((await history()).filter((h) => Date.parse(h.date) >= since).map((h) => h.keyword));
  const all = [];
  for (const key of TREND_CATEGORIES) {
    const r = await productTrends(key);
    for (const e of r.errors) console.log(`- 트렌드 경고(${key}): ${e.slice(0, 80)}`);
    all.push(...r.trends);
  }
  const pick = all
    .filter((t) => typeof t.delta === "number" && t.delta > 0 && !used.has(t.food))
    .sort((a, b) => b.delta - a.delta)[0];
  if (!pick) throw new Error("오르는 상품 키워드가 없습니다(최근에 쓴 키워드 제외).");
  return { keyword: pick.food, delta: Math.round(pick.delta) };
}

/** 하이마트 검색 상위 상품. 가격이 읽히는 것만 */
async function himartProducts(browser, keyword, n = 3) {
  const ctx = await browser.newContext({
    locale: "ko-KR",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.e-himart.co.kr/app/search/totalSearch?query=${encodeURIComponent(keyword)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator(".product__item").first().waitFor({ timeout: 20000 });
    const items = await page.evaluate(() =>
      [...document.querySelectorAll(".product__item")].map((li) => {
        const a = li.querySelector("a[href*='goodsDetail?goodsNo=']");
        const text = li.innerText.replace(/\s+/g, " ").trim();
        // 마지막 "N 원" 이 실제 판매가(앞의 것은 정가·할인 전)
        const prices = [...text.matchAll(/([\d,]{4,})\s*원/g)].map((m) => Number(m[1].replace(/,/g, "")));
        return { url: a ? new URL(a.getAttribute("href"), location.origin).href.split("&")[0] : "", text, price: prices.at(-1) ?? 0 };
      }),
    );
    const seen = new Set();
    const picked = [];
    for (const i of items) {
      if (!i.url || !(i.price > 0) || seen.has(i.url)) continue;
      seen.add(i.url);
      // 할인율·배송·보증 문구를 걷어낸 상품명. "일월 일월 …" 처럼 브랜드가 두 번 붙는 것도 하나로
      const name = i.text
        .replace(/\d+\s*%\s*(할인)?/g, "")
        .replace(/[\d,]{4,}\s*원.*$/, "")
        .replace(/최대\s*\d+년\s*보증|가전보험 가능|사용자 별점.*$/g, "")
        .replace(/(\S+?)_?(\s+\1_?)+(?=\s|$)/g, "$1")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      // 같은 모델의 1+1·색상 변형은 비교 대상이 아니다 — 낱말이 절반 넘게 겹치면 건너뛴다
      const words = new Set(name.replace(/1\+1|\[[^\]]*\]|[()]/g, " ").split(/\s+/).filter((w) => w.length > 1));
      const dup = picked.some((p) => {
        const common = [...words].filter((w) => p.words.has(w)).length;
        return common / Math.min(words.size, p.words.size) > 0.5;
      });
      if (!dup) picked.push({ url: i.url, price: i.price, name, words });
      if (picked.length >= n) break;
    }
    return picked.map(({ words, ...p }) => p);
  } finally {
    await ctx.close();
  }
}

/**
 * 1패스 조사. 상품군을 고를 때 실제로 갈리는 기준(방식 차이, 안전 인증, 전기료, 관리, 흔한 실수)을
 * 구글 검색으로 모은다. 이게 없으면 "세탁 여부·크기" 같은 누구나 아는 말만 나온다.
 * 실패하면 null — 글은 조사 없이도 나오되 기준 섹션이 얇아진다.
 */
async function research(keyword) {
  const text = [
    `"${keyword}" 를 사려는 사람에게 고르는 법을 알려 주는 블로그 글을 쓰려 한다. 구글 검색으로 사실만 조사하라. 글은 쓰지 마라.`,
    "",
    "조사할 것:",
    `- ${keyword} 의 종류·방식 차이(예: 열선·탄소·온수, 가열식·초음파식처럼 그 상품군에서 실제로 갈리는 것)와 각각 어떤 사람에게 맞는지`,
    "- 안전 관련 인증·표시(KC 인증, 전자파 인증 등 그 상품군에 해당하는 것)와 확인하는 법",
    "- 소비전력과 전기료 감 잡는 법(가능하면 공식 단가 기준 계산 예), 관리·세탁·보관 주의점",
    "- 사람들이 살 때 자주 하는 실수, 가격대별로 대체로 무엇이 달라지는지",
    "",
    "- 특정 제품 후기·감상 문장은 가져오지 마라. 일반적인 사실·기준만.",
    "- 확인되지 않은 수치는 쓰지 마라. 수치에는 출처 기관이나 기준 연도를 붙여라.",
    "- 출력은 마크다운 불릿만. 서론·결론 없이 한 줄씩, 15줄 안팎.",
  ].join("\n");
  try {
    const r = parseGrounding(
      await geminiCall(await geminiModel(), {
        contents: [{ role: "user", parts: [{ text }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
    );
    if (r.text?.trim()) return r.text.trim();
  } catch (e) {
    // 구글 검색 그라운딩은 무료 쿼터가 작고 티스토리 초안 생성과 나눠 쓴다
    console.log(`- Gemini 조사 실패: ${String(e.message ?? e).slice(0, 60)} — OpenAI 웹 검색으로`);
  }
  return openaiResearch(text);
}

/** OpenAI Responses API 웹 검색으로 같은 조사를 한다. 1분 남짓 걸린다 */
async function openaiResearch(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.OPENAI_RESEARCH_MODEL || "gpt-5-mini", tools: [{ type: "web_search" }], input: text }),
      signal: AbortSignal.timeout(180000),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d?.error?.message || `HTTP ${res.status}`);
    const out = (d.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("\n")
      // 출처 링크는 기관 이름만 남긴다 — 글에 주소를 옮겨 적지 않게
      .replace(/\(\[([^\]]+)\]\([^)]+\)\)/g, "($1)")
      .trim();
    return out || null;
  } catch (e) {
    console.log(`- 조사 실패, 조사 없이 씀: ${String(e.message ?? e).slice(0, 80)}`);
    return null;
  }
}

/**
 * 검수. 다 쓴 글에서 근거 없는 상품 주장(상품명 낱말을 성능으로 푼 것)과 나열 템플릿만 고친다.
 * 생성 프롬프트로 막아도 모델은 "세미마이크로 원단이라 부드럽게 접힌다" 식으로 풀어 버린다.
 */
async function review(d, products) {
  const text = [
    "아래 네이버 블로그 정보 글의 bodyMarkdown 을 검수해 고친 전체를 JSON 으로 돌려줘.",
    "",
    "상품별 근거(이것만 사실이다):",
    ...products.map((p, i) => `- 상품 ${i + 1}: ${p.name} / ${p.price.toLocaleString("ko-KR")}원`),
    "",
    "고칠 것만 고친다:",
    "1. 상품에 대해 감촉·성능·소음·내구성·따뜻함 같은 **사용감을 단정한 문장**만 고친다.",
    "   예) '세미마이크로 원단이라 부드럽고 잘 접혀요' → '세미마이크로 원단이라고 적혀 있어요. 원단 촉감이 중요하면 상세페이지를 한 번 보세요'",
    "   상품명에 적힌 특징을 앞의 고르는 기준과 잇는 문장은 그대로 둔다(예: '워셔블 표기라 세탁 기준에선 편한 쪽이에요').",
    "   '상품명에 ~ 표기' 같은 말을 상품마다 반복하지 않는다. 한 상품에 한 번이면 충분하다.",
    "2. 나열·정리 말(첫째·둘째·셋째·마지막으로·결론적으로)과 상투어(꿀팁·총정리·알아보겠습니다·살펴보겠습니다·",
    "   정리해 드릴게요·소개해 드릴게요·오늘은 ~해 드릴게요·도움이 되셨길)를 빼고 자연스럽게 잇는다.",
    "3. 써 봤다·샀다·실사용 같은 경험 표현이 있으면 지운다.",
    "그 밖의 문장·구조·소제목·표·이모지·{{link:N}} 자리는 그대로 둔다. 새 내용을 더하지 않는다.",
    "**줄바꿈은 원문 그대로 지킨다** — 한 줄에 한 문장, 빈 줄도 그대로.",
    "",
    "bodyMarkdown:",
    d.bodyMarkdown,
  ].join("\n");
  try {
    const res = await geminiCall(await geminiModel(), {
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: { bodyMarkdown: { type: "string" }, changes: { type: "array", items: { type: "string" } } },
          required: ["bodyMarkdown", "changes"],
        },
      },
    });
    const r = JSON.parse(res?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
    // 검수가 글을 통째로 줄여 버리면 쓰지 않는다
    if (!r.bodyMarkdown || r.bodyMarkdown.length < d.bodyMarkdown.length * 0.7) return d;
    for (const c of r.changes ?? []) console.log(`- 검수: ${String(c).slice(0, 100)}`);
    return { ...d, bodyMarkdown: r.bodyMarkdown };
  } catch (e) {
    console.log(`- 검수 실패, 그대로 씀: ${String(e.message ?? e).slice(0, 80)}`);
    return d;
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    bodyMarkdown: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "bodyMarkdown", "tags"],
};

const man = (n) => `${Math.floor(n / 10000)}만원대`;

/**
 * 글쓰기 프롬프트.
 *
 * 구조는 네이버 "OO 추천" 상위 글 24편(전기요·가습기·무선청소기, 2026-10-14)을 열어 본 공통점이다.
 * 그중 비교·정보형 12편: 제목에 대상·TOP N·가격대 범위, 상품 소제목을 상황 훅("침대가 좁다면")으로
 * 시작, "검색 당시 가격", 한눈에 비교 표, 살 때 체크 섹션, 질문형 소제목, 한 줄 15자 안팎의 짧은 줄,
 * 끝에 사람 말투 한 줄과 해시태그. 페르소나·AI 티 금지는 /visit 글(visit.ts)과 같은 것을 쓴다.
 */
function prompt(keyword, delta, products, facts) {
  const prices = products.map((p) => p.price);
  const range = `${man(Math.min(...prices))}부터 ${man(Math.max(...prices))}까지`;
  return `네이버 블로그에 올릴 **"${keyword}" 추천·비교 정보 글**을 쓴다. 독자는 지금 ${keyword} 를 살까 말까,
뭘 살까 고민하는 사람이다. 이 글을 다 읽으면 "나는 이걸 사면 되겠다" 가 정해져야 한다.

# 글쓴이 (페르소나 — 말투와 관점만 빌린다)
${PERSONA}

# 이건 후기가 아니다 (가장 중요)
- 글쓴이는 이 제품들을 써 보지 않았고 사지도 않았다. "써 보니", "사용해 보니", "샀어요", "내돈내산", "실사용",
  "직접 써 본", "알아보다가 샀다" 같은 경험·구매 표현을 **한 번도** 쓰지 않는다. 지어낸 사용담은 표시광고법 위반이다.
- 관점은 "자취방 기준으로 따져 보면", "원룸이면 이게 편해요" 처럼 **고르는 기준**으로 말한다.
- 상품 설명은 아래 상품명에 적힌 낱말(용량·크기·구성·기능 이름)과 가격만 근거로 쓴다. 상품명 낱말의 뜻을 추측해
  '부드럽다'·'따뜻하다'·'튼튼하다' 같은 성능으로 풀지 않는다. 평점·후기·판매량을 지어내지 않는다.
- 과장·보장 금지: 무조건, 100%, 최저가, 역대급, 인생템, 필수템, 강력 추천.

# 재료
- 네이버 데이터랩: 최근 4주 "${keyword}" 검색 관심도 ${delta}% 상승 (${today()} 확인)
${products.map((p, i) => `- 상품 ${i + 1}: ${p.name} / 롯데하이마트 판매가 ${p.price.toLocaleString("ko-KR")}원 (${today()} 기준)`).join("\n")}
${facts ? `\n# 조사된 사실 (구글 검색 — 기준 섹션은 이것으로 채운다. 여기 없는 수치는 쓰지 않는다)\n${facts}\n` : "\n# 조사된 사실\n(없음 — 수치 없이 일반적인 고르는 기준만 짧게)\n"}
# 글의 흐름 (상위 노출 비교 글들의 공통 구조)
1. **도입 3~5줄** — 검색 관심도 ${delta}% 상승이나 계절·상황으로 '지금 볼 이유' 를 훅으로. 짧은 문장으로 시작.
   "오늘은 ~를 소개해 드릴게요" 로 시작하지 않는다.
2. \`## ${keyword} 고르기 전에 이것부터\` 같은 **질문형·장면형 소제목**으로 고르는 기준 3~4개.
   조사된 사실(방식 차이·인증·전기료·관리)을 쉬운 말로. 이 섹션이 글의 신뢰를 만든다. 가장 길게.
3. 상품 ${products.length}개 — 상품마다 소제목 \`## ${"{번호}"}. {상황 훅} {상품 핵심 이름}\` (예: "## 1. 침대가 좁다면, 싱글 OO 전기요").
   상황 훅은 그 상품을 골라야 할 사람의 상황이다. 소제목 바로 아래 \`검색 당시 가격: 69,660원 (롯데하이마트, ${today().slice(5).replace("-", "/")})\` 한 줄.
   그 아래 2~4줄: 상품명에 있는 특징이 앞의 기준 중 무엇에 해당하는지, 어떤 사람에게 맞는지.
   마지막 줄에 링크 자리 \`{{link:${"{번호}"}}}\` 를 **한 줄로 따로** 둔다(코드가 구매 링크로 바꾼다).
4. \`## 세 제품 한눈에 비교하면?\` — 마크다운 표 (열: 제품 | 가격 | 특징 | 이런 분께). 특징은 상품명 근거로 짧게.
5. \`## ${keyword} 살 때 체크할 것\` — 조사된 사실로 \`✔\` 목록 3~4개(인증 확인, 전기료, 관리 등).
6. 마무리 1~2줄 — 페르소나 말투로 가볍게 ("막상 고르려니 생각보다 따질 게 많네요" 같은 결). 교훈·총정리 금지.
   가격·재고는 바뀌니 링크에서 지금 가격을 보라는 말을 자연스럽게 한 번.

# 모바일 줄바꿈 (상위 글 공통 — 한 줄 평균 15자 안팎)
- 한 문장이 한 줄. 긴 문장은 쉼표에서 줄을 나눈다. 2~3줄마다 빈 줄.
- 한 문단(빈 줄 사이)은 3줄 이내.
- 이모지는 소제목이 아닌 본문 줄 끝에 글 전체 3~6개 정도.

# 제목
- 30~45자. "${keyword}" 를 맨 앞에. 대상(자취·원룸·1인 가구 중 맞는 것) + TOP ${products.length} + 가격대 범위 + 비교.
  예) "${keyword} 추천 TOP ${products.length}, ${range} 자취방 기준 비교"
- 낚시·과장 금지. 이모지 0개.

# 문체
${ANTI_AI}
- "첫째·둘째·셋째·마지막으로·결론적으로" 같은 나열·정리 말을 쓰지 않는다. 소제목과 줄바꿈으로 나눈다.
- 금지: 꿀팁, 총정리, 알아보겠습니다, 살펴보겠습니다, 정리해 드릴게요, 소개해 드릴게요, "오늘은 ~해 드릴게요", 도움이 되셨길.
- 상품 설명에서 "상품명에 ~가 표기돼 있어요" 를 반복하지 않는다. 적힌 특징을 앞의 기준과 이어서 말한다
  ("워셔블이라 세탁 기준에선 편한 쪽", "장판 소재라 물걸레 관리 쪽").
- 대가성(수수료) 문구, 구매 링크 주소, 해시태그는 본문에 쓰지 않는다(코드가 넣는다).
- 본문 공백 제외 1,800~2,500자. # (h1) 은 쓰지 않는다. 소제목은 ## 만.

# 출력
JSON: title, bodyMarkdown, tags(10~14개, # 없이 — 키워드 변형, 대상(자취·원룸), 종류(탄소매트 등), 브랜드).`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function render(d, products) {
  // 모델이 쓴 마크다운 → HTML. 링크 자리는 구매 링크 줄로, 맨 앞에 대가성 표시, 맨 끝에 해시태그
  // 한 줄 = 한 문단(모바일에서 한 줄씩 끊겨 읽히게). 스마트에디터에서 문단끼리는 간격 없이 붙으므로
  // 원래 빈 줄(묶음 사이)은 빈 문단으로 남겨 간격을 만든다. 표·목록·소제목 줄은 마크다운 그대로 둔다
  const GAP = "@@gap@@";
  const block = (l) => /^\s*(\||[-*]\s|\d+\.\s|#|✔)/.test(l);
  const md = d.bodyMarkdown
    .replace(/^\s*#\s+.*\n/, "")
    .replace(/\n{2,}/g, `\n${GAP}\n`)
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i, lines) => (i && !(block(l) && block(lines[i - 1])) ? `\n\n${l}` : `${i ? "\n" : ""}${l}`))
    .join("");
  let html = markdownToHtml(md).replace(new RegExp(`<p>\\s*${GAP}\\s*</p>`, "g"), "<p>&nbsp;</p>");
  // 소제목 앞뒤 빈 문단은 소제목 여백과 겹친다
  html = html.replace(/(<p>&nbsp;<\/p>\s*)+(<h[23])/g, "<p>&nbsp;</p>$2").replace(/(<\/h[23]>)\s*<p>&nbsp;<\/p>/g, "$1");
  html = html.replace(/(?:<p>\s*)?\{\{\s*link\s*:\s*(\d+)\s*\}\}(?:\s*<\/p>)?/gi, (_, n) => {
    const p = products[Number(n) - 1];
    return p ? `<p>👉 <a href="${esc(p.url)}">롯데하이마트에서 지금 가격 보기</a></p>` : "";
  });
  // 모델이 링크 자리를 빠뜨린 상품은 비교 표 앞에 몰아 둔다 — 링크 없는 상품 소개는 쓸모가 없다
  const missing = products.filter((p) => !html.includes(esc(p.url)));
  if (missing.length) {
    const block = missing.map((p) => `<p>👉 <a href="${esc(p.url)}">${esc(p.name)} 가격 보기</a></p>`).join("");
    const at = html.search(/<h2[^>]*>[^<]*한눈에/);
    html = at > 0 ? html.slice(0, at) + block + html.slice(at) : html + block;
  }
  const tags = d.tags.map((t) => `#${String(t).replace(/^#|\s+/g, "")}`).join(" ");
  return [
    // 대가성 표시는 맨 첫 부분(공정위 2024-12 지침)
    `<p>${esc(disclosureText([{ shop: "threehours" }]))}</p>`,
    html,
    `<p>가격·혜택은 작성일 기준이며 판매처 사정에 따라 바뀔 수 있어요.</p>`,
    `<p>${esc(tags)}</p>`,
  ].join("");
}

async function writePost(keyword, delta, products) {
  const facts = await research(keyword);
  if (facts) console.log(`- 조사: ${facts.split("\n").length}줄`);
  const model = await geminiModel();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await geminiCall(model, {
      contents: [{ role: "user", parts: [{ text: prompt(keyword, delta, products, facts) }] }],
      generationConfig: { temperature: 0.9, responseMimeType: "application/json", responseSchema: SCHEMA },
    });
    const d = await review(JSON.parse(res?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}"), products);
    const all = `${d.title}\n${d.bodyMarkdown}`;
    const bad = FIRST_PERSON.exec(all) ?? HYPE.exec(all);
    if (!bad && d.bodyMarkdown?.length > 600) return d;
    console.log(`- ${attempt}차 글 탈락: ${bad ? `금지 표현 "${bad[0]}"` : "본문이 너무 짧음"} — 다시 씀`);
  }
  throw new Error("써 본 척하거나 과장하는 표현이 계속 나와 올리지 않습니다.");
}

async function build(browser) {
  const forced = opt("--keyword");
  const { keyword, delta } = forced ? { keyword: forced, delta: Number(opt("--delta") ?? 0) } : await pickKeyword();
  console.log(`- 키워드: ${keyword} (최근 4주 +${delta}%)`);
  const products = await himartProducts(browser, keyword);
  if (products.length < 2) throw new Error(`하이마트에서 "${keyword}" 상품을 충분히 찾지 못했습니다(${products.length}개).`);
  for (const p of products) console.log(`- 상품: ${p.name} · ${p.price.toLocaleString("ko-KR")}원`);
  const d = await writePost(keyword, delta, products);
  return { keyword, delta, products, d, html: render(d, products) };
}

try {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  let built;
  try {
    built = await build(browser);
  } finally {
    await browser.close();
  }
  const { keyword, products, d, html } = built;

  if (cmd === "draft") {
    console.log(`\n제목: ${d.title}\n태그: ${d.tags.join(", ")}\n`);
    console.log(html.replace(/<\/(p|h2|h3|tr|li)>/g, "\n").replace(/<\/t[hd]>/g, " | ").replace(/<[^>]+>/g, ""));
    // --out 파일: 완성 HTML 을 남긴다(에디터 모양 점검용)
    if (opt("--out")) (await import("node:fs")).writeFileSync(opt("--out"), JSON.stringify({ title: d.title, tags: d.tags, html }));
  } else if (cmd === "run") {
    const url = await publishPost(
      {
        id: `info-${today()}`,
        virtual: true,
        kind: "product",
        status: "ready",
        title: d.title,
        tags: d.tags.slice(0, 10),
        category: INFO_CATEGORY,
        // 상품 원래 주소 → 발행 직전에 세시간전 3ha.in 링크로 바뀐다
        interview: { shopLinks: products.map((p) => ({ shop: "threehours", url: p.url, label: "하이마트" })) },
      },
      html,
    );
    if (url && !args.includes("--private") && !args.includes("--dry-run")) {
      const h = await history();
      h.push({ keyword, date: today(), title: d.title, url });
      await setSetting(HISTORY_KEY, JSON.stringify(h.slice(-200)));
    }
  } else {
    console.error("사용법: product-info.mjs <draft|run> [--keyword X] [--private] [--dry-run]");
    process.exit(1);
  }
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
