"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Nav from "./Nav";

/**
 * 태블릿·PC 의 왼쪽 목록(iPad 설정의 사이드바). 모바일에서는 CSS 로 숨고,
 * 그 자리를 홈 화면 목록 + 상단 바의 뒤로가기가 대신한다.
 *
 * 로그인 화면에서는 메뉴를 보여줄 이유가 없다(눌러도 다시 로그인으로 튕긴다).
 */
export default function Sidebar() {
  const pathname = usePathname() ?? "/";
  if (pathname === "/login") return null;
  return (
    <aside className="sidebar">
      <Link href="/" className="sidebar-title">
        백오피스
      </Link>
      <Nav />
    </aside>
  );
}
