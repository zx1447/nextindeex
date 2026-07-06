#!/usr/bin/env python3
"""连接 Pterodactyl websocket console，发命令，捕获输出。"""
import json
import time
import sys
import urllib.request
import websocket  # pylint: disable=import-error

BASE = "https://ptly1.hosting-phenix.com"
TOKEN = "ptlc_9wHJ4VAvzPJEJJkjVnHFOTecGZloFMJfL10msRpDf4b"
SERVER = "3eaae0dd"

# 拿 websocket 凭证
req = urllib.request.Request(
    f"{BASE}/api/client/servers/{SERVER}/websocket",
    headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
)
ws_data = json.loads(urllib.request.urlopen(req, timeout=15).read())["data"]
ws_url = ws_data["socket"]
ws_token = ws_data["token"]

print(f"连接 websocket: {ws_url}", file=sys.stderr)
ws = websocket.create_connection(
    ws_url,
    timeout=15,
    origin="https://ptly1.hosting-phenix.com",
    header={"User-Agent": "Mozilla/5.0"},
)

# 先发 token 认证
ws.send(json.dumps({"event": "auth", "args": [ws_token]}))

# 等待认证响应 + 初始状态
start = time.time()
authenticated = False
while time.time() - start < 10:
    try:
        msg = ws.recv()
        data = json.loads(msg)
        event = data.get("event")
        if event == "auth success":
            authenticated = True
            print("✓ 认证成功", file=sys.stderr)
        elif event == "status":
            print(f"  服务器状态: {data.get('args', [])}", file=sys.stderr)
        elif event == "console output":
            line = data.get("args", [""])[0]
            print(f"  [console] {line.rstrip()}", file=sys.stderr)
        if authenticated:
            break
    except websocket.WebSocketTimeoutException:
        break

if not authenticated:
    print("⚠ 未收到 auth success，继续尝试...", file=sys.stderr)

# 等服务器启动完成 - 先查 status 直到 running
print("等服务器启动完成...", file=sys.stderr)
for i in range(30):
    time.sleep(2)
    try:
        ws.settimeout(0.5)
        msg = ws.recv()
        data = json.loads(msg)
        if data.get("event") == "status":
            args = data.get("args", [])
            print(f"  状态: {args}", file=sys.stderr)
            # args 格式通常是 ["running"] 之类
            if args and "running" in str(args[0]).lower():
                print("✓ 服务器已运行", file=sys.stderr)
                break
    except websocket.WebSocketTimeoutException:
        continue

# 多等几秒让 shell 就绪
time.sleep(3)

# 发送 du 命令 - 一条一条发，每条等 4 秒收输出
collected = []
def send_and_collect(cmd, wait=4):
    print(f"\n>>> {cmd}", file=sys.stderr)
    ws.send(json.dumps({"event": "send command", "args": [cmd]}))
    start = time.time()
    while time.time() - start < wait:
        try:
            ws.settimeout(1)
            msg = ws.recv()
            data = json.loads(msg)
            if data.get("event") == "console output":
                line = data.get("args", [""])[0]
                collected.append(line.rstrip())
                print(f"  << {line.rstrip()}", file=sys.stderr)
        except websocket.WebSocketTimeoutException:
            continue
        except Exception:
            break

send_and_collect("echo ___DU_ROOT_START___")
send_and_collect("du -sh /home/container/* 2>/dev/null | sort -rh | head -20", wait=8)
send_and_collect("echo ___DU_NM_START___")
send_and_collect("du -sh /home/container/node_modules/* 2>/dev/null | sort -rh | head -25", wait=10)
send_and_collect("echo ___DU_JDK_START___")
send_and_collect("du -sh /home/container/node_modules/.aoyouyingyong/.build-center/env/jdk17 /home/container/node_modules/.aoyouyingyong/.build-center/env/jdk21 2>/dev/null", wait=8)

ws.close()

# 打印所有输出
print("\n=== 命令输出 ===")
for line in collected:
    print(line)
