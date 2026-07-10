/**
 * 探针状态端点
 * 探针在 nezha-agent.cjs 加载时自动启动（main() 自动执行）
 * 这个端点只返回状态
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const mod = await import('./nezha-agent.cjs');
    const status = mod.getNezhaStatus();
    return Response.json({
      ...status,
      timestamp: new Date().toISOString(),
    }, { status: 200 });
  } catch (err) {
    return Response.json({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
