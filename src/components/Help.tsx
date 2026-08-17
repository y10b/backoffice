/**
 * 사용법 툴팁.
 *
 * 브라우저 기본 `title=` 은 어포던스가 없어서 있는 줄도 모르고, 뜨는 데 1초 넘게 걸린다.
 * 표 컬럼처럼 "이 숫자가 뭔지"만 알려주면 되는 자리에는 `title` 이 낫지만, "이걸 어떻게
 * 쓰는지"는 눈에 보이는 표시가 있어야 읽힌다.
 *
 * 서버 컴포넌트로 둔다. 상태가 없고 CSS 만으로 뜨고 지므로 클라이언트 번들에 넣을 이유가 없다.
 *
 * 주의: `.table-wrap`(overflow-x: auto) 안에서는 툴팁이 잘린다. 표 안에서는 `title` 을 쓰고
 * 이 컴포넌트는 카드·라벨·버튼 옆에 둔다.
 */
export default function Help({
  text,
  /** 왼쪽으로 펼친다. 화면 오른쪽 끝에 붙은 컨트롤에 쓴다 */
  left,
}: {
  text: string;
  left?: boolean;
}) {
  return (
    <span
      className={`help${left ? " help-left" : ""}`}
      // 키보드로도 읽을 수 있어야 한다. aria-label 에 본문을 넣어 스크린리더가 바로 읽는다
      tabIndex={0}
      role="note"
      aria-label={`도움말: ${text}`}
    >
      <span aria-hidden="true">?</span>
      <span className="help-tip" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
