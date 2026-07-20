#!/bin/bash
# Freestyle VM 保活脚本
# 每隔几分钟 ping 一次 freestyle 域名，保持 VM 网络活动
# 注意：freestyle.zxyalist.dpdns.org 指向 freestyle 网关 35.235.84.134
# 网关会路由到对应 VM

DOMAIN="freestyle.zxyalist.dpdns.org"
LOG="/home/z/my-project/scripts/freestyle-keepalive.log"

# 防止重复启动
LOCK="/tmp/freestyle-keepalive.lock"
exec 200>"$LOCK"
flock -n 200 || exit 0

while true; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    # ping 域名（不依赖 IP，让 DNS 自动解析）
    HTTP_CODE=$(curl -s -k --max-time 15 -o /dev/null -w "%{http_code}" "https://$DOMAIN/" 2>/dev/null)
    echo "[$TIMESTAMP] ping $DOMAIN -> HTTP $HTTP_CODE" >> "$LOG"
    # 5 分钟一次
    sleep 300
done
