"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { titleFor } from "./Nav";

/**
 * 모바일 상단 내비게이션 바(iOS UINavigationBar). 태블릿·PC 에서는 CSS 로 숨는다.
 *
 * 페이지마다 큰 제목(.page-title)이 본문 맨 위에 있으므로, 바 가운데 작은 제목은
 * 그 큰 제목이 스크롤로 가려진 뒤에만 나타난다 — iOS 의 큰 제목 동작과 같다.
 */
export default function TopBar() {
  const pathname = usePathname() ?? "/";
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 36);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [pathname]);

  if (pathname === "/login") return null;

  const isHome = pathname === "/";
  return (
    <header className={`topbar${scrolled ? " scrolled" : ""}`}>
      <div className="topbar-inner">
        {!isHome && (
          <Link href="/" className="topbar-back" aria-label="백오피스 홈으로">
            <svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true">
              <path
                d="M10 2L2 10l8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>백오피스</span>
          </Link>
        )}
        <div className="topbar-title">{titleFor(pathname)}</div>
      </div>
    </header>
  );
}
