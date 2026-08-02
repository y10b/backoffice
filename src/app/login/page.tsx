"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const d = await res.json();
      if (!d.ok) {
        setError(d.error ?? "로그인에 실패했습니다.");
        return;
      }
      /*
       * 돌아갈 경로는 서버가 검증한 값이 아니므로 여기서도 같은 출처인지 본다.
       * router.push 가 외부 주소로 튀는 걸 막는다.
       */
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 380, margin: "12vh auto 0" }}>
      <h2>로그인</h2>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        이 백오피스에는 API 키와 수익 데이터가 들어 있어 비밀번호로 잠겨 있습니다.
      </p>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="pw">비밀번호</label>
          <input
            id="pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="primary"
          style={{ marginTop: 14, width: "100%" }}
          disabled={loading || !password}
        >
          {loading && <span className="spinner" />}
          {loading ? "확인 중" : "들어가기"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams 는 Suspense 경계가 필요하다
  return (
    <Suspense fallback={<div className="empty">불러오는 중입니다.</div>}>
      <LoginInner />
    </Suspense>
  );
}
