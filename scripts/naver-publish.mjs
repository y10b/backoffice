/**
 * 네이버 블로그 자동 발행. .claude/skills/naver-publish 가 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/naver-publish.mjs list            대기열 (올릴 준비 + 완성본 있음)
 *   node --import ./scripts/ts-register.mjs scripts/naver-publish.mjs show <id>       제목·태그·본문 텍스트
 *   node --import ./scripts/ts-register.mjs scripts/naver-publish.mjs publish <id> [--private] [--no-ai-image]
 *   node --import ./scripts/ts-register.mjs scripts/naver-publish.mjs link <상품주소> [상품명]     세시간전 링크 하나
 *
 * 완성본은 /visit 의 "자동 발행 맡기기" 가 Storage 에 둔 HTML 이다(src/lib/naverQueue.ts).
 * 사진·대가성 이미지가 data URL 로 박혀 있고, 스마트에디터에 붙여넣으면 에디터가 자기 서버로
 * 다시 올린다 — 사람이 휴대폰에서 붙여넣던 것과 같은 경로다.
 *
 * 로그인은 NID_AUT · NID_SES 쿠키다(환경변수 → 설정 표 naver_nid_aut · naver_nid_ses).
 * 클라우드는 해외 IP 라 아이디·비밀번호 로그인은 해외 로그인 차단·캡차에 막힌다.
 * 셀렉터가 안 맞으면 naver-fail.png 를 남기고 멈춘다.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getSettings, getVisitPost, updateVisitPost } from "../src/lib/db.ts";
import { getQueued, listQueuedIds, removeQueued } from "../src/lib/naverQueue.ts";
import { normalizeShopLinks } from "../src/lib/shopLinks.ts";
import { createThreeHoursLinks, isThreeHoursLink } from "./threehours.mjs";

const require = createRequire(import.meta.url);
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

const args = process.argv.slice(2);

/** 종류별 네이버 블로그 카테고리 이름 (blog.naver.com/k-jun03 기준) */
const NAVER_CATEGORY = { product: "써 본 물건", daily: "자취 일상" };
const isPrivate = args.includes("--private");
const [cmd, idArg] = args.filter((a) => !a.startsWith("--"));

async function creds() {
  const s = await getSettings(["naver_nid_aut", "naver_nid_ses", "naver_blog_id"]);
  return {
    aut: (process.env.NID_AUT || s.naver_nid_aut || "").trim(),
    ses: (process.env.NID_SES || s.naver_nid_ses || "").trim(),
    blogId: (process.env.NAVER_BLOG_ID || s.naver_blog_id || "").trim(),
  };
}

/**
 * 완성본을 글·사진 조각으로 나눠 차례로 붙여넣는다. 스마트에디터는 붙여넣은 HTML 의 <img> 를
 * 버리고, 사진은 클립보드 파일로 줘야 자기 서버로 올린다. 키 입력은 에디터 안의 숨은 iframe
 * (input_buffer) 이 받으므로 붙여넣기 이벤트도 그 안에 보낸다.
 */
export async function pasteBody(page, f, html) {
  const parts = html.split(/(<img\b[^>]*>)/i).filter((s) => s.trim());
  let images = 0;
  for (const part of parts) {
    const src = /^<img/i.test(part) ? (part.match(/src="([^"]+)"/i)?.[1] ?? "") : null;
    if (src === null && !part.replace(/<[^>]+>/g, "").trim()) continue;
    if (src !== null && !src.startsWith("data:image/")) throw new Error("data URL 이 아닌 사진이 있습니다.");
    // 늘 문서 끝에 잇는다 — 사진을 넣으면 그 뒤에 빈 문단이 남는다
    await f.locator(".se-component.se-text .se-text-paragraph").last().click({ timeout: 10000 });
    await page.keyboard.press("End");
    await f.evaluate(([part, src]) => {
      const d = document.activeElement?.contentDocument ?? document;
      const t = d.activeElement || d.body;
      const dt = new DataTransfer();
      if (src) {
        const [meta, b64] = src.split(",");
        const type = meta.slice(5).split(";")[0];
        const bin = atob(b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        dt.items.add(new File([u], `photo.${type.split("/")[1] || "jpg"}`, { type }));
      } else {
        dt.setData("text/html", part);
        dt.setData("text/plain", part.replace(/<[^>]+>/g, ""));
      }
      t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [part, src]);
    if (src) {
      images++;
      // 컴포넌트는 바로 생기고 "전송중" 이 뜬다. 업로드가 끝나면 src 가 네이버 서버 주소로 바뀐다
      await f.waitForFunction(
        (n) => /^https:/.test(document.querySelectorAll(".se-component.se-image")[n]?.querySelector("img")?.getAttribute("src") ?? ""),
        images - 1,
        { timeout: 60000 },
      );
    }
    await page.waitForTimeout(500);
  }
  return images;
}

/** 이미지에 들어갈 장면. 제품 자체는 그리지 않는다 — AI 는 모양·로고를 그럴듯하게 틀리게 그린다 */
const AI_SCENE = {
  product:
    "A natural lifestyle photo of an everyday setting where a product like the one in this blog title would be used: {title}. " +
    "Show the setting, mood and the moment of use only. Do not depict any specific branded product, packaging, logo or label; " +
    "any object in use stays generic and partly out of focus.",
  daily: "A natural lifestyle photo that matches the mood of this Korean blog post title: {title}.",
};

/**
 * 상품·일상 글에 GPT 이미지로 만든 연출 이미지를 한 장 넣는다.
 *
 * 실제 사용 사진처럼 보이면 체험하지 않은 것을 체험한 것처럼 보이게 하는 기만 광고가 된다.
 * 그래서 제품은 그리지 않고 장면만 만들고, 바로 아래에 AI 연출 이미지라고 밝힌다.
 * 키가 없거나 생성이 실패하면 이미지 없이 그대로 간다 — 발행을 막을 이유는 아니다.
 * 브라우저로 ChatGPT 화면을 돌리지 않고 API 를 쓴다(웹 화면 자동화는 약관 위반이다).
 */
async function withAiImage(post, html) {
  const scene = AI_SCENE[post.kind];
  const key = process.env.OPENAI_API_KEY;
  if (!scene || args.includes("--no-ai-image")) return html;
  if (!key) {
    console.log("- AI 연출 이미지 건너뜀: OPENAI_API_KEY 없음");
    return html;
  }
  // 일상 글은 사진이 넉넉하면 굳이 채우지 않는다
  if (post.kind === "daily" && (html.match(/<img\b/gi) ?? []).length >= 4) return html;

  const title = (post.title || post.titles?.[0] || "").trim();
  const prompt =
    scene.replace("{title}", title) +
    " Photorealistic, soft natural light, Korean everyday atmosphere. " +
    "No text, no letters, no logos, no brand names, no watermarks, no recognizable real people or celebrities.";
  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
        prompt,
        size: "1536x1024",
        quality: "medium",
        output_format: "jpeg",
        n: 1,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => ({}));
    const b64 = data?.data?.[0]?.b64_json;
    if (!res.ok || !b64) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const block =
      `<p><img src="data:image/jpeg;base64,${b64}"></p>` +
      "<p>※ AI로 만든 연출 이미지입니다. 실제 제품·사용 사진이 아닙니다.</p>";
    // 소제목이 있으면 첫 소제목 앞(도입 뒤)에, 없으면 본문 한가운데 문단 뒤에 둔다.
    // 맨 위는 대가성 표시 자리, 맨 아래는 쇼핑 링크 자리다
    const ends = [...html.matchAll(/<\/p>/gi)].map((m) => m.index + m[0].length);
    const h = html.search(/<h[23][\s>]/i);
    const at = h > 0 ? h : ends.length ? ends[Math.floor(ends.length / 2)] : html.length;
    console.log(`- AI 연출 이미지 1장 추가 (${post.kind})`);
    return html.slice(0, at) + block + html.slice(at);
  } catch (e) {
    console.log(`- AI 연출 이미지 건너뜀: ${String(e.message ?? e).slice(0, 120)}`);
    return html;
  }
}

/**
 * /visit 에서 "세시간전" 으로 고른 링크에 상품 원래 주소가 들어 있으면, 발행 직전에 스튜디오에서
 * 3ha.in 링크를 만들어 본문 주소를 바꿔 끼운다. 이미 3ha.in 이면 그대로 둔다.
 * 하나라도 못 만들면 던진다 — 수익 링크 없이 상품 글을 올리지 않는다.
 */
async function withThreeHoursLinks(browser, post, html) {
  const pending = normalizeShopLinks(post.interview).filter((l) => l.shop === "threehours" && !isThreeHoursLink(l.url));
  if (!pending.length) return html;
  const amp = (u) => u.replace(/&/g, "&amp;");
  for (const l of pending) {
    if (!html.includes(l.url) && !html.includes(amp(l.url))) throw new Error(`본문에 링크가 없습니다: ${l.url}`);
  }
  const title = (post.title || post.titles?.[0] || "").trim();
  const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(2, 10).replace(/-/g, ".");
  const made = await createThreeHoursLinks(
    browser,
    pending.map((l) => ({ url: l.url, name: l.label || title })),
    `N blog _ ${d} #${post.id}`,
  );
  let out = html;
  for (const [from, to] of Object.entries(made)) {
    out = out.split(from).join(to).split(amp(from)).join(to);
    console.log(`- 세시간전 링크: ${new URL(from).hostname} → ${to}`);
  }
  return out;
}

/** 스마트에디터는 링크를 <a> 가 아니라 span.se-link 의 data-href 로 들고 있다 */
const editorLinks = (f) =>
  f.evaluate(() =>
    [...document.querySelectorAll(".se-component .se-link[data-href], .se-component a[href]")].map(
      (e) => e.getAttribute("data-href") || e.getAttribute("href"),
    ),
  );

const text = (html) => html.replace(/<img[^>]*>/g, "[이미지]").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function publish(id) {
  const post = await getVisitPost(id);
  if (!post) throw new Error(`${id}번 글이 없습니다.`);
  if (post.status !== "ready") throw new Error(`${id}번은 올릴 준비(ready)가 아니라 ${post.status} 입니다.`);
  const queued = await getQueued(id);
  if (!queued) throw new Error(`${id}번 완성본이 대기열에 없습니다. /visit 에서 "자동 발행 맡기기" 를 다시 누르세요.`);
  await publishPost(post, queued);
}

/**
 * 글 한 편을 에디터에 넣고 발행한다. --dry-run 이면 발행 창에서 공개 범위까지 고르고 마지막 확인은
 * 누르지 않는다(세시간전 링크·AI 이미지는 실제로 만든다). 시험 글로 전체 흐름을 볼 때 쓴다.
 */
export async function publishPost(post, queued) {
  const id = post.id;
  const dryRun = args.includes("--dry-run");
  const title = (post.title || post.titles?.[0] || "").trim();
  if (!title) throw new Error(`${id}번은 제목이 없습니다.`);

  const { aut, ses, blogId: savedId } = await creds();
  if (!aut || !ses) throw new Error("NID_AUT · NID_SES 가 없습니다. 브라우저의 네이버 로그인 쿠키를 환경에 넣으세요.");

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  let html;
  try {
    html = await withAiImage(post, await withThreeHoursLinks(browser, post, queued));
  } catch (e) {
    await browser.close();
    throw e;
  }
  const context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 1000 } });
  await context.addCookies(
    [
      ["NID_AUT", aut],
      ["NID_SES", ses],
    ].map(([name, value]) => ({ name, value, domain: ".naver.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" })),
  );
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss()); // "작성 중인 글이 있습니다" → 새로 쓴다

  try {
    // 블로그 아이디는 로그인한 사람의 내 블로그 주소에서 얻는다
    let blogId = savedId;
    if (!blogId) {
      await page.goto("https://blog.naver.com/MyBlog.naver", { waitUntil: "domcontentloaded" });
      blogId = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
      if (!blogId || /nidlogin|MyBlog/i.test(page.url())) throw new Error("로그인되지 않았습니다 — NID 쿠키가 만료됐습니다.");
    }

    await page.goto(`https://blog.naver.com/${blogId}/postwrite`, { waitUntil: "domcontentloaded" });
    if (/nid\.naver\.com/.test(page.url())) throw new Error("로그인 페이지로 돌아갔습니다 — NID 쿠키가 만료됐습니다.");
    // 글쓰기는 mainFrame 안에 있을 때도, 바로 페이지일 때도 있다
    const frameEl = await page.waitForSelector("#mainFrame", { timeout: 8000 }).catch(() => null);
    const f = frameEl ? await frameEl.contentFrame() : page.mainFrame();

    const step = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        throw new Error(`${name} 단계 실패: ${String(e.message).split("\n")[0]}`);
      }
    };

    // 이어쓰기·도움말 팝업. 없으면 지나간다. "작성 중인 글" 팝업은 에디터가 뜨고 몇 초 뒤에 나온다
    await f.locator(".se-title-text").waitFor({ timeout: 30000 }).catch(() => {});
    await f.locator(".se-popup-button-cancel").click({ timeout: 15000 }).catch(() => {});
    await f.locator(".se-help-panel-close-button").click({ timeout: 3000 }).catch(() => {});

    await step("제목", async () => {
      await f.locator(".se-documentTitle .se-text-paragraph, .se-title-text").first().click({ timeout: 20000 });
      await page.keyboard.type(title, { delay: 30 });
    });

    await step("본문", async () => {
      // 서식 붙여넣기. 사람이 휴대폰에서 하던 "복사 → 붙여넣기" 와 같은 이벤트를 에디터에 준다
      const want = (html.match(/<img\b/gi) ?? []).length;
      const got = await pasteBody(page, f, html);
      const imgs = await f.locator(".se-component.se-image").count();
      if (got !== want || imgs < want) throw new Error(`사진이 에디터에 안 들어갔습니다 (${imgs}/${want}).`);
      // 제휴 링크가 글자만 남고 빠지면 수익이 0 이다. 붙여넣은 링크가 모두 살아 있어야 한다
      // 에디터가 링크를 붙이는 데 시간이 걸린다
      const hrefs = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, "&")).filter((h) => /^https?:/.test(h));
      let lost = hrefs;
      for (let i = 0; i < 10 && lost.length; i++) {
        await page.waitForTimeout(1000);
        const inEditor = await editorLinks(f);
        lost = hrefs.filter((h) => !inEditor.includes(h));
      }
      if (lost.length) throw new Error(`링크가 에디터에 안 들어갔습니다: ${lost.join(", ")}`);
    });

    await step("발행 창", () => f.locator("[class^='publish_btn__']").first().click({ timeout: 10000 }));

    // 기본 카테고리는 "서울 맛집" 이라 상품·일상 글은 옮긴다. 주제는 카테고리에 딸려 바뀐다.
    // 음식점은 지역·혼밥이 갈려 기본값에 둔다. 블로그에 그 카테고리가 없으면 기본값으로 둔다
    // 앞의 것부터 블로그에 있는 첫 카테고리를 고른다
    const categories = [post.category, NAVER_CATEGORY[post.kind]].filter(Boolean);
    if (categories.length) {
      await step("카테고리", async () => {
        await f.locator("[class^='selectbox_button__']").first().click({ timeout: 5000 });
        for (const category of categories) {
          const item = f
            .locator("[class^='option_list_layer__'] [class^='item__']")
            .filter({ hasText: new RegExp(`^\\s*${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) });
          if (await item.count()) {
            await item.first().click();
            return;
          }
          console.log(`- 카테고리 "${category}" 가 블로그에 없음`);
        }
        await f.locator("[class^='selectbox_button__']").first().click();
      });
    }

    const tags = Array.isArray(post.tags) ? post.tags.slice(0, 10) : [];
    if (tags.length) {
      await step("태그", async () => {
        const input = f.locator("#tag-input").first();
        for (const t of tags) {
          await input.fill(String(t).replace(/^#/, ""));
          await input.press("Enter");
        }
      });
    }

    await step("공개 범위", async () => {
      const id = isPrivate ? "open_private" : "open_public";
      await f.locator(`label[for="${id}"]`).click({ timeout: 5000 });
      if (!(await f.locator(`#${id}`).isChecked())) throw new Error(`#${id} 가 선택되지 않았습니다`);
    });
    if (dryRun) {
      const cat = await f.locator("[class^='selectbox_button__']").first().innerText().catch(() => "?");
      console.log(`- 에디터 링크: ${JSON.stringify(await editorLinks(f))} · 카테고리: ${cat}`);
      await page.screenshot({ path: "naver-dryrun.png", fullPage: true });
      console.log(`#${id} 시험 — 발행 확인 직전에서 멈춤 (naver-dryrun.png)`);
      return;
    }
    await step("발행", async () => {
      // 발행 창 안의 확인 버튼. 위쪽 "발행" 은 창을 여는 버튼이다
      await f.locator("[data-testid='seOnePublishBtn']").click({ timeout: 5000 });
      await page.waitForURL(/PostView|logNo=|\/\d{9,}/, { timeout: 30000 });
    });

    const url = page.url();
    // 대기열에 없는 글(자동 정보 글)은 visit_posts 에 행이 없다
    if (!isPrivate && !post.virtual) {
      await updateVisitPost(id, { status: "posted" });
      await removeQueued(id);
    }
    console.log(`#${id} ${isPrivate ? "비공개로" : "공개로"} 발행 — ${url}`);
    return url;
  } catch (e) {
    await page.screenshot({ path: "naver-fail.png", fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

// 다른 스크립트가 publishPost 만 가져다 쓸 때는 명령을 돌리지 않는다
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) try {
  switch (cmd) {
    case "list": {
      const ids = await listQueuedIds();
      const count = { restaurant: 0, product: 0, daily: 0 };
      for (const id of ids) {
        const p = await getVisitPost(id);
        if (!p) continue;
        count[p.kind] = (count[p.kind] ?? 0) + 1;
        console.log(`#${id}\t${p.status}\t${p.kind}\t${p.title || p.titles?.[0] || ""}\t${String(p.updated_at).slice(0, 10)}`);
      }
      // 종류별 하루 한 편이라 종류마다 남은 편수가 곧 며칠 치인지다
      console.log(`대기열 ${ids.length}편 — 음식점 ${count.restaurant} · 상품 ${count.product} · 일상 ${count.daily}`);
      break;
    }
    case "show": {
      const id = Number(idArg);
      const p = await getVisitPost(id);
      const html = await getQueued(id);
      if (!p || !html) throw new Error("글이나 완성본이 없습니다.");
      console.log(`제목: ${p.title || p.titles?.[0]}\n종류: ${p.kind}\n태그: ${(p.tags ?? []).join(", ")}\n`);
      console.log(`경고: ${JSON.stringify(p.warnings)}\n확인 필요: ${JSON.stringify(p.needs_check)}\n`);
      console.log(text(html));
      break;
    }
    case "publish":
      await publish(Number(idArg));
      break;
    case "link": {
      // 세시간전 링크 하나만 만든다(확인용). link <상품주소> [상품명]
      const { chromium } = loadPlaywright();
      const browser = await chromium.launch();
      try {
        const name = args.filter((a) => !a.startsWith("--"))[2] || "상품";
        const made = await createThreeHoursLinks(browser, [{ url: idArg, name }], "backoffice link");
        console.log(made[idArg]);
      } finally {
        await browser.close();
      }
      break;
    }
    default:
      console.error("사용법: naver-publish.mjs <list|show|publish|link> [id|상품주소] [--private] [--no-ai-image]");
      process.exit(1);
  }
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
