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
import { geminiCall, geminiModel } from "../src/lib/gemini.ts";
import { productTrends } from "../src/lib/productTrend.ts";
import { disclosureText } from "../src/lib/shopLinks.ts";
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
const HYPE = /무조건|100\s?%|최저가 보장|절대|완벽한|필수템이 아닌 사람은 없/;

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

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    hook: { type: "string" },
    intro: { type: "string" },
    criteria: { type: "array", items: { type: "object", properties: { name: { type: "string" }, desc: { type: "string" } }, required: ["name", "desc"] } },
    products: {
      type: "array",
      items: {
        type: "object",
        properties: { point: { type: "string" }, fitFor: { type: "string" } },
        required: ["point", "fitFor"],
      },
    },
    pick: { type: "string" },
    closing: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "hook", "intro", "criteria", "products", "pick", "closing", "tags"],
};

function prompt(keyword, delta, products) {
  return [
    `네이버 블로그에 올릴 "${keyword}" 고르는 법·비교 정보 글을 JSON 으로 써라. 독자는 지금 ${keyword} 를 살까 고민하는 사람이다.`,
    "",
    "## 사실 (이것만 근거로)",
    `- 네이버 데이터랩 기준 최근 4주 "${keyword}" 검색 관심도가 ${delta}% 올랐다.`,
    ...products.map((p, i) => `- 상품 ${i + 1}: ${p.name} / 롯데하이마트 판매가 ${p.price.toLocaleString("ko-KR")}원 (${today()} 기준)`),
    "",
    "## 반드시 지킬 것",
    "- 후기가 아니라 정보 글이다. 글쓴이가 써 봤다·샀다·사용해 봤다는 표현, '써 보니', '내돈내산', '실사용' 같은 말을 절대 쓰지 말 것.",
    "- 상품 설명(point)은 상품명에 적힌 정보(용량·소재·기능 이름·구성)와 가격만으로 쓸 것. 상품명에 없는 기능·성능·소재·평점·후기를 지어내지 말 것. 상품명의 낱말 뜻을 추측해 '부드럽다'·'따뜻하다'·'튼튼하다' 같은 성능으로 풀지 말고, 적힌 낱말을 그대로 인용할 것.",
    "- 무조건·100%·최저가 보장·절대 같은 과장·보장 표현 금지. 가격은 바뀔 수 있다는 걸 전제로.",
    "",
    "## 살 만하게 (후킹)",
    `- hook: 첫 줄. 검색 관심도가 ${delta}% 오른 사실이나 계절·상황을 붙잡아 '지금 볼 이유' 를 한두 문장으로. 질문형이나 숫자로 시작해도 좋다.`,
    "- intro: 이 글을 읽으면 무엇을 고를 수 있게 되는지 2~3문장.",
    `- criteria: ${keyword} 고를 때 볼 기준 3~4개. 일반적으로 알려진 기준만(예: 안전 인증, 세탁 가능 여부, 소비전력, 크기). 각 desc 는 1~2문장, 왜 중요한지.`,
    `- products: 위 상품 ${products.length}개 순서대로. point 는 이 상품을 볼 이유 한두 문장(상품명·가격대 근거). 가격 숫자와 날짜는 글에 따로 붙으니 point 에 다시 쓰지 말 것. fitFor 는 '이런 분께 맞아요' 한 문장.`,
    "- pick: 예산·상황별로 셋 중 무엇을 볼지 한눈에 정리하는 2~3문장. 구매 욕구가 생기게 하되 과장 없이.",
    "- closing: 마지막 한두 문장. 가격·재고가 바뀌니 링크에서 지금 가격을 확인하라는 행동 유도.",
    `- title: 25~40자. "${keyword}" 를 맨 앞에. 예) "${keyword} 추천 비교 - 가격대별 고르는 법 (${today().slice(0, 4)})". 낚시성 과장 금지.`,
    "- tags: 8~10개, # 없이.",
    "- 문체: 친근한 해요체. AI 상투어(살펴보겠습니다, 알아보겠습니다, 정리해 드릴게요, 결론적으로) 쓰지 말 것. 같은 어미를 연달아 반복하지 말 것.",
  ].join("\n");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function render(d, keyword, delta, products) {
  const won = (n) => `${n.toLocaleString("ko-KR")}원`;
  const parts = [
    // 대가성 표시는 맨 첫 부분(공정위 2024-12 지침)
    `<p>${esc(disclosureText([{ shop: "threehours" }]))}</p>`,
    `<p><b>${esc(d.hook)}</b></p>`,
    `<p>${esc(d.intro)}</p>`,
    // 첫 줄이 이미 숫자를 말했으면 출처 줄은 짧게
    d.hook.includes(String(delta))
      ? `<p>(네이버 데이터랩 검색어트렌드, ${today()} 확인)</p>`
      : `<p>네이버 데이터랩 기준 최근 4주 "${esc(keyword)}" 검색 관심도 ${delta}% 상승 (${today()} 확인)</p>`,
    `<h3>${esc(keyword)} 고를 때 볼 것</h3>`,
    ...d.criteria.map((c, i) => `<p><b>${i + 1}. ${esc(c.name)}</b> — ${esc(c.desc)}</p>`),
    `<h3>지금 볼 만한 ${esc(keyword)} ${products.length}가지</h3>`,
  ];
  products.forEach((p, i) => {
    const g = d.products[i] ?? { point: "", fitFor: "" };
    parts.push(
      `<p><b>${i + 1}. ${esc(p.name)}</b></p>`,
      `<p>롯데하이마트 판매가 ${won(p.price)} (${today()} 기준)</p>`,
      g.point ? `<p>${esc(g.point)}</p>` : "",
      g.fitFor ? `<p>이런 분께 맞아요: ${esc(g.fitFor)}</p>` : "",
      `<p>👉 <a href="${esc(p.url)}">하이마트에서 지금 가격 보기</a></p>`,
    );
  });
  parts.push(
    `<h3>한눈에 고르기</h3>`,
    `<p>${esc(d.pick)}</p>`,
    `<p>${esc(d.closing)}</p>`,
    `<p>가격·혜택은 작성일 기준이며 판매처 사정에 따라 바뀔 수 있어요.</p>`,
  );
  return parts.filter(Boolean).join("");
}

async function writePost(keyword, delta, products) {
  const model = await geminiModel();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await geminiCall(model, {
      contents: [{ role: "user", parts: [{ text: prompt(keyword, delta, products) }] }],
      generationConfig: { temperature: 0.8, responseMimeType: "application/json", responseSchema: SCHEMA },
    });
    const d = JSON.parse(res?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
    const all = JSON.stringify(d);
    const bad = FIRST_PERSON.exec(all) ?? HYPE.exec(all);
    if (!bad) return d;
    console.log(`- ${attempt}차 글에 금지 표현 "${bad[0]}" — 다시 씀`);
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
  return { keyword, delta, products, d, html: render(d, keyword, delta, products) };
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
    console.log(html.replace(/<\/p>|<\/h3>/g, "\n").replace(/<[^>]+>/g, ""));
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
