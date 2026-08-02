import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "블로그 백오피스",
  description: "네이버 트렌드 키워드 → 초안 생성 → 네이버·티스토리 붙여넣기",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <h1>
              블로그 <span>백오피스</span>
            </h1>
            <Nav />
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
