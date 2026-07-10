/**
 * 探针状态端点 - 返回哪吒探针的运行状态
 * 第一次访问时 lazy-init 探针
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let agentStarted = false;

export async function GET(request) {
  try {
    // 第一次访问时启动探针
    if (!agentStarted) {
      agentStarted = true;
      const { main } = await import('./nezha-agent.cjs');
      main().catch((err) => {
        console.error('[Nezha] 探针启动失败:', err.message);
      });
      console.log('[Nezha] 探针已在后台启动（lazy init）');
      // 给探针 2 秒初始化
      await new Promise(r => setTimeout(r, 2000));
    }

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
