/**
 * 티스토리 초안을 브라우저로 발행한다. .claude/skills/tistory-publish 가 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/tistory-publish.mjs list          안 올린 초안
 *   node --import ./scripts/ts-register.mjs scripts/tistory-publish.mjs show <id>     본문 HTML
 *   node --import ./scripts/ts-register.mjs scripts/tistory-publish.mjs publish <id> [--private]
 *
 * 오픈 API 가 닫혀 에디터 화면을 사람처럼 누른다. 로그인은 카카오 아이디·비밀번호가 아니라
 * 브라우저의 TSSESSION 쿠키다 — 해외 IP 로그인은 2단계 인증에 막히고, 비밀번호를 쥐면
 * 애드센스·GA4 가 걸린 카카오 계정 전체를 쥐게 된다. 쿠키는 티스토리 글쓰기만 연다.
 *
 * 쿠키는 환경변수 TISTORY_SESSION → 설정 표 tistory_session 순서로 읽는다.
 * 셀렉터가 안 맞으면 스크린샷(tistory-fail.png)을 남기고 멈춘다 — 에디터가 바뀐 것이다.
 */
import { createRequire } from "node:module";
import { getPost, getSetting, listPosts, updatePost } from "../src/lib/db.ts";
import { tistoryBlogUrl } from "../src/lib/tistory.ts";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  // 의존성에 넣지 않았다 — 클라우드 세션 이미지에 전역으로 깔려 있다
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
const isPrivate = args.includes("--private");
const [cmd, idArg] = args.filter((a) => !a.startsWith("--"));

async function bodyOf(post) {
  const html = String(post.body_html ?? "").trim();
  const ld = String(post.json_ld ?? "").trim();
  // 화면의 "티스토리 본문" 복사 버튼과 같다 — 스키마를 따로 넣으면 빠뜨린다
  return ld ? `${html}\n\n${ld}` : html;
}

async function publish(id) {
  const post = await getPost(id);
  if (!post) throw new Error(`${id}번 글이 없습니다.`);
  if (post.posted_tistory) throw new Error(`${id}번은 이미 올린 글입니다.`);
  if (!post.title?.trim() || String(post.body_html ?? "").length < 500) {
    throw new Error(`${id}번은 제목이나 본문이 비어 있습니다.`);
  }
  const session = (process.env.TISTORY_SESSION || (await getSetting("tistory_session")) || "").trim();
  if (!session) throw new Error("TISTORY_SESSION 이 없습니다. 브라우저의 TSSESSION 쿠키를 환경에 넣으세요.");

  const origin = await tistoryBlogUrl();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 1000 } });
  await context.addCookies([
    { name: "TSSESSION", value: session, domain: ".tistory.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  // "이어서 작성할까요?" 는 거절(새 글), "작성 모드를 바꿀까요?" 는 수락
  page.on("dialog", (d) => (/모드/.test(d.message()) ? d.accept() : d.dismiss()));

  try {
    await page.goto(`${origin}/manage/newpost/?type=post`, { waitUntil: "domcontentloaded" });
    if (/accounts\.kakao|\/auth\/login/.test(page.url())) {
      throw new Error("로그인 페이지로 돌아갔습니다 — TSSESSION 쿠키가 만료됐습니다.");
    }

    const step = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        throw new Error(`${name} 단계 실패: ${String(e.message).split("\n")[0]}`);
      }
    };

    await step("제목", () => page.locator("#post-title-inp").fill(post.title, { timeout: 20000 }));

    await step("HTML 모드", async () => {
      await page.locator("#editor-mode-layer-btn-open").click();
      await page.locator("#editor-mode-html").click();
      await page.locator(".CodeMirror").waitFor({ timeout: 10000 });
    });
    const html = await bodyOf(post);
    await step("본문", () =>
      page.evaluate((v) => document.querySelector(".CodeMirror").CodeMirror.setValue(v), html),
    );

    if (post.category) {
      await step("카테고리", async () => {
        await page.locator("#category-btn").click();
        const item = page.locator("#category-list [role=option], #category-list .mce-menu-item").filter({ hasText: post.category });
        if (await item.count()) await item.first().click();
        else await page.keyboard.press("Escape"); // 없는 카테고리면 기본 분류로 둔다
      });
    }

    const tags = Array.isArray(post.tags) ? post.tags.slice(0, 10) : [];
    if (tags.length) {
      await step("태그", async () => {
        const input = page.locator("#tagText");
        for (const t of tags) {
          await input.fill(String(t).replace(/^#/, ""));
          await input.press("Enter");
        }
      });
    }

    await step("발행 창", () => page.locator("#publish-layer-btn").click());
    await step("공개 범위", () => page.locator(isPrivate ? "#open0" : "#open20").check({ force: true }));
    await step("발행", async () => {
      await Promise.all([
        page.waitForURL(/\/manage\/posts/, { timeout: 30000 }),
        page.locator("#publish-btn").click(),
      ]);
    });

    // 비공개 시험 발행은 '올림'으로 치지 않는다 — 공개로 다시 올릴 수 있게
    if (!isPrivate) await updatePost(id, { posted_tistory: true });
    console.log(`#${id} ${isPrivate ? "비공개로" : "공개로"} 발행 — ${origin}/manage/posts 에서 확인`);
  } catch (e) {
    await page.screenshot({ path: "tistory-fail.png", fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

try {
  switch (cmd) {
    case "list": {
      const rows = (await listPosts(300)).filter((p) => !p.posted_tistory);
      for (const p of rows) {
        console.log(`#${p.id}\t${p.status}\t${p.main_keyword}\t${p.title}\t${String(p.created_at).slice(0, 10)}`);
      }
      console.log(`안 올린 초안 ${rows.length}편`);
      break;
    }
    case "show": {
      const p = await getPost(Number(idArg));
      if (!p) throw new Error("글이 없습니다.");
      console.log(`제목: ${p.title}\n키워드: ${p.main_keyword}\n카테고리: ${p.category}\n태그: ${(p.tags ?? []).join(", ")}\n`);
      console.log(await bodyOf(p));
      break;
    }
    case "publish":
      await publish(Number(idArg));
      break;
    default:
      console.error("사용법: tistory-publish.mjs <list|show|publish> [id] [--private]");
      process.exit(1);
  }
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
