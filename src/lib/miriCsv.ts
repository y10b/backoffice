/**
 * 미리캔버스 디자인허브 메타데이터 CSV.
 *
 * 형식은 디자인허브 헬프센터 "CSV 파일 작성 방법" 기준이다.
 *  - 열: fileName, elementName, keywords, tier, contentType (uniqueId 는 선택 — 파일명으로 맞춘다)
 *  - fileName: 올린 파일명과 정확히 같게, **확장자 없이**
 *  - elementName: 100자 이내, 특수기호 불가, 한글·영어만
 *  - keywords: 쉼표 구분, 25개 이내, 한 키워드 50자 이내, 하이픈 말고는 특수문자 불가
 *  - tier: "Premium"(유료, 로열티 발생) | "Standard"(무료, 로열티 없음)
 *  - contentType: 투명 배경 일러스트는 "PNG element" — 사진으로 넣으면 비공개 처리될 수 있다
 *  - UTF-8 로 저장(한글이 깨지지 않게 BOM 을 붙인다)
 */

export type MiriRow = { fileName: string; elementName: string; keywords: string[] };

const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;

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

export function miriCsv(rows: MiriRow[], tier: "Premium" | "Standard" = "Premium"): string {
  const lines = [["fileName", "elementName", "keywords", "tier", "contentType"].join(",")];
  for (const r of rows) {
    lines.push(
      [
        cell(r.fileName.replace(/\.(png|jpe?g|svg|gif)$/i, "")),
        cell(cleanName(r.elementName)),
        cell(cleanKeywords(r.keywords).join(",")),
        cell(tier),
        cell("PNG element"),
      ].join(","),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
