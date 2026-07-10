/**
 * 健康检查端点
 * Nept 平台会定期访问这个端点检测应用是否存活
 * 首次访问时触发探针启动
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let agentStarted = false;

export async function GET(request) {
  // 首次访问时启动探针
  if (!agentStarted) {
    agentStarted = true;
    try {
      const { main } = await import('../status/nezha-agent.cjs');
      main().catch((err) => {
        console.error('[Nezha] 探针启动失败:', err.message);
      });
      console.log('[Nezha] 探针已触发启动');
    } catch (err) {
      console.error('[Nezha] 加载探针失败:', err.message);
    }
  }

  return Response.json({
    ok: true,
    agentStarted,
    timestamp: Date.now(),
  }, { status: 200 });
}
