#!/bin/bash
# Freestyle VM nezha-agent 稳定化脚本
# 保留 Go 官方二进制 + systemd，仅做掉线治理
# 在 freestyle VM 内以 root 执行
set -e

PANEL="nz.zxydk1715.dpdns.org:443"
SECRET="BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL"
AGENT_DIR="/opt/nezha/agent"
CONFIG="$AGENT_DIR/config.yml"
SERVICE="/etc/systemd/system/nezha-agent.service"
WATCHDOG="/usr/local/bin/nezha-watchdog.sh"

echo "[1/5] 检查 agent 二进制是否存在"
if [ ! -x "$AGENT_DIR/nezha-agent" ]; then
    echo "[ERR] $AGENT_DIR/nezha-agent 不存在，先跑官方 install.sh"
    exit 1
fi
echo "  OK: $($AGENT_DIR/nezha-agent -v 2>&1 | head -1)"

echo "[2/5] 重写 config.yml（去掉会触发自动更新的项）"
# 备份
[ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.bak.$(date +%s)"

# UUID 用之前那份（固定）
FIXED_UUID="f3f8dad0-0c4b-4e8c-8d2a-1a5e3f7b9c64"
cat > "$CONFIG" << EOF
server: $PANEL
client_secret: $SECRET
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
chmod 600 "$CONFIG"
echo "  OK: UUID=$FIXED_UUID"

echo "[3/5] 重写 systemd unit（重启策略 + 启动参数）"
cat > "$SERVICE" << 'EOF'
[Unit]
Description=Nezha Agent (Go official binary, stabilized)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/nezha/agent/nezha-agent -c /opt/nezha/agent/config.yml --skip-pro-connect --disable-force-update --disable-auto-update --report-delay 3
Restart=always
RestartSec=2
StartLimitIntervalSec=0
# 掉线时清掉旧 socket 避免卡 TIME_WAIT
ExecStartPre=/bin/sh -c 'rm -f /tmp/nezha-*.sock 2>/dev/null; true'
# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nezha-agent
# 资源
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
echo "  OK: $SERVICE"

echo "[4/5] 部署看门狗"
cat > "$WATCHDOG" << 'EOF'
#!/bin/bash
# nezha 看门狗：每 2 分钟跑一次
# 1) 进程没了 -> 重启服务
# 2) 进程在但连不上面板 443 -> 重启服务
LOG=/var/log/nezha-watchdog.log
TS=$(date '+%Y-%m-%d %H:%M:%S')

if ! pgrep -x nezha-agent >/dev/null 2>&1; then
    echo "[$TS] nezha-agent 进程不在，重启" >> $LOG
    systemctl restart nezha-agent
    exit 0
fi

# 检查能否 TLS handshake 到面板（CF 边缘）
if ! timeout 8 bash -c 'cat < /dev/null > /dev/tcp/nz.zxydk1715.dpdns.org/443' 2>/dev/null; then
    echo "[$TS] 面板 443 不可达，跳过判定" >> $LOG
    exit 0
fi

# 检查 journalctl 最近 60 秒是否有错误
RECENT_ERR=$(journalctl -u nezha-agent --since "60 seconds ago" --no-pager 2>/dev/null | grep -iE 'error|fail|refused|reset|eof' | wc -l)
if [ "$RECENT_ERR" -gt 5 ]; then
    echo "[$TS] 60秒内 $RECENT_ERR 条错误，重启" >> $LOG
    systemctl restart nezha-agent
    exit 0
fi

echo "[$TS] OK 进程在、面板可达、无密集错误" >> $LOG
EOF
chmod +x "$WATCHDOG"

# 加 cron（每 2 分钟）
CRON_LINE="*/2 * * * * $WATCHDOG"
if ! crontab -l 2>/dev/null | grep -qF "$WATCHDOG"; then
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    echo "  OK: 已加 cron"
else
    echo "  OK: cron 已存在"
fi

echo "[5/5] 重启服务并验证"
systemctl daemon-reload
systemctl enable nezha-agent
systemctl restart nezha-agent
sleep 4
systemctl status nezha-agent --no-pager | head -15

echo ""
echo "===== 完成 ====="
echo "PID: $(pgrep -x nezha-agent)"
echo "UUID: $FIXED_UUID"
echo "Watchdog: $WATCHDOG (cron */2)"
echo "Log: journalctl -u nezha-agent -f"
