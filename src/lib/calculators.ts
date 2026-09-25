/**
 * 글에 끼워 넣는 계산기 두 개 (티스토리 HTML 모드에 그대로 붙는다).
 *
 * 왜 계산기인가: "3.3% 환급", "세금계산기" 같은 검색어는 읽을거리보다 숫자를 원한다.
 * 글 안에서 바로 계산되면 체류시간이 늘고, 계산 버튼이 calculator_use 이벤트를 쏴서
 * 어떤 글이 실제로 "쓰이는지" GA4 로 보인다 (주요 이벤트·calc_type 은 ga4Admin.ts 가 만든다).
 *
 * 지키는 선:
 * - 외부 의존 없음. 인라인 스타일 + <script> 하나. 티스토리 스킨 CSS 와 부딪히지 않게
 *   id 는 접두어를 붙이고 스크립트는 즉시 실행 함수로 가둔다.
 * - 계산 로직은 CORE_JS 한 벌뿐이다. 브라우저에는 이 문자열이 그대로 들어가고, 서버·테스트는
 *   같은 문자열을 new Function 으로 평가해 쓴다 — 두 벌로 짜면 한쪽만 고쳐 조용히 어긋난다.
 * - 결과는 추정치라고 반드시 밝힌다. 세금 숫자가 틀리면 블로그 신뢰가 통째로 무너진다.
 */

export type CalculatorId = "freelancer33" | "taxCalc";

/** 기본공제(본인 150만)만 가정한다. 부양가족·연금·노란우산 등은 사람마다 달라 넣지 않는다 */
export const BASIC_DEDUCTION = 1_500_000;

/*
 * 브라우저와 서버가 같이 쓰는 계산 로직 (ES5, 템플릿 리터럴 없음).
 * 원 단위 처리: 원천징수 소득세는 10원 미만 절사, 지방소득세는 소득세의 10% 를 10원 미만 절사.
 * 종합소득세 추정은 원 단위 반올림 — 추정치라 절사 규칙까지 흉내 낼 의미가 없다.
 */
const CORE_JS = `
// 종합소득세 기본세율 (2023년 귀속부터). [과세표준 상한, 세율, 누진공제] — 10억 초과는 TOP
var BR = [[14000000,0.06,0],[50000000,0.15,1260000],[88000000,0.24,5760000],[150000000,0.35,15440000],[300000000,0.38,19940000],[500000000,0.40,25940000],[1000000000,0.42,35940000]];
var TOP = [0.45, 65940000];
var BASIC = ${BASIC_DEDUCTION};
function floor10(n){ return Math.floor(n / 10) * 10; }
function withholding33(amount){
  var a = Math.max(0, Math.floor(amount || 0));
  var incomeTax = floor10(a * 0.03);
  var localTax = floor10(incomeTax * 0.1);
  return { amount: a, incomeTax: incomeTax, localTax: localTax, total: incomeTax + localTax, net: a - incomeTax - localTax };
}
function taxOnBase(base){
  var b = Math.max(0, Math.floor(base || 0));
  var rate = TOP[0], ded = TOP[1];
  for (var i = 0; i < BR.length; i++) { if (b <= BR[i][0]) { rate = BR[i][1]; ded = BR[i][2]; break; } }
  var tax = Math.max(0, Math.round(b * rate - ded));
  var localTax = Math.round(tax * 0.1);
  return { base: b, rate: rate, tax: tax, localTax: localTax, total: tax + localTax, effectiveRate: b > 0 ? (tax + localTax) / b : 0 };
}
function estimateIncomeTax(annualIncome, expenseRatePct){
  var income = Math.max(0, Math.floor(annualIncome || 0));
  var r = Math.min(100, Math.max(0, Number(expenseRatePct) || 0));
  var incomeAmount = Math.round(income * (1 - r / 100));
  var base = Math.max(0, incomeAmount - BASIC);
  var t = taxOnBase(base);
  var prepaid = withholding33(income).total;
  return { income: income, expenseRate: r, incomeAmount: incomeAmount, base: base, rate: t.rate, tax: t.tax, localTax: t.localTax, total: t.total, prepaid: prepaid, refund: prepaid - t.total };
}
function vatFromSupply(supply){
  var s = Math.max(0, Math.round(supply || 0));
  var v = Math.round(s * 0.1);
  return { supply: s, vat: v, total: s + v };
}
function vatFromTotal(total){
  var t = Math.max(0, Math.round(total || 0));
  var s = Math.round(t / 1.1);
  return { supply: s, vat: t - s, total: t };
}
`;

type Withholding = { amount: number; incomeTax: number; localTax: number; total: number; net: number };
type BaseTax = { base: number; rate: number; tax: number; localTax: number; total: number; effectiveRate: number };
type IncomeEstimate = {
  income: number;
  expenseRate: number;
  incomeAmount: number;
  base: number;
  rate: number;
  tax: number;
  localTax: number;
  total: number;
  prepaid: number;
  /** 양수면 환급, 음수면 추가 납부 */
  refund: number;
};
type Vat = { supply: number; vat: number; total: number };

type Core = {
  withholding33(amount: number): Withholding;
  taxOnBase(base: number): BaseTax;
  estimateIncomeTax(annualIncome: number, expenseRatePct: number): IncomeEstimate;
  vatFromSupply(supply: number): Vat;
  vatFromTotal(total: number): Vat;
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const core = new Function(
  `${CORE_JS}\nreturn { withholding33: withholding33, taxOnBase: taxOnBase, estimateIncomeTax: estimateIncomeTax, vatFromSupply: vatFromSupply, vatFromTotal: vatFromTotal };`,
)() as Core;

/** 3.3% 원천징수 (소득세 3% + 지방소득세 0.3%) */
export const withholding33 = (amount: number): Withholding => core.withholding33(amount);
/** 과세표준 → 산출세액·지방소득세·합계·실효세율 */
export const taxOnBase = (base: number): BaseTax => core.taxOnBase(base);
/** 연 수입 · 단순경비율(%) → 종합소득세 추정과 기납부 3.3% 비교 */
export const estimateIncomeTax = (annualIncome: number, expenseRatePct: number): IncomeEstimate =>
  core.estimateIncomeTax(annualIncome, expenseRatePct);
export const vatFromSupply = (supply: number): Vat => core.vatFromSupply(supply);
export const vatFromTotal = (total: number): Vat => core.vatFromTotal(total);

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

const NOTICE =
  "추정치이며 실제 세액은 공제·감면에 따라 달라집니다. 홈택스 모의계산으로 확인하세요.";

const S = {
  box: "max-width:560px;margin:24px auto;padding:18px 16px;border:1px solid #d9dee5;border-radius:12px;background:#f8fafc;font-size:15px;line-height:1.6;color:#1f2937;box-sizing:border-box;",
  title: "margin:0 0 12px;font-size:17px;font-weight:700;",
  label: "display:block;margin:10px 0 4px;font-weight:600;font-size:14px;",
  input: "width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px;background:#fff;",
  btn: "display:block;width:100%;margin-top:12px;padding:11px 0;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;font-weight:700;cursor:pointer;",
  out: "margin-top:12px;padding:12px;border-radius:8px;background:#fff;border:1px solid #e5e7eb;font-size:14px;",
  hint: "margin:4px 0 0;font-size:12px;color:#6b7280;",
  notice: "margin:10px 0 0;font-size:12px;color:#6b7280;",
  h: "margin:18px 0 4px;font-size:15px;font-weight:700;border-top:1px dashed #cbd5e1;padding-top:14px;",
  tab: "flex:1;padding:9px 0;border:1px solid #cbd5e1;background:#fff;font-size:14px;font-weight:600;cursor:pointer;",
};

/** 브라우저 쪽 공통 도우미. 숫자 파싱·표시·이벤트 전송 */
const HELPERS_JS = `
function num(el){ var v = String(el.value || '').replace(/[^0-9.]/g, ''); return v ? Number(v) : 0; }
function won(n){ return Math.round(n).toLocaleString('ko-KR') + '원'; }
function pct(n){ return (Math.round(n * 1000) / 10) + '%'; }
function track(t){ try { if (window.gtag) gtag('event', 'calculator_use', { calc_type: t }); } catch (e) {} }
function row(k, v, strong){ return '<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;"><span>' + k + '</span><span style="' + (strong ? 'font-weight:700;' : '') + '">' + v + '</span></div>'; }
`;

function freelancer33Html(): string {
  return `<div id="calc33" style="${S.box}">
<p style="${S.title}">3.3% 원천징수 · 종합소득세 환급 계산기</p>
<label for="calc33-amt" style="${S.label}">지급액 (세전)</label>
<input id="calc33-amt" type="text" inputmode="numeric" placeholder="예: 1000000" style="${S.input}">
<button type="button" id="calc33-btn1" style="${S.btn}">3.3% 계산</button>
<div id="calc33-out1" style="${S.out}display:none;"></div>
<p style="${S.h}">종합소득세 예상 (환급 / 추가 납부)</p>
<label for="calc33-year" style="${S.label}">연 수입 (3.3% 떼기 전 합계)</label>
<input id="calc33-year" type="text" inputmode="numeric" placeholder="예: 24000000" style="${S.input}">
<label for="calc33-rate" style="${S.label}">단순경비율 (%)</label>
<input id="calc33-rate" type="text" inputmode="decimal" placeholder="업종코드별 경비율 — 홈택스 '기준·단순경비율' 조회" style="${S.input}">
<p style="${S.hint}">경비율은 업종마다 다릅니다. 본인 업종코드의 단순경비율을 직접 넣으세요.</p>
<button type="button" id="calc33-btn2" style="${S.btn}">종합소득세 추정</button>
<div id="calc33-out2" style="${S.out}display:none;"></div>
<p style="${S.notice}">${NOTICE}</p>
<script>(function(){
${CORE_JS}
${HELPERS_JS}
var $ = function(id){ return document.getElementById(id); };
$('calc33-btn1').onclick = function(){
  var r = withholding33(num($('calc33-amt')));
  var o = $('calc33-out1');
  o.innerHTML = row('소득세 (3%)', won(r.incomeTax)) + row('지방소득세 (0.3%)', won(r.localTax)) + row('원천징수 합계', won(r.total)) + row('실수령액', won(r.net), true);
  o.style.display = 'block';
  track('freelancer33');
};
$('calc33-btn2').onclick = function(){
  var o = $('calc33-out2');
  if (!String($('calc33-rate').value || '').trim()) { o.innerHTML = '단순경비율(%)을 입력하세요.'; o.style.display = 'block'; return; }
  var r = estimateIncomeTax(num($('calc33-year')), num($('calc33-rate')));
  var verdict = r.refund >= 0 ? row('예상 환급액', won(r.refund), true) : row('예상 추가 납부', won(-r.refund), true);
  o.innerHTML = row('소득금액 (수입 − 경비)', won(r.incomeAmount)) + row('과세표준 (기본공제 150만 가정)', won(r.base)) + row('적용 세율', pct(r.rate)) + row('산출세액', won(r.tax)) + row('지방소득세 (10%)', won(r.localTax)) + row('결정세액 합계', won(r.total)) + row('이미 낸 3.3%', won(r.prepaid)) + verdict;
  o.style.display = 'block';
  track('freelancer33');
};
})();</script>
</div>`;
}

function taxCalcHtml(): string {
  return `<div id="taxc" style="${S.box}">
<p style="${S.title}">세금 계산기 — 부가세 · 종합소득세</p>
<div style="display:flex;gap:0;margin-bottom:6px;">
<button type="button" id="taxc-t1" style="${S.tab}border-radius:8px 0 0 8px;background:#2563eb;color:#fff;">부가세</button>
<button type="button" id="taxc-t2" style="${S.tab}border-radius:0 8px 8px 0;">종합소득세</button>
</div>
<div id="taxc-p1">
<label for="taxc-mode" style="${S.label}">입력 기준</label>
<select id="taxc-mode" style="${S.input}"><option value="supply">공급가액 → 합계</option><option value="total">합계금액 → 공급가액</option></select>
<label for="taxc-vamt" style="${S.label}">금액</label>
<input id="taxc-vamt" type="text" inputmode="numeric" placeholder="예: 1000000" style="${S.input}">
<button type="button" id="taxc-vbtn" style="${S.btn}">부가세 계산 (10%)</button>
<div id="taxc-vout" style="${S.out}display:none;"></div>
</div>
<div id="taxc-p2" style="display:none;">
<label for="taxc-base" style="${S.label}">과세표준</label>
<input id="taxc-base" type="text" inputmode="numeric" placeholder="예: 30000000" style="${S.input}">
<p style="${S.hint}">과세표준 = 소득금액 − 소득공제. 모르면 위 계산기나 홈택스 모의계산을 쓰세요.</p>
<button type="button" id="taxc-ibtn" style="${S.btn}">종합소득세 계산</button>
<div id="taxc-iout" style="${S.out}display:none;"></div>
</div>
<p style="${S.notice}">${NOTICE}</p>
<script>(function(){
${CORE_JS}
${HELPERS_JS}
var $ = function(id){ return document.getElementById(id); };
function tab(n){
  $('taxc-p1').style.display = n === 1 ? 'block' : 'none';
  $('taxc-p2').style.display = n === 2 ? 'block' : 'none';
  $('taxc-t1').style.background = n === 1 ? '#2563eb' : '#fff'; $('taxc-t1').style.color = n === 1 ? '#fff' : '#1f2937';
  $('taxc-t2').style.background = n === 2 ? '#2563eb' : '#fff'; $('taxc-t2').style.color = n === 2 ? '#fff' : '#1f2937';
}
$('taxc-t1').onclick = function(){ tab(1); };
$('taxc-t2').onclick = function(){ tab(2); };
$('taxc-vbtn').onclick = function(){
  var a = num($('taxc-vamt'));
  var r = $('taxc-mode').value === 'total' ? vatFromTotal(a) : vatFromSupply(a);
  var o = $('taxc-vout');
  o.innerHTML = row('공급가액', won(r.supply)) + row('부가세 (10%)', won(r.vat), true) + row('합계금액', won(r.total));
  o.style.display = 'block';
  track('vat');
};
$('taxc-ibtn').onclick = function(){
  var r = taxOnBase(num($('taxc-base')));
  var o = $('taxc-iout');
  o.innerHTML = row('적용 세율', pct(r.rate)) + row('산출세액', won(r.tax)) + row('지방소득세 (10%)', won(r.localTax)) + row('합계', won(r.total), true) + row('실효세율', pct(r.effectiveRate));
  o.style.display = 'block';
  track('income_tax');
};
})();</script>
</div>`;
}

export function calculatorHtml(id: CalculatorId): string {
  return id === "freelancer33" ? freelancer33Html() : taxCalcHtml();
}

/** 키워드로 계산기를 고른다. 3.3 이 들어가면 원천징수 계산기, 아니면 세금 계산기 */
export function pickCalculator(keyword: string): CalculatorId {
  return /3\.3/.test(keyword) ? "freelancer33" : "taxCalc";
}

/** 마크다운 본문의 자리표시. 사람이 손질할 때 어디에 들어가는지 보이게 남긴다 */
export function calculatorPlaceholder(id: CalculatorId): string {
  return `[계산기: ${id}]`;
}

/** 첫 소제목 앞에 끼운다. 소제목이 없으면 맨 끝 */
function insertBefore(text: string, marker: RegExp, piece: string, sep: string): string {
  const m = marker.exec(text);
  if (!m) return `${text}${sep}${piece}`;
  return `${text.slice(0, m.index)}${piece}${sep}${text.slice(m.index)}`;
}

export function insertCalculatorHtml(html: string, id: CalculatorId): string {
  return insertBefore(html, /<h2[\s>]/i, calculatorHtml(id), "\n");
}

export function insertCalculatorMarkdown(md: string, id: CalculatorId): string {
  return insertBefore(md, /^##\s/m, calculatorPlaceholder(id), "\n\n");
}
