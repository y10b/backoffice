/**
 * 네이버 블로그 자동 발행. .claude/skills/naver-publish 가 부른다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/naver-publish.mjs list            대기열 (올릴 준비 + 완성본 있음)
 *   node --import ./scripts/ts-register.mjs scripts/naver-publish.mjs show <id>       제목·태그·본문 텍스트
 *   node --import ./scripts/ts-register.mjs scripts/naver-publish.mjs publish <id> [--private]
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
import { getSettings, getVisitPost, updateVisitPost } from "../src/lib/db.ts";
import { getQueued, listQueuedIds, removeQueued } from "../src/lib/naverQueue.ts";

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
async function pasteBody(page, f, html) {
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

const text = (html) => html.replace(/<img[^>]*>/g, "[이미지]").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function publish(id) {
  const post = await getVisitPost(id);
  if (!post) throw new Error(`${id}번 글이 없습니다.`);
  if (post.status !== "ready") throw new Error(`${id}번은 올릴 준비(ready)가 아니라 ${post.status} 입니다.`);
  const html = await getQueued(id);
  if (!html) throw new Error(`${id}번 완성본이 대기열에 없습니다. /visit 에서 "자동 발행 맡기기" 를 다시 누르세요.`);
  const title = (post.title || post.titles?.[0] || "").trim();
  if (!title) throw new Error(`${id}번은 제목이 없습니다.`);

  const { aut, ses, blogId: savedId } = await creds();
  if (!aut || !ses) throw new Error("NID_AUT · NID_SES 가 없습니다. 브라우저의 네이버 로그인 쿠키를 환경에 넣으세요.");

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
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
    });

    await step("발행 창", () => f.locator("[class^='publish_btn__']").first().click({ timeout: 10000 }));

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
    await step("발행", async () => {
      // 발행 창 안의 확인 버튼. 위쪽 "발행" 은 창을 여는 버튼이다
      await f.locator("[data-testid='seOnePublishBtn']").click({ timeout: 5000 });
      await page.waitForURL(/PostView|logNo=|\/\d{9,}/, { timeout: 30000 });
    });

    const url = page.url();
    if (!isPrivate) {
      await updateVisitPost(id, { status: "posted" });
      await removeQueued(id);
    }
    console.log(`#${id} ${isPrivate ? "비공개로" : "공개로"} 발행 — ${url}`);
  } catch (e) {
    await page.screenshot({ path: "naver-fail.png", fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

try {
  switch (cmd) {
    case "list": {
      const ids = await listQueuedIds();
      for (const id of ids) {
        const p = await getVisitPost(id);
        if (!p) continue;
        console.log(`#${id}\t${p.status}\t${p.kind}\t${p.title || p.titles?.[0] || ""}\t${String(p.updated_at).slice(0, 10)}`);
      }
      console.log(`대기열 ${ids.length}편`);
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
    default:
      console.error("사용법: naver-publish.mjs <list|show|publish> [id] [--private]");
      process.exit(1);
  }
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
