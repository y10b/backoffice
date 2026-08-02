"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "키워드 탐색" },
  { href: "/write", label: "글 작성" },
  { href: "/posts", label: "글 목록" },
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
