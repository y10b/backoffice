/**
 * 미리캔버스 디자인허브 메타데이터 CSV.
 *
 * 형식은 디자인허브 헬프센터 "CSV 파일 작성 방법" · "UNIQUE ID 를 사용하여/사용하지 않고" 기준이다.
 *  - 열 순서: fileName, uniqueId, elementName, keywords, tier, contentType
 *    처음엔 uniqueId 열을 빼고 만들었다가 16행이 전부 "알 수 없는 이유" 로 실패했다. 양식 그대로
 *    열을 두고, uniqueId 는 모르면 비워 둔다(파일명이 모두 고유하면 파일명으로 맞춘다)
 *  - fileName: 올린 파일명과 정확히 같게, **확장자 없이**
 *  - elementName: 100자 이내, 특수기호 불가, 한글·영어만
 *  - keywords: 쉼표 구분, 25개 이내, 한 키워드 50자 이내, 하이픈 말고는 특수문자 불가
 *  - tier: "Premium"(유료, 로열티 발생) | "Standard"(무료, 로열티 없음)
 *  - contentType: 투명 배경 일러스트는 PNG 요소. 문서 본문은 "PNG element", 예시 화면은 "PNGelement" 로
 *    표기가 엇갈린다 — 그래서 디자인허브가 내려준 양식에 채워 넣는 mergeMiriTemplate 를 따로 둔다
 *  - UTF-8 로 저장(BOM 을 붙인다). 엑셀로 한글을 넣을 땐 XLSX 로 내라고 하지만, 여기선 엑셀을 거치지 않는다
 */

export type MiriRow = { fileName: string; elementName: string; keywords: string[] };

export const MIRI_HEADERS = ["fileName", "uniqueId", "elementName", "keywords", "tier", "contentType"] as const;

const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
const stripExt = (s: string) => s.replace(/\.(png|jpe?g|svg|gif)$/i, "");

/** 한글·영어·숫자·공백만 남긴다. 가운뎃점 등은 공백으로 */
export function cleanName(s: string): string {
  return s.replace(/[^0-9A-Za-z가-힣\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

/** 하이픈 말고 특수문자를 지우고, 중복·빈 값을 빼고, 25개까지 */
export function cleanKeywords(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const k = raw.replace(/[^0-9A-Za-z가-힣\s-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length === 25) break;
  }
  return out;
}

const toCsv = (rows: string[][]) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

export function miriCsv(rows: MiriRow[], tier: "Premium" | "Standard" = "Premium"): string {
  return toCsv([
    [...MIRI_HEADERS],
    ...rows.map((r) => [
      stripExt(r.fileName),
      "",
      cleanName(r.elementName),
      cleanKeywords(r.keywords).join(","),
      tier,
      "PNG element",
    ]),
  ]);
}

/** 따옴표·쉼표·줄바꿈을 지키는 작은 CSV 파서. BOM 은 뗀다 */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export type MergeResult = { csv: string; filled: number; missing: string[]; total: number };

/**
 * 디자인허브가 내려준 양식("업로드된 모든 콘텐츠 CSV 다운로드")에 우리 제목·키워드를 채운다.
 *
 * uniqueId·contentType 은 디자인허브가 넣어 준 값을 그대로 둔다 — 표기 문제를 피하는 가장 확실한 길이다.
 * 파일명(확장자 없이)으로 짝을 짓고, 못 찾은 행은 비워 두지 않고 원래 값 그대로 남긴다.
 * contentType 이 비어 있으면 fallbackType 으로 채운다.
 */
export function mergeMiriTemplate(
  templateText: string,
  ours: MiriRow[],
  o: { tier?: "Premium" | "Standard"; fallbackType?: string } = {},
): MergeResult {
  const rows = parseCsv(templateText);
  if (!rows.length) throw new Error("디자인허브 CSV 가 비어 있습니다.");
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iName = col("fileName");
  if (iName < 0) throw new Error("디자인허브 CSV 에 fileName 열이 없습니다. '업로드된 모든 콘텐츠 CSV 다운로드' 로 받은 파일인지 확인하세요.");
  const byName = new Map(ours.map((r) => [stripExt(r.fileName).trim(), r]));
  const missing: string[] = [];
  let filled = 0;
  const out = rows.slice(1).map((r) => {
    const next = header.map((_, i) => r[i] ?? "");
    const name = stripExt(next[iName] ?? "").trim();
    const mine = byName.get(name);
    if (!mine) {
      missing.push(name);
      return next;
    }
    const set = (h: string, v: string) => {
      const i = col(h);
      if (i >= 0) next[i] = v;
    };
    set("elementName", cleanName(mine.elementName));
    set("keywords", cleanKeywords(mine.keywords).join(","));
    set("tier", o.tier ?? "Premium");
    const iType = col("contentType");
    if (iType >= 0 && !next[iType].trim()) next[iType] = o.fallbackType ?? "PNG element";
    filled++;
    return next;
  });
  return { csv: toCsv([header, ...out]), filled, missing, total: out.length };
}
