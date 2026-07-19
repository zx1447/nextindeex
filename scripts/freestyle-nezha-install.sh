#!/bin/bash
# Freestyle VM 上安装哪吒 agent（UUID 基于 IP 固定）
# 1. 下载官方 install.sh
# 2. 安装 nezha-agent
# 3. 安装后用基于 IP 生成的固定 UUID 覆盖 config.yml
# 4. 重启服务

set -e

# 1. 下载并运行官方 install.sh
curl -L https://raw.githubusercontent.com/nezhahq/scripts/main/agent/install.sh -o agent.sh
chmod +x agent.sh
env NZ_SERVER=nz.zxydk1715.dpdns.org:443 NZ_TLS=true NZ_CLIENT_SECRET=BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL NZ_DISABLE_AUTO_UPDATE=true ./agent.sh || true

# 2. 获取公网 IP
PUBLIC_IP=$(curl -s --max-time 10 https://api.ipify.org || curl -s --max-time 10 https://ifconfig.me/ip || curl -s --max-time 10 https://icanhazip.com)
echo "[setup] Public IP: $PUBLIC_IP"

# 3. 基于公网 IP 生成固定 UUID（SHA-256 → UUID v5 风格）
# 使用 python3（freestyle VM 应该有）
if command -v python3 >/dev/null 2>&1; then
    FIXED_UUID=$(python3 -c "
import uuid, hashlib
ns = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
print(str(uuid.uuid5(ns, 'freestyle-nezha-' + '$PUBLIC_IP')))
")
elif command -v python >/dev/null 2>&1; then
    FIXED_UUID=$(python -c "
import uuid
ns = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
print(str(uuid.uuid5(ns, 'freestyle-nezha-' + '$PUBLIC_IP')))
")
else
    # 没有 python，用 sha256sum + awk 手动构造
    HASH=$(echo -n "freestyle-nezha-$PUBLIC_IP" | sha256sum | awk '{print $1}')
    FIXED_UUID="${HASH:0:8}-${HASH:8:4}-${HASH:12:4}-${HASH:16:4}-${HASH:20:12}"
fi
echo "[setup] Fixed UUID (based on IP): $FIXED_UUID"

# 4. 找到 nezha-agent 的 config.yml 路径
CONFIG_DIR="/opt/nezha/agent"
CONFIG_FILE=$(ls -t $CONFIG_DIR/config*.yml 2>/dev/null | head -1)
if [ -z "$CONFIG_FILE" ]; then
    CONFIG_FILE="$CONFIG_DIR/config.yml"
fi
echo "[setup] Config file: $CONFIG_FILE"

# 5. 用固定 UUID 覆盖 config.yml
# 先备份
[ -f "$CONFIG_FILE" ] && cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"

# 写入完整 config.yml（用固定 UUID）
sudo tee "$CONFIG_FILE" > /dev/null << EOF
server: nz.zxydk1715.dpdns.org:443
client_secret: BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL
tls: true
disable_auto_update: true
disable_force_update: false
disable_command_execute: false
skip_connection_count: false
debug: false
disable_send_query: false
gpu: false
report_delay: 3
uuid: $FIXED_UUID
EOF
sudo chmod 600 "$CONFIG_FILE"

# 6. 重启 nezha-agent 服务（让新 UUID 生效）
if systemctl list-unit-files 2>/dev/null | grep -q nezha-agent; then
    sudo systemctl restart nezha-agent
    sudo systemctl enable nezha-agent
    sleep 3
    sudo systemctl status nezha-agent --no-pager | head -10
else
    # 没装成 systemd service，手动启动
    nohup sudo "$CONFIG_DIR/nezha-agent" -c "$CONFIG_FILE" > /var/log/nezha-agent.log 2>&1 &
    sleep 3
    ps aux | grep nezha-agent | grep -v grep
fi

echo ""
echo "[setup] ===== 完成 ====="
echo "[setup] Public IP: $PUBLIC_IP"
echo "[setup] Fixed UUID: $FIXED_UUID"
echo "[setup] Config: $CONFIG_FILE"
echo "[setup] 哪吒面板: https://nz.zxydk1715.dpdns.org"
