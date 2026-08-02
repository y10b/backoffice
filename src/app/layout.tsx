import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "블로그 백오피스",
  description: "네이버 트렌드 키워드 → 초안 생성 → 네이버·티스토리 붙여넣기",
  /*
   * 이건 발행물이 아니라 작업 도구다. 지금은 localhost 라 크롤러가 닿지 않지만,
   * 터널이나 배포로 잠깐이라도 밖에 노출되면 초안·키워드·수익 화면이 그대로 색인된다.
   * 그때는 이미 늦으므로 미리 막아 둔다. robots.txt(src/app/robots.ts)와 한 쌍이다.
   */
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
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
