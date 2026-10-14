/**
 * 세시간전 제휴 링크(3ha.in)를 스튜디오 화면으로 만든다. naver-publish.mjs 가 발행 직전에 부른다.
 *
 * 세시간전은 공개 API 가 없다. 내부 API 를 직접 부르지 않고 사람이 하는 그대로 스튜디오 화면을
 * 누른다 — 프로그램 페이지 → 상품 링크 붙여넣기 → 다음 → 상품명·라벨 → 제휴링크 만들기.
 * 약관이 막는 것은 봇 트래픽·쿠키 스터핑·트래픽 가로채기이고, 링크는 글 하나에 필요한 만큼만 만든다.
 *
 * 로그인은 THREEHOURS_ID · THREEHOURS_PW (이메일 로그인). 값은 출력하지 않는다.
 */

/**
 * 상품 글에 쓰는 판매처만. 코드는 스튜디오 주소 /studio/affiliate/programs/<code> 의 끝이다.
 * 쿠팡은 넣지 않는다 — 세시간전 사전 승인이 필요하고, 쿠팡 파트너스 링크를 직접 쓰면 된다.
 */
export const THREEHOURS_PROGRAMS = [
  { code: "linkprice_ohouse", title: "오늘의집", host: /(^|\.)ohou\.se$/ },
  { code: "linkprice_himart", title: "하이마트", host: /(^|\.)e-himart\.co\.kr$/ },
  { code: "linkprice_gmarket", title: "Gmarket", host: /(^|\.)gmarket\.co\.kr$/ },
  { code: "linkprice_wconcept", title: "W.CONCEPT", host: /(^|\.)wconcept\.co\.kr$/ },
  { code: "linkprice_lfmall", title: "LFmall", host: /(^|\.)lfmall\.co\.kr$/ },
  { code: "linkprice_yes24", title: "yes24", host: /(^|\.)yes24\.com$/ },
  { code: "linkprice_kyobobook", title: "교보문고", host: /(^|\.)kyobobook\.co\.kr$/ },
  { code: "linkprice_clubclio", title: "클럽클리오", host: /(^|\.)clubclio\.co\.kr$/ },
];

/** 이미 세시간전 단축 링크인가. 예전 안내는 ha3.in 이었고 실제 발급 주소는 3ha.in 이다 */
export const isThreeHoursLink = (url) => /^https:\/\/(3ha|ha3)\.in\//.test(String(url).trim());

export function programFor(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return THREEHOURS_PROGRAMS.find((p) => p.host.test(host)) ?? null;
}

const STUDIO = "https://3hoursahead.com/ko";

async function login(page) {
  const id = (process.env.THREEHOURS_ID || "").trim();
  const pw = (process.env.THREEHOURS_PW || "").trim();
  if (!id || !pw) throw new Error("THREEHOURS_ID · THREEHOURS_PW 가 없습니다.");
  await page.goto(`${STUDIO}/login`, { waitUntil: "domcontentloaded" });
  const email = page.locator("input[type=email]");
  await email.waitFor({ timeout: 20000 });
  // 화면이 다 뜨기 전에 채우면 하이드레이션이 값을 지운다
  await page.waitForTimeout(3000);
  await email.click();
  await page.keyboard.type(id, { delay: 30 });
  await page.locator("input[type=password]").click();
  await page.keyboard.type(pw, { delay: 30 });
  await page.locator("button[type=submit]").click();
  await page
    .waitForFunction(() => location.pathname.includes("/studio"), null, { timeout: 30000 })
    .catch(() => {
      throw new Error("세시간전 로그인 실패 — 아이디·비밀번호를 확인하세요.");
    });
}

/**
 * 상품 주소들을 세시간전 링크로 바꾼다. 돌려주는 값은 { 원래주소: 3ha.in 주소 }.
 * 하나라도 실패하면 던진다 — 링크 없는 상품 글을 올리지 않는다.
 *
 * @param browser 플레이라이트 chromium 브라우저 (발행 스크립트의 것을 같이 쓴다)
 * @param items [{ url, name }] name 은 스튜디오 목록에서 알아보는 상품명
 * @param label 링크 라벨. 예) "N blog _ 26.10.14 #12"
 */
export async function createThreeHoursLinks(browser, items, label) {
  const context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const out = {};
  try {
    await login(page);
    for (const { url, name } of items) {
      const program = programFor(url);
      if (!program) {
        const host = new URL(url).hostname;
        if (/(^|\.)coupang\.com$/.test(host)) {
          throw new Error("쿠팡은 세시간전으로 걸지 않습니다 — /visit 에서 판매처를 '쿠팡'(쿠팡 파트너스 링크)으로 바꾸세요.");
        }
        throw new Error(`세시간전 자동 링크를 지원하지 않는 판매처입니다: ${host}`);
      }

      await page.goto(`${STUDIO}/studio/affiliate/programs/${program.code}`, { waitUntil: "domcontentloaded" });
      const input = page.locator("main input[placeholder='https://']");
      const ready = await input.waitFor({ timeout: 20000 }).then(() => true, () => false);
      if (!ready) {
        const text = await page.evaluate(() => document.body.innerText).catch(() => "");
        // 목록에 있는 판매처가 나중에 사전 승인제로 바뀌는 경우
        if (/사전 승인이 필요한 프로그램/.test(text)) {
          throw new Error(`${program.title} 은 세시간전 사전 승인 전이라 링크를 만들 수 없습니다.`);
        }
        throw new Error(`${program.title} 링크 입력칸을 찾지 못했습니다 — 스튜디오 화면이 바뀌었습니다.`);
      }
      await page.waitForTimeout(1500);
      await input.fill(url);
      await page.locator("main button", { hasText: /^다음$/ }).click();
      // 주소가 그 판매처 규칙에 맞으면 상품명 칸이 열린다. 예시 문구는 프로그램마다 다르다
      // (yes24 "예) 아프니까 청춘이다", 하이마트 "예) 도쿄 디즈니 랜드") — 라벨 칸이 아닌 "예)" 칸이 상품명
      const NAME = "main input[placeholder^='예)']:not([placeholder^='예) N blog'])";
      await page
        .waitForFunction((sel) => {
          const el = document.querySelector(sel);
          return el && !el.disabled;
        }, NAME, { timeout: 15000 })
        .catch(() => {
          throw new Error(`${program.title} 이 이 주소를 받지 않았습니다: ${url}`);
        });
      await page.locator(NAME).first().fill(String(name).slice(0, 60));
      await page.locator("main input[placeholder^='예) N blog']").fill(String(label).slice(0, 60));
      await page.locator("main button", { hasText: /^제휴링크 만들기$/ }).last().click();

      // 완료 창에 만든 링크가 나온다
      const dialog = page.locator("[role=dialog]", { hasText: "제휴링크 만들기 완료" });
      await dialog.waitFor({ timeout: 20000 });
      const short = /https:\/\/3ha\.in\/\S+/.exec(await dialog.innerText())?.[0];
      if (!short) throw new Error(`${program.title} 링크가 만들어졌는데 주소를 읽지 못했습니다.`);
      out[url] = short;
      await dialog.getByRole("button", { name: "확인" }).click().catch(() => {});
      // 사람 속도로. 몰아서 만들지 않는다
      await page.waitForTimeout(3000);
    }
    return out;
  } catch (e) {
    await page.screenshot({ path: "threehours-fail.png", fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}
