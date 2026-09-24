"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Nav, { Chevron, ITEMS, NavIcon } from "@/components/Nav";

type Counts = { velog: number; threads: number; visit: number; posts: number };

type HomeState =
  | { phase: "loading" }
  | { phase: "ok"; counts: Counts }
  | { phase: "error"; configured: boolean; error: string };

/** 할 일 한 줄 = 어느 화면으로 가는지 + 무엇을 세었는지 */
const TODOS: { key: keyof Counts; href: string; label: string }[] = [
  { key: "velog", href: "/devlog", label: "검토·발행 대기 velog 글" },
  { key: "threads", href: "/threads", label: "손질할 쓰레드 후보" },
  { key: "visit", href: "/visit", label: "진행 중인 방문 후기" },
  { key: "posts", href: "/posts", label: "아직 안 올린 블로그 초안" },
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
      ? Object.values(state.counts).reduce((a, b) => a + b, 0)
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
            const item = ITEMS.find((i) => i.href === t.href);
            const n = state.phase === "ok" ? state.counts[t.key] : 0;
            return (
              <li key={t.key}>
                <Link href={t.href} className="ios-row">
                  {item && <NavIcon item={item} />}
                  <span className="ios-label">{t.label}</span>
                  {state.phase === "loading" && <span className="spinner" />}
                  {n > 0 && <span className="ios-count">{n}</span>}
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
