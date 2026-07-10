/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // 不用 instrumentation hook（build 时会出错）
  // 改用 API route 的 lazy init
};

module.exports = nextConfig;
