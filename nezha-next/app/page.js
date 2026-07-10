// 首页通过 next.config.js 的 rewrites 直接返回 greenleaf.html
// 这个文件作为 fallback，正常情况下不会渲染
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '40px', textAlign: 'center' }}>
      <h1>🟢 Nezha Agent</h1>
      <p>探针运行中</p>
      <p><a href="/api/status">/api/status</a></p>
    </main>
  );
}
