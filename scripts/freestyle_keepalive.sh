#!/bin/bash
# Freestyle VM 保活脚本
# 每 5 分钟访问一次域名，保持 VM 网络活动，防止 idle timeout suspend

DOMAIN="freestyle.zxyalist.dpdns.org"
LOG="/home/z/my-project/scripts/keepalive.log"

while true; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    # 用 --resolve 绕过本地 DNS 缓存问题
    HTTP_CODE=$(curl -s -4 -k --resolve "$DOMAIN:443:35.235.84.134" \
        --max-time 15 -o /dev/null -w "%{http_code}" "https://$DOMAIN/api/v1/status" 2>/dev/null)
    echo "[$TIMESTAMP] ping $DOMAIN -> HTTP $HTTP_CODE" >> $LOG
    sleep 300  # 5 分钟
done
