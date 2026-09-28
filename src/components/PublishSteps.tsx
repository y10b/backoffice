"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * 발행 흐름 안내 — 복사 버튼을 감싼다.
 *
 * 네이버 블로그 앱·티스토리 앱 에디터는 클립보드에서 평문만 읽는다. 복사 방식을 아무리
 * 바꿔도 앱에서는 서식이 빠지므로, 폰에서는 "사파리 PC 에디터로 연다"를 첫 단계로 못 박는다.
 *   - 티스토리: PC 에디터를 HTML 모드로 바꾸고 HTML 소스를 붙인다 (확실히 된다)
 *   - 네이버: PC 스마트에디터 본문에 서식 복사를 붙인다
 *
 * 터치 기기에서만 번호 붙은 단계로 보이고, 데스크톱에서는 복사 버튼 + 작은 에디터 링크만 둔다.
 */
type Props = {
  channel: "tistory" | "naver";
  editorUrl: string;
  copyButtons: ReactNode;
  /** 기존 글 보강 초안이면 그 글 주소. 새 글 대신 기존 글을 고치게 안내한다 */
  rewriteOf?: string;
};

function useIsTouch(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    // 서버 렌더에는 창이 없으니 붙은 뒤에 한 번 판단한다
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    setTouch(mq.matches);
    const on = (e: MediaQueryListEvent) => setTouch(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return touch;
}

export default function PublishSteps({ channel, editorUrl, copyButtons, rewriteOf }: Props) {
  const touch = useIsTouch();
  const tistory = channel === "tistory";
  const rewrite = tistory && Boolean(rewriteOf);

  if (!touch) {
    return (
      <>
        <div className="row">{copyButtons}</div>
        <div className="row publish-links">
          {rewrite && (
            <a href={rewriteOf} target="_blank" rel="noopener noreferrer" className="link-btn">
              기존 글 열기 ↗
            </a>
          )}
          <a href={editorUrl} target="_blank" rel="noopener noreferrer" className="link-btn">
            {tistory ? "티스토리" : "네이버"} 에디터 열기 ↗
          </a>
        </div>
      </>
    );
  }

  const steps: { body: ReactNode }[] = [
    {
      body: (
        <>
          <div className="row publish-open">
            {rewrite ? (
              <>
                <a href={rewriteOf} target="_blank" rel="noopener noreferrer" className="publish-btn primary">
                  기존 글 열기
                </a>
                <a href={editorUrl} target="_blank" rel="noopener noreferrer" className="publish-btn">
                  새 글 에디터
                </a>
              </>
            ) : (
              <a href={editorUrl} target="_blank" rel="noopener noreferrer" className="publish-btn primary">
                에디터 열기
              </a>
            )}
          </div>
          <p className="hint">
            사파리에서 열고 주소창 <strong>가가 → 데스크탑 웹사이트 요청</strong>. 앱에서는 서식이
            빠집니다.
            {rewrite && " 기존 글에서 수정 → HTML 모드 → 본문 교체."}
          </p>
        </>
      ),
    },
    ...(tistory
      ? [{ body: <p className="publish-text">{rewrite ? "수정 화면에서 " : ""}오른쪽 위 모드를 <strong>HTML</strong> 로 바꾸기</p> }]
      : []),
    {
      body: (
        <>
          <div className="row">{copyButtons}</div>
          <p className="hint">
            {rewrite ? "기존 본문을 모두 지우고 붙여넣기(교체)" : "에디터 본문에 붙여넣기"}
          </p>
        </>
      ),
    },
  ];

  return (
    <ol className="publish-steps">
      {steps.map((s, i) => (
        <li key={i}>
          <span className="publish-num">{i + 1}</span>
          <div className="publish-body">{s.body}</div>
        </li>
      ))}
    </ol>
  );
}
