import { NextResponse } from "next/server";
import { fetchRelatedKeywords } from "@/lib/searchad";
import { blogDocCount, openApiCreds, searchTrend } from "@/lib/openapi";
import { fetchGa4Report } from "@/lib/ga4";
import { devlogCreds, velogWhoAmI } from "@/lib/devlog";
import { openaiPing } from "@/lib/openai";
import { gscPing } from "@/lib/gsc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 등록한 자격증명으로 실제 호출을 한 번씩 해본다.
 * 키를 저장한 직후 "되는지" 를 바로 확인할 수 있게 하려는 용도.
 */
export async function POST(req: Request) {
  const { target } = await req.json().catch(() => ({ target: "" }));

  if (target === "searchad") {
    const r = await fetchRelatedKeywords(["블로그"]);
    return NextResponse.json({
      ok: r.ok,
      message: r.ok
        ? `정상 — 연관 키워드 ${r.keywords.length}건을 받았습니다.`
        : (r.error ?? "실패"),
    });
  }

  if (target === "openai") {
    try {
      const model = await openaiPing();
      return NextResponse.json({ ok: true, message: `정상 — ${model} 사용 가능` });
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message });
    }
  }

  if (target === "ga4") {
    // 짧은 구간으로 실제 리포트를 한 번 받아본다. 권한·속성 ID 오류가 여기서 드러난다
    const r = await fetchGa4Report(7);
    if (!r.ok) return NextResponse.json({ ok: false, message: r.error ?? "실패" });
    return NextResponse.json({
      ok: true,
      message: r.totals.views
        ? `정상 — 최근 7일 조회수 ${r.totals.views.toLocaleString()}회`
        : "연결은 정상입니다. 다만 수집된 데이터가 아직 없습니다 (태그 설치 직후면 몇 시간 걸립니다).",
    });
  }

  if (target === "gsc") {
    try {
      const r = await gscPing();
      return NextResponse.json({ ok: true, message: `정상 — ${r.siteUrl} (${r.permissionLevel})` });
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message });
    }
  }

  if (target === "github") {
    const { token, user } = await devlogCreds();
    if (!token) return NextResponse.json({ ok: false, message: "GitHub 토큰이 등록되지 않았습니다." });
    const r = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "backoffice" },
    });
    if (!r.ok) return NextResponse.json({ ok: false, message: `GitHub ${r.status} — 토큰이 만료됐거나 repo 스코프가 없습니다.` });
    const me = (await r.json()) as { login?: string };
    return NextResponse.json({
      ok: true,
      message: `정상 — ${me.login} 로 인증됨${me.login && me.login !== user ? ` (수집 대상 사용자는 ${user})` : ""}`,
    });
  }

  if (target === "velog") {
    const { velogToken, velogRefresh, velogUser } = await devlogCreds();
    if (!velogToken && !velogRefresh) {
      return NextResponse.json({ ok: false, message: "velog 토큰이 등록되지 않았습니다." });
    }
    try {
      const name = await velogWhoAmI({ access: velogToken, refresh: velogRefresh });
      const mismatch = name && name !== velogUser ? ` — 설정의 velog 사용자(${velogUser})와 다릅니다` : "";
      return NextResponse.json({
        ok: Boolean(name),
        message: name
          ? `정상 — @${name} 로 로그인됨${mismatch}${velogRefresh ? "" : " · refresh_token 이 없어 24시간 뒤 끊깁니다"}`
          : "쿠키가 만료됐습니다. velog 에서 access_token 과 refresh_token 을 다시 꺼내 넣으세요.",
      });
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message });
    }
  }

  if (target === "search" || target === "datalab") {
    const creds = await openApiCreds();
    if (!creds) {
      return NextResponse.json({
        ok: false,
        message: "Client ID/Secret 이 등록되지 않았습니다.",
      });
    }
    try {
      if (target === "search") {
        const total = await blogDocCount("블로그", creds);
        return NextResponse.json({
          ok: true,
          message: `정상 — '블로그' 문서수 ${total?.toLocaleString() ?? "?"}건`,
        });
      }
      const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const start = new Date(end.getTime() - 28 * 24 * 60 * 60 * 1000);
      const series = await searchTrend(
        {
          keywords: ["블로그"],
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          timeUnit: "week",
        },
        creds,
      );
      return NextResponse.json({
        ok: series.length > 0,
        message: series.length
          ? `정상 — 데이터 포인트 ${series[0].data.length}개`
          : "응답은 왔지만 결과가 비어 있습니다.",
      });
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message });
    }
  }

  return NextResponse.json(
    { ok: false, message: "알 수 없는 테스트 대상입니다." },
    { status: 400 },
  );
}
