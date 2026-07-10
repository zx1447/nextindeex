/**
 * 健康检查端点 - 供 Nept 平台检测应用是否存活
 * 返回 200 + 简单 JSON，Nept 检测到 200 就不会杀进程
 */
export const dynamic = 'force-dynamic';

export async function GET(request) {
  return Response.json({
    ok: true,
    timestamp: Date.now(),
  }, { status: 200 });
}
