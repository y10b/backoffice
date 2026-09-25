"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Nav, { Chevron, ITEMS, NavIcon } from "@/components/Nav";

/** 각 칸은 셀 수 없으면 null. posts 는 티스토리에 안 올린 글 수, visit 은 진행 중인 방문 후기 수 */
type Counts = {
  velog: number | null;
  threads: number | null;
  visit: number | null;
  posts: number | null;
  /** 서치콘솔 기회 검색어(노출은 되는데 5~30위). 백엔드가 아직 안 세면 없거나 null */
  opportunities?: number | null;
};

type TodoKey = keyof Counts | "pool";

function countOf(c: Counts, key: TodoKey): number | null {
  if (key === "pool") return null;
  const n = c[key];
  return typeof n === "number" ? n : null;
}

type HomeState =
  | { phase: "loading" }
  | { phase: "ok"; counts: Counts }
  | { phase: "error"; configured: boolean; error: string };

/** 할 일 한 줄 = 어느 화면으로 가는지 + 무엇을 세었는지 */
const TODOS: { key: TodoKey; href: string; label: string }[] = [
  { key: "velog", href: "/devlog", label: "검토·발행 대기 velog 글" },
  { key: "threads", href: "/threads", label: "손질할 쓰레드 후보" },
  { key: "visit", href: "/visit", label: "네이버 방문 후기 (진행 중)" },
  { key: "posts", href: "/posts", label: "티스토리 초안 (안 올림)" },
  { key: "opportunities", href: "/analytics", label: "기회 검색어" },
  // 세는 게 아니라 들어가 보는 곳이라 배지를 달지 않는다
  { key: "pool", href: "/keywords", label: "모은 키워드" },
];

export default function HomePage() {
  const [state, setState] = useState<HomeState>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    fetch("/api/home")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.ok) setState({ phase: "ok", counts: d.counts });
        else
          setState({
            phase: "error",
            configured: d.configured !== false,
            error: d.error ?? "불러오지 못했습니다.",
          });
      })
      .catch(
        (e) =>
          alive &&
          setState({ phase: "error", configured: true, error: String(e) }),
      );
    return () => {
      alive = false;
    };
  }, []);

  const total =
    state.phase === "ok"
      ? TODOS.reduce((a, t) => a + (countOf(state.counts, t.key) ?? 0), 0)
      : 0;

  return (
    <>
      <h1 className="page-title">백오피스</h1>
      <p className="page-desc">
        {state.phase === "ok" && total === 0
          ? "오늘 손볼 것이 없습니다."
          : "오늘 손볼 것부터 보여줍니다."}
      </p>

      <section className="ios-section">
        <h2 className="ios-section-title">오늘 할 일</h2>
        <ul className="ios-list">
          {TODOS.map((t) => {
            const path = t.href.split("?")[0];
            const item = ITEMS.find((i) => i.href === path);
            const n = state.phase === "ok" ? countOf(state.counts, t.key) : 0;
            return (
              <li key={t.key}>
                <Link href={t.href} className="ios-row">
                  {item && <NavIcon item={item} />}
                  <span className="ios-label">{t.label}</span>
                  {state.phase === "loading" && t.key !== "pool" && <span className="spinner" />}
                  {n !== null && n > 0 && <span className="ios-count">{n}</span>}
                  <Chevron />
                </Link>
              </li>
            );
          })}
        </ul>
        {state.phase === "error" && (
          <p className="ios-section-footer">
            {state.configured ? (
              <>개수를 불러오지 못했습니다 — {state.error}</>
            ) : (
              <>
                DB 가 연결되지 않아 개수를 셀 수 없습니다. SUPABASE_URL 과
                SUPABASE_SERVICE_ROLE_KEY 를 환경변수에 넣으세요.
              </>
            )}
          </p>
        )}
      </section>

      {/* 모바일에서는 여기가 iOS 설정의 첫 화면이다. 태블릿·PC 는 왼쪽 사이드바가 같은 일을 한다 */}
      <div className="home-nav">
        <Nav highlight={false} />
      </div>
    </>
  );
}
