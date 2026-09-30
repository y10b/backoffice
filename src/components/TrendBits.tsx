/**
 * 트렌드 목록에 공통으로 쓰는 작은 조각. 제철 트렌드(/eat)와 상품 트렌드(/products)가 같이 쓴다.
 */

export function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="badge off">추세 없음</span>;
  const up = delta > 0;
  return (
    <span
      className="badge"
      style={{
        background: up ? "var(--green-tint)" : "var(--danger-tint)",
        color: up ? "var(--green-text)" : "var(--danger-text)",
      }}
    >
      {up ? "▲" : "▼"} {Math.abs(delta)}%
    </span>
  );
}

/** 석 달 흐름을 한눈에. 묶음마다 따로 정규화된 값이라 모양만 보고 높이는 비교하지 않는다 */
export function Sparkline({ data }: { data: { ratio: number }[] }) {
  if (data.length < 2) return null;
  const w = 72;
  const h = 22;
  const max = Math.max(...data.map((d) => d.ratio), 1);
  const pts = data
    .map((d, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - (d.ratio / max) * (h - 2) - 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ flex: "0 0 auto", color: "var(--text-dim)" }}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
