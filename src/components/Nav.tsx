"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "키워드 탐색" },
  { href: "/write", label: "글 작성" },
  { href: "/posts", label: "글 목록" },
  // 같은 트렌드를 글이 아니라 영상으로 푸는 갈래. ffmpeg 가 필요해 로컬에서만 돈다
  { href: "/shorts", label: "쇼츠" },
  { href: "/kids", label: "유아 채널" },
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
