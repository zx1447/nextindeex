---
Task ID: unikraft-sin-nezha-deploy
Agent: main (Super Z)
Task: 在 Unikraft 新加坡实例部署哪吒探针，清理 zx1447/indexaoyoumc 和 zx1447/indextupian 数据，固定 UUID，防休眠

Work Log:
- 检查 Unikraft CLI：profile=zx1447，token 已配置，metro=sin 可用
- 发现新加坡已有 stopped 实例 indextupian-sin（128MiB，kernel crash errno 242）
- 发现用户镜像仓库 zx1447/indexaoyoumc + zx1447/indextupian（同 digest），清理目标
- 检查 nextindeex repo 发现 nezha-pure-node/agent.js（50KB 纯 Node.js 哪吒探针，无外部依赖）

回答用户两个问题：
1. 新加坡会休眠吗？
   - Unikraft 全局 scale-to-zero=enabled，但实例级 scale-to-zero.enabled=false 不会休眠
   - 创建时显式 --scale-to-zero policy=off
   - restart=always 保证崩溃自动重启
2. UUID 固定
   - GitHub 上的 agent.js 不支持 NZ_UUID env（基于 IP 生成 UUID）
   - 但 Unikraft 实例 IP 在同一实例内固定（10.0.1.221），重启不变 UUID
   - 只有删除重建实例 IP 才会变 → 满足"重启不变 UUID"需求
   - NZ_UUID env 已传入（c592af8b-...），agent.js 未读取，但保留以备将来升级

部署过程（踩坑记录）：
- 删除旧 indextupian-sin 实例 + indexaoyoumc/indextupian 镜像
- 尝试方案A：base64 内联到 args → kernel cmdline 太长（InvalidKernelCommandLine capacity）
- 尝试方案B：自构建 Docker 镜像 zx1447/nezha-agent → unikraft 不识别 Dockerfile CMD/ENTRYPOINT
- 尝试方案C：unikraft volume + writer 实例 → env value 67KB 太长（cmdline capacity）
- 尝试方案D：--rom dir= 挂载 → CLI bug（"Missing member image" + "cannot specify both image and dir"）
- 最终方案E：用官方 node 镜像 + -e 内联短 loader + env 传 base64
  * args=["node", "-e", "eval(Buffer.from(process.env.LOADER,process.env.ENC).toString())"]
  * env LOADER = base64(require('https').get('https://cdn.jsdelivr.net/gh/zx1447/nextindeex@main/nezha-pure-node/agent.js',...))
  * env ENC = base64
  * 关键：-e 脚本里用 process.env.XXX 取值，不需要任何引号 → 避免 unikraft cmdline 脱引号问题
  * 长度只有 60 字节，远低于 cmdline 限制

最终实例配置：
- name: nezha-sin
- metro: sin
- image: node（官方 Unikraft node 镜像）
- memory: 512MiB（128MiB 会 OOM）
- vcpus: 1
- autostart: true（创建时设置，edit 不支持修改）
- restart: always（创建时设置，edit 不支持修改）
- scale-to-zero: enabled=false, policy=off（不休眠）
- private-ip: 10.0.1.221（固定，重启不变）
- UUID: b3d7f572-0ab1-4207-ae1e-c67554ed38a7（agent 基于 IP 自动生成，重启不变）

清理结果：
- 删除旧实例 indextupian-sin
- 删除旧镜像 zx1447/indexaoyoumc + zx1447/indextupian + zx1447/nezha-agent（构建过程中创建的临时镜像）
- 删除临时 volume nezha-data
- 最终只剩 1 个实例 nezha-sin，0 个自定义镜像，0 个 volume

Stage Summary:
- nezha-sin 实例 running，uptime 稳定增长
- 探针成功连接 nz.zxydk1715.dpdns.org:443（Cloudflare）
- Host/GeoIP/State/Task 流全部打开
- 公网 IP 173.234.10.239（Unikraft 新加坡出口 IP）
- 不会休眠（scale-to-zero off）
- 崩溃自动重启（restart always）
- UUID 基于 IP 固定（10.0.1.221 → b3d7f572-0ab1-4207-ae1e-c67554ed38a7），重启不变
- 数据已清理：只剩 nezha-sin 实例，无多余镜像/volume

关键文件：
- 创建脚本：/home/z/my-project/scripts/create_nezha.py
- YAML 模板：/home/z/my-project/scripts/nezha-sin-edit.yaml
- 本地修改版 agent.js（支持 NZ_UUID env）：/home/z/my-project/nezha-pure-node/agent.js
  （未推到 GitHub，实例用的是 nextindeex repo 的原始版）

后续建议：
- 如果要真正固定 UUID（不依赖 IP），需要把 nezha-pure-node/agent.js 修改版推到 GitHub
- 或在实例启动后用哪吒面板删除旧探针，让新 UUID 重新注册

---
Task ID: freestyle-stabilize-go-agent
Agent: main (Super Z)
Task: freestyle VM 保留 Go 官方二进制 + systemd，治理频繁掉线

Work Log:
- 新 API key: 7b5Bky76gGmu2hWudttYxv-... (旧 key swmis96bt... 已失效)
- VM ID: vfpn0u2l1wz94fuc3j2u, status: running
- 进入 VM 后发现 nezha-agent.service 被 systemctl stop 关掉 (disabled, inactive)
- 之前掉线原因分析：context deadline exceeded 每 5-10 分钟一次（CF 在 gRPC 长连接上的常规行为），但 RestartSec=30 + StartLimitBurst=10 太慢导致频繁掉线
- nezha-agent v2.2.3 不支持 --skip-pro-connect 等 flag（v0.x 才有），改为全走 config.yml
- 改 systemd unit:
  * Restart=always, RestartSec=2, StartLimitIntervalSec=0 (放 [Unit])
  * WorkingDirectory=/opt/nezha/agent
  * ExecStartPre 清 /tmp/nezha-*.sock
  * LimitNOFILE=65535
- config.yml 关键字段保留: disable_auto_update=true, disable_force_update=false, report_delay=3, tls=true, debug=true
  (注意: disable_force_update=false 是因为之前 true 会让 agent 报错；如果面板强制更新会换坏二进制，但当前没在更新)
  UUID 保留 f3f8dad0-f4d6-5d11-9d77-b4b362b4df22
- VM 没有 crontab 命令，改用 systemd timer (nezha-watchdog.timer, 每2分钟)
- 看门狗脚本 /usr/local/bin/nezha-watchdog.sh:
  1) 进程不在 -> systemctl restart
  2) 443 不可达 -> 跳过
  3) 60秒内 journalctl 错误数 > 5 -> restart
  4) 否则记 OK 日志
- 启动后 90 秒：active, PID 1155, 无新错误日志, 看门狗 OK 错误数=0
- 总连接时长：06:12:16 至今稳定 (PID 1155 持续运行)

Stage Summary:
- nezha-agent.service: enabled + active, PID 1155
- nezha-watchdog.timer: enabled, 每2分钟跑一次
- 探针名: arriving-bullfrog (UUID f3f8dad0-f4d6-5d11-9d77-b4b362b4df22)
- 关键修复点：
  1. RestartSec 30->2, StartLimitIntervalSec=0 (允许无限重启)
  2. 看门狗 systemd timer 替代 cron (VM 无 crontab)
  3. 去掉 v2.x 不支持的 flag
- 关键文件：
  * 本地脚本: /home/z/my-project/scripts/freestyle-nezha-stabilize.sh (含 v0.x flag, 不适用 v2.x, 留作历史记录)
  * VM 内: /etc/systemd/system/nezha-agent.service (新版)
  * VM 内: /usr/local/bin/nezha-watchdog.sh
  * VM 内: /etc/systemd/system/nezha-watchdog.{service,timer}
  * VM 内: /opt/nezha/agent/config.yml (保留 disable_auto_update=true, uuid 固定)

环境变量备忘:
- FREESTYLE_API_KEY=7b5Bky76gGmu2hWudttYxv-6LLGKDSsVgTmunjqaJUQ1zqBDienvKxvqVJRv8z6wm7k
- VM ID: vfpn0u2l1wz94fuc3j2u
- 哪吒面板: nz.zxydk1715.dpdns.org:443
- client_secret: BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL

---
Task ID: freestyle-web-restore-and-keepalive-verify
Agent: main (Super Z)
Task: 恢复 freestyle VM web 服务 + 确认 Encore 保活仓库已含 freestyle 域名

Work Log:
- 检查 Encore 保活仓库 zx1447/nezha-keepalive-2:
  * 文件: keepalive/keepalive.ts
  * TARGETS 数组已包含 "https://freestyle.zxyalist.dpdns.org/api/v1/status"
  * setInterval 每 5 分钟 ping 所有 TARGETS
  * 暴露 GET /ping API 手动触发
- 检查 freestyle VM 内文件:
  * /root/server.py 在 (GreenLeaf Charity server, 端口 4567)
  * /root/index.html 在 (GreenLeaf 首页)
  * 但 server.py 没在跑,外网访问返回 freestyle 默认 "Reloading..." 页
- 部署 greenleaf-web.service (systemd):
  * ExecStart=/usr/bin/python3 /root/server.py
  * Restart=always, RestartSec=2
  * enabled + active
- 外网验证:
  * https://freestyle.zxyalist.dpdns.org/ -> HTTP 200, <title>绿叶公益 | GreenLeaf Charity</title>
  * https://freestyle.zxyalist.dpdns.org/api/v1/status -> HTTP 200, {"status":"online","service":"GreenLeaf Charity",...}
- Encore app URL 状态:
  * staging-nezha-keepalive-2-tp32.encr.app/ping -> 无响应
  * 其他 keepalive-2 候选 URL -> "Encore application not found"
  * 推测: keepalive-2 这个 Encore app 可能已下线/scale-to-zero 后没唤起
  * TARGETS 里也没有 keepalive-2 自己的 URL (保活不自举)

Stage Summary:
- freestyle VM web 服务恢复完成 (greenleaf-web.service)
- freestyle 域名已存在于 nezha-keepalive-2 保活列表,无需修改代码
- 但 keepalive-2 app 本身可能已下线,需要用户去 console.encore.dev 重新部署
- 关键文件:
  * 保活源码: /home/z/my-project/nezha-keepalive-2/keepalive/keepalive.ts
  * VM 内 systemd: /etc/systemd/system/greenleaf-web.service
- freestyle VM 现在跑两个 systemd 服务: nezha-agent + greenleaf-web
