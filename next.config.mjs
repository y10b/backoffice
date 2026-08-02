/** @type {import('next').NextConfig} */
const nextConfig = {
  // node:sqlite 은 런타임 내장 모듈이라 번들에 포함시키지 않는다
  serverExternalPackages: [],
  experimental: {
    // 로컬 백오피스라 외부 접근 없음
  },
};

export default nextConfig;
