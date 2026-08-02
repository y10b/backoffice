"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "키워드 탐색" },
  { href: "/write", label: "글 작성" },
  { href: "/posts", label: "글 목록" },
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
