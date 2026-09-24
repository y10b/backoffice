"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/*
 * 메뉴 한 곳. 사이드바(태블릿·PC), 홈 화면 목록(모바일), 상단 바 제목(TopBar)이
 * 전부 이 배열을 본다. 화면을 추가하면 여기만 고치면 세 군데가 같이 따라온다.
 */

export type NavItem = {
  href: string;
  label: string;
  /** 아이콘 칸 배경색. iOS 설정처럼 행마다 색을 달리해 눈으로 빨리 찾게 한다 */
  color: string;
  icon: ReactNode;
};

export type NavGroup = {
  /** 없으면 제목 없이 묶음만 나눈다 (iOS 설정의 마지막 묶음처럼) */
  title?: string;
  items: NavItem[];
};

const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="17"
    height="17"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "블로그",
    items: [
      {
        href: "/keywords",
        label: "키워드 탐색",
        color: "#007aff",
        icon: svg(
          <>
            <circle cx="10.5" cy="10.5" r="6" />
            <path d="M15 15l5 5" />
          </>,
        ),
      },
      {
        href: "/write",
        label: "글 작성",
        color: "#ff9500",
        icon: svg(<path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4" />),
      },
      {
        href: "/posts",
        label: "글 목록",
        color: "#5856d6",
        icon: svg(
          <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
        ),
      },
      // 키워드가 아니라 사진에서 출발하는 갈래. 방향이 반대라 글 작성과 섞지 않는다
      {
        href: "/visit",
        label: "방문 후기",
        color: "#ff3b30",
        icon: svg(
          <>
            <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
            <circle cx="12" cy="10" r="2.3" />
          </>,
        ),
      },
    ],
  },
  {
    title: "채널",
    items: [
      // 깃 커밋 → velog 초안 → 승인 → 발행
      {
        href: "/devlog",
        label: "개발 로그",
        color: "#30b0c7",
        icon: svg(<path d="M5 7l5 5-5 5M13 17h6" />),
      },
      // 제휴 수익 갈래. 블로그 글과 수명·손질 방식이 달라 글 목록과 따로 둔다
      {
        href: "/threads",
        label: "쓰레드",
        color: "#ff2d55",
        icon: svg(
          <>
            <circle cx="12" cy="12" r="3.6" />
            <path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 6.9" />
          </>,
        ),
      },
    ],
  },
  {
    items: [
      // 발행 뒤 성과를 보고 다시 키워드로 돌아간다
      {
        href: "/analytics",
        label: "성과",
        color: "#34c759",
        icon: svg(<path d="M6 20v-8M12 20V5M18 20v-5" />),
      },
      {
        href: "/settings",
        label: "설정",
        color: "#8e8e93",
        icon: svg(
          <>
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
            <circle cx="15" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
          </>,
        ),
      },
    ],
  },
];

export const ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** 하위 경로(/posts/12 같은)도 부모 메뉴로 친다 */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 상단 바 제목. 홈은 앱 이름, 모르는 경로는 빈 문자열 */
export function titleFor(pathname: string): string {
  if (pathname === "/") return "백오피스";
  return ITEMS.find((i) => isActive(pathname, i.href))?.label ?? "";
}

export function Chevron() {
  return (
    <svg
      className="ios-chev"
      viewBox="0 0 8 14"
      width="8"
      height="14"
      aria-hidden="true"
    >
      <path
        d="M1 1l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NavIcon({ item }: { item: Pick<NavItem, "color" | "icon"> }) {
  return (
    <span className="ios-icon" style={{ background: item.color }}>
      {item.icon}
    </span>
  );
}

/**
 * iOS 설정식 그룹 목록.
 * - 사이드바에서는 지금 화면을 파랗게 칠한다(iPad 설정과 같이).
 * - 홈(모바일)에서는 강조 없이 목록만 보여준다. 거기서는 "지금 화면"이 홈이다.
 */
export default function Nav({ highlight = true }: { highlight?: boolean }) {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="nav">
      {NAV_GROUPS.map((group, gi) => (
        <section key={gi} className="ios-section">
          {group.title && <h2 className="ios-section-title">{group.title}</h2>}
          <ul className="ios-list">
            {group.items.map((item) => {
              const active = highlight && isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`ios-row${active ? " active" : ""}`}
                    aria-current={active ? "page" : undefined}
                  >
                    <NavIcon item={item} />
                    <span className="ios-label">{item.label}</span>
                    <Chevron />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
