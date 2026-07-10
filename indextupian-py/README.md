# GreenLeaf AI Image Generator (Python 版)

从 `indextupian/index.src.js` 重写的 Python 版本，去掉了所有调试端点。

## 功能

- Flask Web 服务器（端口 4567）
- 自动下载并运行哪吒 agent
- AES-256-CBC 解密配置图片
- 自 ping 保活机制
- 多 IP 查询服务容错

## 路由

| 路径 | 说明 |
|------|------|
| `GET /` | 首页 |
| `GET /about` `/programs` `/donate` `/news` | 静态页面（返回首页） |
| `GET /robots.txt` | 爬虫协议 |
| `GET /start-nz` | 手动触发启动 nezha agent |
| `GET /api/v1/status` | 服务状态 |
| `GET /api/v1/render` | 模拟渲染任务 |
| `GET /api/v1/models` | 模型列表 |

## 本地运行

```bash
pip install -r requirements.txt
python app.py
```

访问 http://localhost:4567

## Docker 部署

```bash
docker build -t indextupian-py .
docker run -d -p 4567:4567 --name indextupian-py indextupian-py
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SERVER_PORT` | 4567 | Web 服务端口 |
| `ALIVE_DOMAIN` | （空） | 自 ping 的域名 |
| `ALIVE_PROTOCOL` | https | 自 ping 协议 |
| `ALIVE_PATH` | / | 自 ping 路径 |
| `ALIVE_INTERVAL` | 5 | 自 ping 间隔（分钟） |
| `PUBLIC_IP` | （自动） | 手动指定公网 IP |
| `BASE_DIR` | /app/.npm_logs | 日志目录 |
| `CACHE_DIR` | /app/agent_cache | agent 缓存目录 |
| `TMP_DIR` | /app/.tmp_dl | 临时下载目录 |

## 跟 JS 版的差异

| 项 | JS 版 | Python 版 |
|----|-------|----------|
| 运行时 | Node.js 18+ | Python 3.12+ |
| Web 框架 | Express (内置 http) | Flask + Gunicorn |
| HTTP 客户端 | 内置 https | urllib + requests |
| 加密 | 内置 crypto | cryptography |
| 进程管理 | child_process.spawn | subprocess.Popen |
| 定时器 | setTimeout + setInterval | threading.Thread |
| 调试端点 | 有（exec/config/agent-log/nezha-test） | **已移除** |
| 混淆 | javascript-obfuscator | 无（明文源码） |
