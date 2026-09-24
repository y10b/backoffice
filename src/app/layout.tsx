import type { Metadata, Viewport } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";

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
  appleWebApp: { capable: true, title: "백오피스", statusBarStyle: "default" },
};

/*
 * viewport-fit=cover 로 노치·홈 인디케이터 영역까지 그리고, 안쪽 여백은
 * env(safe-area-inset-*) 로 CSS 가 직접 비운다.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <div className="shell">
          <Sidebar />
          <main className="main">
            <TopBar />
            <div className="main-inner">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
