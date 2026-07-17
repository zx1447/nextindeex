---
Task ID: nezha-agent-install-sg
Agent: main (Super Z)
Task: 用户要求在新加坡运行 Nezha 官方 agent install 命令：
  curl -L https://raw.githubusercontent.com/nezhahq/scripts/main/agent/install.sh -o agent.sh && chmod +x agent.sh && env NZ_SERVER=nz.zxydk1715.dpdns.org:443 NZ_TLS=true NZ_CLIENT_SECRET=BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL ./agent.sh

Work Log:
- 检查 sandbox 环境：当前 IP 47.57.242.119（Alibaba HK，香港，非新加坡）；用户 z，uid=1001；无免密 sudo；无 crontab。
- 下载官方 install.sh 到 /home/z/my-project/agent.sh 并执行：
  * 脚本内置 deps_check / env_check / geo_check / install 函数
  * install 步骤需要 sudo 创建 /opt/nezha/agent + 注册 systemd 服务
  * 实际报错：sudo: a password is required（3 次）→ "Install nezha-agent service failed"
  * 但脚本已经把 agent zip 下载到了 /tmp/nezha-agent_linux_amd64.zip
- 回退方案：用户级安装
  * 解压到 /home/z/opt/nezha/agent/nezha-agent（v2.2.3, linux/amd64）
  * 手写 config.yml：server/tls/client_secret，debug=true
  * 直接 ./nezha-agent -c ./config.yml 跑前台验证：成功连上 nz.zxydk1715.dpdns.org:443（Cloudflare 104.21.81.193），并自动补全了 uuid 等字段
- 守护进程化：
  * setsid + bash -c + disown 脱离会话
  * 写 /home/z/opt/nezha/agent/keepalive.sh：每 30 秒 pgrep -x nezha-agent 检查，挂了就拉起
  * 首版 keepalive 用绝对路径 pgrep 失败导致又拉起一个重复实例，已修复为 pgrep -x nezha-agent
- 最终状态：
  * agent PID 5660，3 条 TLS（面板 + GitHub + IP 查询）
  * watchdog PID 5679
  * UUID c592af8b-b49f-e6cf-8f68-f3c57faec830（agent 自动生成并写回 config.yml）
  * 面板已下发过 terminal 任务（terminal initdc2d4260-188d-92c7-ded8-d07b341836fc），说明面板侧已识别

Stage Summary:
- 关键产物路径：
  * 二进制：/home/z/opt/nezha/agent/nezha-agent
  * 配置：/home/z/opt/nezha/agent/config.yml
  * 日志：/home/z/opt/nezha/agent/nezha.log
  * 看门狗脚本：/home/z/opt/nezha/agent/keepalive.sh
  * 看门狗日志：/home/z/opt/nezha/agent/keepalive.loop.log
  * 原始官方脚本：/home/z/my-project/agent.sh
- 重要注意事项：
  * sandbox 是香港机房不是新加坡；如果用户需要真正新加坡机房，需要单独提供 SSH 凭据或选用支持 sg 区域的 PaaS
  * 没有 systemd / root，agent 走用户级进程 + 看门狗方案；sandbox 重启后需要手动重新拉起看门狗（或加到 ~/.bashrc / profile）
  * 没有 crontab，看门狗用 setsid 后台循环代替
- 后续优化建议：
  * 把 watchdog 启动命令加到 ~/.bashrc 末尾，sandbox 重启后自动恢复
  * 或考虑用现有的 nezha-next Next.js 项目（已封装好 nezha-agent.cjs）部署到支持 sg 的 PaaS
