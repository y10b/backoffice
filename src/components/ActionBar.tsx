import type { ReactNode } from "react";

/**
 * 상세(펼친 영역·편집 화면) 맨 아래 한 줄.
 *
 * 왼쪽 = 위험 동작(삭제 — 빨간 텍스트 버튼), 오른쪽 = 상태 전이 버튼들, 가장 오른쪽이 주 동작(primary).
 * 폰에서는 화면 아래에 붙는다(position: sticky + safe-area). 화면마다 버튼 자리가 달라지지 않게
 * 이 컴포넌트로만 둔다.
 */
export default function ActionBar({ danger, children }: { danger?: ReactNode; children: ReactNode }) {
  return (
    <div className="action-bar">
      <div className="action-bar-danger">{danger}</div>
      <div className="action-bar-main">{children}</div>
    </div>
  );
}
