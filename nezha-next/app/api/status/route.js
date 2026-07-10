/**
 * 探针状态端点
 * 探针在 /api/health 首次访问时已自动启动
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
