"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "키워드 탐색" },
  { href: "/write", label: "글 작성" },
  // 키워드가 아니라 사진에서 출발하는 갈래. 방향이 반대라 글 작성과 섞지 않는다
  { href: "/visit", label: "방문 후기" },
  { href: "/posts", label: "글 목록" },
  // 깃 커밋 → velog 초안 → 승인 → 발행. 원래 별도 레포였다
  { href: "/devlog", label: "개발 로그" },
  // 제휴 수익 갈래. 블로그 글과 수명·손질 방식이 달라 글 목록과 따로 둔다
  { href: "/threads", label: "쓰레드" },
  // 키워드 선정 → 작성 → 발행 다음 고리. 발행 뒤 성과를 보고 다시 키워드로 돌아간다
  { href: "/analytics", label: "성과" },
  { href: "/settings", label: "설정" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={pathname === item.href ? "active" : ""}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
