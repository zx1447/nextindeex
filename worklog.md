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
