import type { MetadataRoute } from "next";

/**
 * 백오피스는 전체를 크롤링 대상에서 뺀다.
 *
 * 메타 태그(layout.tsx 의 robots)만으로는 부족하다. 크롤러가 페이지를 받아야 메타를 읽는데,
 * robots.txt 는 받기 전에 막는다. 둘 다 두는 이유다.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
