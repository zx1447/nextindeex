#!/usr/bin/env python3
"""Create placeholder instances in fra/dal/was/sfo to reserve quota.
   Runs a minimal sleep loop, no nezha agent."""
import json, subprocess, sys

# 极简睡眠脚本：每 60s 打印一次心跳，永不退出
# 不含括号/引号，避免 unikraft cmdline 解析问题
loader_js = 'setInterval(function(){console.log("alive "+Date.now())},60000)'
# 通过 env 传，-e 脚本用 process.env.LOAD
loader_b64 = __import__('base64').b64encode(loader_js.encode()).decode()

eval_script = "eval(Buffer.from(process.env.LOAD,process.env.ENC).toString())"
args_json = json.dumps(["node", "-e", eval_script])

# 各地区创建
regions = [
    ("fra", "nezha-fra"),
    ("dal", "nezha-dal"),
    ("was", "nezha-was"),
    ("sfo", "nezha-sfo"),
]

for metro, name in regions:
    print(f"\n=== Creating {name} in {metro} ===")
    cmd = [
        "unikraft", "instances", "create",
        "--name", name,
        "--metro", metro,
        "--image", "node",
        "--memory", "512MiB",
        "--vcpus", "1",
        "--autostart",
        "--restart", "always",
        "--scale-to-zero", "policy=off",
        f"--set=runtime.args={args_json}",
        "-e", f"LOAD={loader_b64}",
        "-e", "ENC=base64",
        "-e", "TZ=Asia/Shanghai",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    print(f"RC: {r.returncode}")
    # 提取关键字段
    out = r.stdout
    for line in out.split('\n'):
        if any(k in line for k in ['name:', 'state:', 'memory:', 'private-ip:', 'uuid:', 'error', 'reason:']):
            print(' ', line.strip())
    if r.stderr:
        print(f"STDERR: {r.stderr[-200:]}")
