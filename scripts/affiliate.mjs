/**
 * 제휴 상품 후보 뽑기 — 깃액션 전용.
 *
 * 서버를 거치지 않는다. 러너 안에서 네이버 검색광고 키워드도구로 상품 키워드를
 * 발굴하고, Gemini 로 쓰레드에 올릴 초안을 만들어 요약에 적는다.
 *
 * 왜 데이터랩(쇼핑인사이트)이 아닌가: 네이버가 검색·데이터랩 API 신규 신청을
 * 받지 않아 권한이 없다. 대신 검색광고 키워드도구가 연관 키워드마다 월간 검색수와
 * **광고 단가**를 준다. 단가는 광고주가 그 키워드에 실제로 거는 돈이라, 쇼핑인사이트
 * 순위보다 구매 의도를 더 곧게 가리킨다.
 *
 * 실행: node scripts/affiliate.mjs "무선청소기,공기청정기"
 */
import fs from "node:fs/promises";
import { fetchRelatedKeywords, fetchBids } from "../src/lib/searchad.ts";
import { geminiCall, geminiModel } from "../src/lib/gemini.ts";
import { hasSupabase, insertThreadsPosts } from "../src/lib/db.ts";

/** 한 번에 뽑을 상품 후보 수. 너무 많으면 읽지 않게 된다 */
const PICK_COUNT = 5;

/**
 * 상품 키워드가 아닌 것을 걷어낸다.
 *
 * 키워드도구는 "무선청소기추천"처럼 상품과 붙은 말도 주지만 "청소기수리",
 * "청소기렌탈"처럼 제휴로 팔 수 없는 것도 섞어 준다. 검색량만 보고 고르면
 * 링크를 걸 수 없는 키워드가 상위에 올라온다.
 */
const EXCLUDE = /수리|렌탈|렌털|중고|as|a\/s|고장|버리는|폐기|무료나눔|채용|알바|자격증/i;

function pickCandidates(keywords, count) {
  return keywords
    .filter((k) => (k.totalSearches ?? 0) > 0 && !EXCLUDE.test(k.keyword))
    .sort((a, b) => (b.totalSearches ?? 0) - (a.totalSearches ?? 0))
    .slice(0, count);
}

const SYSTEM = `당신은 쓰레드(Threads)에 올릴 제휴 상품 소개 초안을 만드는 사람입니다.

지켜야 할 선:
- **써보지 않은 제품의 사용 경험을 지어내지 마세요.** "제가 3개월 써봤는데", "허리가 안 아파요"
  같은 1인칭 후기는 절대 쓰지 마세요. 표시광고법상 기만적 표시·광고이고 공정위 단속 대상입니다.
- 대신 **검색 데이터로 말할 수 있는 것**만 쓰세요: 이 키워드가 얼마나 검색되는지,
  어떤 점을 사람들이 궁금해하는지, 무엇을 비교해야 하는지.
- 사용 소감이 들어갈 자리는 빈칸으로 남기고, 운영자가 실제로 써본 뒤 채우도록 안내하세요.
- 효과·결과를 보장하는 표현(반드시, 100%, 무조건)을 쓰지 마세요.
- 이모지는 한 게시물에 최대 1개. 광고 티가 나면 쓰레드에서 바로 넘겨집니다.

쓰레드 글의 형태:
- 첫 줄이 전부입니다. 스크롤을 멈추게 하는 한 문장이어야 합니다.
- 전체 500자 이내. 문단 사이는 빈 줄로 띄웁니다.
- 마지막은 프로필 링크로 유도하는 한 줄.`;

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          angle: { type: "string" },
          hooks: { type: "array", items: { type: "string" } },
          draft: { type: "string" },
          checkBeforePosting: { type: "array", items: { type: "string" } },
        },
        required: ["keyword", "angle", "hooks", "draft", "checkBeforePosting"],
      },
    },
  },
  required: ["picks"],
};

function buildPrompt(candidates) {
  const rows = candidates
    .map(
      (c) =>
        `- ${c.keyword} · 월간 검색 ${(c.totalSearches ?? 0).toLocaleString()}회` +
        (c.bid ? ` · 광고 단가 ${c.bid.toLocaleString()}원` : ""),
    )
    .join("\n");

  return [
    "아래는 네이버 검색광고 키워드도구에서 뽑은 상품 키워드와 실제 검색량입니다.",
    "광고 단가가 높다는 것은 광고주들이 그 키워드에 돈을 많이 건다는 뜻이고, 보통 구매 의도가 높습니다.",
    "",
    rows,
    "",
    `각 키워드마다 쓰레드 게시물 초안을 하나씩 만드세요 (총 ${candidates.length}개).`,
    "",
    "항목별로:",
    "- `angle`: 이 키워드로 무엇을 말할지 한 문장 (예: 가격대별 차이를 정리)",
    "- `hooks`: 첫 줄 후보 3개. 서로 다른 각도로. 사용 경험을 주장하지 말 것",
    "- `draft`: 게시물 본문. 사용 소감이 들어갈 자리는 `[여기에 직접 써본 소감 한 줄]` 로 비워둘 것",
    "- `checkBeforePosting`: 올리기 전에 운영자가 확인·보완할 것 2~3가지",
  ].join("\n");
}

async function main() {
  const seedArg = (process.argv[2] ?? "").trim();
  const seeds = seedArg
    ? seedArg.split(",").map((s) => s.trim()).filter(Boolean)
    : ["무선청소기"];

  const rel = await fetchRelatedKeywords(seeds);
  if (!rel.keywords?.length) {
    throw new Error(`연관 키워드를 못 받았습니다: ${rel.error ?? "원인 미상"}`);
  }

  const candidates = pickCandidates(rel.keywords, PICK_COUNT);
  if (!candidates.length) throw new Error("쓸 만한 상품 키워드가 없습니다.");

  // 단가는 별도 호출이라 후보로 좁힌 뒤에 부른다. 585건 전부 조회할 이유가 없다
  const { bids } = await fetchBids(candidates.map((c) => c.keyword));
  for (const c of candidates) c.bid = bids.get(c.keyword) ?? null;

  const payload = await geminiCall(
    await geminiModel(),
    {
      contents: [{ role: "user", parts: [{ text: buildPrompt(candidates) }] }],
      systemInstruction: { parts: [{ text: SYSTEM }] },
      generationConfig: {
        temperature: 0.9,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    },
    // 새벽에 혼자 도는 경로라 과부하면 기다렸다 다시 건다
    { retries: 4 },
  );

  const text = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("");
  const picks = JSON.parse(text).picks ?? [];

  const out = ["## 오늘의 제휴 후보", "", `시드: ${seeds.join(", ")} · 연관 ${rel.keywords.length}건 중 ${picks.length}개`, ""];
  for (const [i, p] of picks.entries()) {
    const c = candidates[i];
    out.push(`### ${i + 1}. ${p.keyword}`);
    if (c) {
      out.push(
        `> 월간 검색 **${(c.totalSearches ?? 0).toLocaleString()}회**` +
          (c.bid ? ` · 광고 단가 **${c.bid.toLocaleString()}원**` : ""),
      );
    }
    out.push("", `**각도** — ${p.angle}`, "", "**첫 줄 후보**");
    for (const h of p.hooks ?? []) out.push(`- ${h}`);
    out.push("", "**본문 초안**", "", "```", p.draft, "```", "", "**올리기 전 확인**");
    for (const q of p.checkBeforePosting ?? []) out.push(`- [ ] ${q}`);
    out.push("");
  }
  out.push(
    "---",
    "",
    "제휴 링크를 넣을 때는 아래 문구를 게시물이나 프로필 링크 페이지에 반드시 넣으세요.",
    "",
    "> 이 게시물은 제휴 마케팅 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.",
    "",
    "`[여기에 직접 써본 소감 한 줄]` 자리는 실제로 써본 뒤 채우세요. 안 써본 제품의 후기를 지어내면 표시광고법 위반입니다.",
  );

  /*
   * 백오피스 쓰레드 탭이 읽도록 DB 에 넣는다.
   *
   * 요약과 첨부파일은 실행 기록으로 남을 뿐 손질할 수가 없다. 초안은 소감을 채우고
   * 링크를 붙이고 올림 표시를 해야 하는 물건이라, 읽고 고칠 수 있는 곳에 있어야 한다.
   * Supabase 자격증명이 없으면 조용히 건너뛴다 — 파일 출력만으로도 쓸모는 있다.
   */
  let saved = "";
  if (hasSupabase()) {
    try {
      const { inserted, skipped } = await insertThreadsPosts(
        picks.map((p, i) => ({
          keyword: p.keyword,
          searches: candidates[i]?.totalSearches ?? null,
          bid: candidates[i]?.bid ?? null,
          angle: p.angle ?? "",
          hooks: p.hooks ?? [],
          draft: p.draft ?? "",
          checklist: p.checkBeforePosting ?? [],
        })),
      );
      saved =
        `백오피스 **쓰레드** 탭에 ${inserted}건 저장` +
        (skipped ? ` (이미 열려 있는 키워드 ${skipped}건은 건너뜀)` : "");
    } catch (e) {
      saved = `DB 저장 실패: ${e.message}`;
    }
  } else {
    saved = "SUPABASE 자격증명이 없어 DB 저장을 건너뛰었습니다.";
  }
  out.push("", "---", "", saved);

  const md = out.join("\n");
  await fs.writeFile("affiliate-picks.md", md, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n", "utf8");
  }
  console.log(md);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
