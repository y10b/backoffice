/**
 * 개발 로그 초안을 사람 대신 검토할 때 쓰는 손잡이. 화면의 승인·버리기 버튼과 같은 일을 한다.
 * .claude/skills/devlog-publish 가 이걸로 초안을 읽고, 고치고, 승인한다.
 *
 *   node --import ./scripts/ts-register.mjs scripts/devlog-review.mjs list            검토 대기 초안 (본문 포함)
 *   node --import ./scripts/ts-register.mjs scripts/devlog-review.mjs edit <id> <file.md> [제목]
 *   node --import ./scripts/ts-register.mjs scripts/devlog-review.mjs approve <id>
 *   node --import ./scripts/ts-register.mjs scripts/devlog-review.mjs drop <id> <사유>
 *
 * list 는 제목·본문을 그대로 찍는다 — 깃액션(공개 로그)에서 돌리지 않는다.
 */
import { readFileSync } from "node:fs";
import { getVelogPost, listVelogPostsByStatus, updateVelogPost } from "../src/lib/db.ts";

const [cmd, idArg, ...rest] = process.argv.slice(2);
const id = Number(idArg);

async function draftOrDie() {
  if (!Number.isInteger(id)) throw new Error("id 가 숫자가 아닙니다.");
  const row = await getVelogPost(id);
  if (!row) throw new Error(`${id}번 글이 없습니다.`);
  if (row.status !== "draft") throw new Error(`${id}번은 검토 대기(draft)가 아니라 ${row.status} 입니다.`);
  return row;
}

try {
  switch (cmd) {
    case "list": {
      const rows = await listVelogPostsByStatus("draft");
      if (!rows.length) console.log("검토 대기 초안 없음");
      for (const r of rows) {
        console.log(`=== #${r.id} ${r.title}`);
        console.log(`source: ${r.source} · 비공개 레포: ${r.from_private} · tags: ${r.tags.join(", ")}`);
        console.log(r.body_markdown);
        console.log();
      }
      break;
    }
    case "edit": {
      await draftOrDie();
      const [file, title] = rest;
      if (!file) throw new Error("본문 파일 경로가 필요합니다.");
      const body = readFileSync(file, "utf8").trim();
      await updateVelogPost(id, { body_markdown: body, ...(title ? { title } : {}) });
      console.log(`#${id} 본문 갱신 (${body.length}자)`);
      break;
    }
    case "approve":
      await draftOrDie();
      await updateVelogPost(id, { status: "approved", error: "" });
      console.log(`#${id} 발행 승인`);
      break;
    case "drop": {
      await draftOrDie();
      const reason = rest.join(" ").trim();
      if (!reason) throw new Error("버리는 사유를 적으세요.");
      await updateVelogPost(id, { status: "dropped", error: reason });
      console.log(`#${id} 버림 — ${reason}`);
      break;
    }
    default:
      console.error("사용법: devlog-review.mjs <list|edit|approve|drop> ...");
      process.exit(1);
  }
} catch (e) {
  console.error(`- 실패: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
