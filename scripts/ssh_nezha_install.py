#!/usr/bin/env python3.13
"""用户级安装哪吒 agent（无 sudo）
1. 下载 nezha-agent 二进制到 ~/.nezha/agent/
2. 生成 config.yml（基于 IP 的固定 UUID）
3. nohup 后台启动
4. 加 cron（如果有）保活
"""
import paramiko
import sys
import time
import base64

HOST = "public.nolanproject.my.id"
PORT = 22
USER = "public"
PASS = "123456"

# 完整安装脚本（无 sudo）
INSTALL_SCRIPT = r"""set -e
export NZ_HOME="$HOME/.nezha"
export AGENT_DIR="$NZ_HOME/agent"
mkdir -p "$AGENT_DIR"

echo "[1/5] 获取公网 IP..."
PUBLIC_IP=$(curl -s --max-time 10 https://api.ipify.org || curl -s --max-time 10 https://ifconfig.me/ip || echo "")
echo "  Public IP: $PUBLIC_IP"

echo "[2/5] 生成基于 IP 的固定 UUID..."
# 用 sha256sum + 手动构造 UUID v5 风格
HASH=$(echo -n "nezha-agent-uuid:$PUBLIC_IP" | sha256sum | awk '{print $1}')
FIXED_UUID="${HASH:0:8}-${HASH:8:4}-${HASH:12:4}-${HASH:16:4}-${HASH:20:12}"
# 设置 UUID v4 的 version 和 variant 位
P3="${HASH:12:4}"
P3_NEW=$(printf "4%s" "${P3:1}")
P4="${HASH:16:4}"
P4_FIRST=$(printf '%x' $(( 0x${P4:0:1} & 0x3 | 0x8 )))
P4_NEW="${P4_FIRST}${P4:1}"
FIXED_UUID="${HASH:0:8}-${HASH:8:4}-${P3_NEW}-${P4_NEW}-${HASH:20:12}"
echo "  Fixed UUID: $FIXED_UUID"

echo "[3/5] 检查 nezha-agent 二进制..."
if [ ! -x "$AGENT_DIR/nezha-agent" ]; then
    echo "  下载 nezha-agent linux amd64..."
    cd /tmp
    curl -fsSL --max-time 120 -o nezha-agent.zip "https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip"
    unzip -qo nezha-agent.zip -d "$AGENT_DIR"
    chmod +x "$AGENT_DIR/nezha-agent"
    rm -f nezha-agent.zip
    echo "  ✓ 下载完成"
else
    echo "  ✓ 已存在"
fi
ls -la "$AGENT_DIR/nezha-agent"

echo "[4/5] 写入 config.yml..."
CONFIG_FILE="$AGENT_DIR/config.yml"
cat > "$CONFIG_FILE" << EOF
server: nz.zxydk1715.dpdns.org:443
client_secret: BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL
tls: true
disable_auto_update: true
disable_force_update: true
disable_command_execute: false
skip_connection_count: false
debug: false
disable_send_query: false
gpu: false
report_delay: 3
uuid: $FIXED_UUID
EOF
chmod 600 "$CONFIG_FILE"
echo "  ✓ config.yml 已生成:"
cat "$CONFIG_FILE"

echo "[5/5] 启动 nezha-agent..."
# kill 旧进程
pkill -f "$AGENT_DIR/nezha-agent" 2>/dev/null || true
sleep 1

# 后台启动
nohup "$AGENT_DIR/nezha-agent" -c "$CONFIG_FILE" > "$NZ_HOME/nezha.log" 2>&1 &
AGENT_PID=$!
echo "  PID: $AGENT_PID"
sleep 3

# 验证进程
if kill -0 $AGENT_PID 2>/dev/null; then
    echo "  ✓ 进程运行中"
    ps -p $AGENT_PID -o pid,cmd
else
    echo "  ✗ 进程退出，看日志："
    cat "$NZ_HOME/nezha.log"
    exit 1
fi

echo ""
echo "===== 完成 ====="
echo "Public IP: $PUBLIC_IP"
echo "Fixed UUID: $FIXED_UUID"
echo "Config: $CONFIG_FILE"
echo "Log: $NZ_HOME/nezha.log"
echo ""
echo "日志输出："
sleep 5
tail -30 "$NZ_HOME/nezha.log" 2>/dev/null || echo "(no log yet)"

# 加保活 cron
if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v "nezha-keepalive.sh"; echo "*/1 * * * * $NZ_HOME/keepalive.sh >> $NZ_HOME/keepalive.cron.log 2>&1") | crontab -
    echo "✓ cron 保活已添加"
fi

# 写保活脚本
cat > "$NZ_HOME/keepalive.sh" << 'KEEPEOF'
#!/bin/bash
AGENT="$HOME/.nezha/agent/nezha-agent"
CONF="$HOME/.nezha/agent/config.yml"
LOG="$HOME/.nezha/nezha.log"
if ! pgrep -f "$AGENT" > /dev/null; then
    nohup "$AGENT" -c "$CONF" >> "$LOG" 2>&1 &
    echo "[$(date)] restarted nezha-agent" >> "$LOG"
fi
KEEPEOF
chmod +x "$NZ_HOME/keepalive.sh"
echo "✓ 保活脚本已创建"
"""

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"连接 {USER}@{HOST}:{PORT}...")
    ssh.connect(HOST, port=PORT, username=USER, password=PASS, timeout=15)
    print("✓ 连接成功\n")
    
    # 用 base64 传脚本，避免 quoting 问题
    script_b64 = base64.b64encode(INSTALL_SCRIPT.encode()).decode()
    cmd = f"echo '{script_b64}' | base64 -d | bash"
    
    print("=== 执行安装 ===")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=300, get_pty=True)
    
    while not stdout.channel.exit_status_ready():
        if stdout.channel.recv_ready():
            sys.stdout.write(stdout.channel.recv(4096).decode('utf-8', errors='replace'))
            sys.stdout.flush()
        time.sleep(0.1)
    
    remaining = stdout.read().decode('utf-8', errors='replace')
    if remaining:
        sys.stdout.write(remaining)
    
    err = stderr.read().decode('utf-8', errors='replace')
    if err:
        print("\nSTDERR:", err)
    
    rc = stdout.channel.recv_exit_status()
    print(f"\n[exit code: {rc}]")
    
    ssh.close()

if __name__ == "__main__":
    main()
