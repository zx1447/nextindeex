export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        maxWidth: '800px',
        margin: '0 auto',
        padding: '40px 20px',
        color: '#333',
      }}
    >
      <h1 style={{ color: '#10b981', marginBottom: '8px' }}>
        🟢 Nezha Agent (Next.js)
      </h1>
      <p style={{ color: '#666', marginBottom: '32px' }}>
        纯 Node.js 哪吒探针 — 运行在 Next.js 服务器上
      </p>

      <div
        style={{
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '24px',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: '18px' }}>📋 探针信息</h2>
        <ul style={{ lineHeight: '1.8' }}>
          <li><strong>面板:</strong> nz.zxydk1715.dpdns.org:443 (TLS)</li>
          <li><strong>协议:</strong> HTTP/2 gRPC</li>
          <li><strong>上报:</strong> State (3s) / Host (10min) / GeoIP (30min)</li>
          <li><strong>依赖:</strong> 无外部依赖（纯 Node.js 内置模块）</li>
        </ul>
      </div>

      <div
        style={{
          background: '#fef3c7',
          border: '1px solid #fde68a',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '24px',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: '18px' }}>🔗 API 端点</h2>
        <ul style={{ lineHeight: '1.8' }}>
          <li><code>/api/status</code> — 探针状态</li>
          <li><code>/api/health</code> — 健康检查</li>
        </ul>
      </div>

      <div
        style={{
          background: '#dbeafe',
          border: '1px solid #93c5fd',
          borderRadius: '8px',
          padding: '20px',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: '18px' }}>ℹ️ 说明</h2>
        <p style={{ marginBottom: 0, lineHeight: '1.6' }}>
          探针在 Next.js 服务器启动时自动启动。UUID 基于公网 IP 生成，请在哪吒面板启用对应服务器。
        </p>
      </div>
    </main>
  );
}
