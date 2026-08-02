import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  authRequired,
  createSession,
  verifyPassword,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!authRequired()) {
    return NextResponse.json({
      ok: true,
      message: "BACKOFFICE_PASSWORD 가 설정되지 않아 인증이 꺼져 있습니다.",
    });
  }

  const body = await req.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";

  if (!(await verifyPassword(password))) {
    // 어느 쪽이 틀렸는지 힌트를 주지 않는다
    return NextResponse.json(
      { ok: false, error: "비밀번호가 맞지 않습니다." },
      { status: 401 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
    // 로컬은 http 라 secure 쿠키가 아예 붙지 않는다. 배포에서만 켠다
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
