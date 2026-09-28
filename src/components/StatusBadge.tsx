/**
 * 목록 행 오른쪽 끝·상세 머리에 붙는 상태 배지. 화면마다 상태 이름이 달라도 색은 다섯 가지로만 쓴다.
 *
 *   draft  초안·검토 대기 (회색)
 *   ready  준비·승인      (파랑)
 *   done   발행됨·올림    (초록)
 *   hold   보류           (주황)
 *   error  오류           (빨강)
 */
export type StatusTone = "draft" | "ready" | "done" | "hold" | "error";

export default function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}
