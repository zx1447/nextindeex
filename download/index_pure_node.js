/**
 * 纯 Node.js 哪吒探针 (Nezha Agent)
 * - 无子进程、无文件下载、无外部依赖
 * - 启动前先获取公网 IP，生成固定 UUID
 * - 使用 Node.js 内置 http2 模块连接哪吒面板 gRPC
 * - 支持自动端口探测、自动重连
 */

const http2 = require('http2');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

// ==================== 配置 ====================
const NZ_SERVER = 'nz.zxydk1715.dpdns.org:443';
const NZ_TLS    = true;
const NZ_SECRET = 'BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL';
const AGENT_VERSION = '2.2.2';
const REPORT_DELAY = 3; // 秒，State 上报间隔
const GEOIP_PERIOD = 1800; // 秒，GeoIP 上报间隔 (30分钟)
const HOST_PERIOD = 600; // 秒，Host 重新上报间隔 (10分钟)
const PING_PERIOD = 10; // 秒，HTTP/2 PING 间隔

// ==================== 全局状态 ====================
let running = true;
let h2session = null;
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
let prevCpuTotal = 0;
let prevCpuBusy = 0;
let lastNetIn = 0;
let lastNetOut = 0;
let lastNetTime = 0;

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

// ==================== Protobuf 编码器 ====================
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

    // CPU
    let cpuInfo = [];
    try {
        const cpus = os.cpus();
        const cpuModelSet = new Set(cpus.map(c => c.model));
        cpuInfo = [...cpuModelSet];
    } catch(e) {}

    // Memory
    let memTotalValue = os.totalmem();

    // Disk
    let { diskTotal } = getDiskCapacity();

    // Swap
    let swapTotal = 0;
    try {
        if (!isWin) {
            const meminfo = readFileSafe('/proc/meminfo');
            const swapMatch = meminfo.match(/SwapTotal:\s+(\d+)/);
            if (swapMatch) swapTotal = parseInt(swapMatch[1]) * 1024;
        }
    } catch(e) {}

    // Virtualization
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

    // Boot time
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

    // Arch
    let archValue = '';
    const nodeArch = os.arch();
    if (nodeArch === 'x64') archValue = 'x86_64';
    else if (nodeArch === 'arm64') archValue = 'aarch64';
    else if (nodeArch === 'arm') archValue = 'armv7l';
    else if (nodeArch === 'ia32') archValue = 'i386';
    else archValue = nodeArch;

    // GPU (纯文件读取，无子进程)
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

    // Platform
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

    // CPU
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
            // Windows: 使用 os.cpus() 差值
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

    // Memory
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

    // Disk
    let { diskTotal: _dt, diskUsed } = getDiskCapacity();

    // Network
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

    // TCP/UDP connections
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

    // Process count
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
    let ended = false; // 防止 onEnd 被重复调用
    const safeOnEnd = (info) => {
        if (ended) return;
        ended = true;
        // 关闭流的写端，防止继续写入
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
        // UNIQUE constraint 错误忽略（面板重复注册）
        if (grpcMsg.includes('UNIQUE constraint')) return;
        // grpc-status:0 = 服务端正常关闭流，需要重开
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
        // 流完全关闭时触发（可能没有收到 trailers 就被关闭了）
        if (!ended) {
            console.log(`[Nezha] 流 ${path} 意外关闭`);
            safeOnEnd({ closed: true });
        }
    });
    return stream;
}

// ==================== 任务处理 (无子进程) ====================
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
    } catch(e) {}
}

// ==================== 命令执行（终端）====================
const { exec } = require('child_process');

function handleCommandTask(taskId, cmd) {
    console.log('[Nezha] 执行命令: ' + cmd.substring(0, 100));
    if (!cmd || cmd.length === 0) {
        sendTaskResult(taskId, 4, 0, 'Command empty', false);
        return;
    }
    
    const startTime = Date.now();
    exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const delay = Date.now() - startTime;
        if (err) {
            // 命令执行失败，返回错误信息
            const output = (stderr || '') + (err.message || '');
            sendTaskResult(taskId, 4, delay, output || 'Command failed', false);
        } else {
            // 命令执行成功，返回 stdout
            sendTaskResult(taskId, 4, delay, stdout || 'OK', true);
        }
    });
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

    // 纯 Node.js ICMP Ping: 使用 net.Socket 连接测试
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
    isReconnecting = true; // 防止级联重连
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
    if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
    if (geoipTimer) { clearInterval(geoipTimer); geoipTimer = null; }
    if (hostTimer) { clearInterval(hostTimer); hostTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    // 移除流的事件监听器，防止 close 触发 onEnd → 再次 scheduleReconnect
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
    // 延迟重置 isReconnecting 标记
    setTimeout(() => { isReconnecting = false; }, 2000);
}

function scheduleReconnect(reason) {
    if (!running || isReconnecting) return;
    // 打印调用堆栈以定位触发源
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

/**
 * 流级别重开：只在 h2session 仍然存活时重开特定流，不做全量重连
 * 如果 h2session 已死，则走 scheduleReconnect 全量重连
 *
 * 关键修复：
 * - 旧流收到 trailers 后 destroyed/closed 可能为 false，所以必须先强制关闭旧流并置 null
 * - onEnd 回调中必须把 stateStream/taskStream 置 null，否则重开时判断旧流"还活着"而不重开
 */
function reopenStreams(reason) {
    if (!running || isReconnecting) return;
    if (!h2session || h2session.destroyed || h2session.closed) {
        console.error(`[Nezha] ${reason}，但 h2session 已死，走全量重连`);
        scheduleReconnect('h2session dead: ' + reason);
        return;
    }
    if (reopenTimer) return; // 防抖
    console.log(`[Nezha] ${reason}，重开流...`);

    reopenTimer = setTimeout(() => {
        reopenTimer = null;
        if (!running || !h2session || h2session.destroyed) {
            scheduleReconnect('reopenTimer: h2session dead');
            return;
        }
        const authHeaders = {
            'client-secret': NZ_SECRET,
            'client-uuid': currentUUID,
            'client_secret': NZ_SECRET,
            'client_uuid': currentUUID,
        };

        // 强制关闭旧流并置 null（不管 destroyed/closed 状态如何）
        if (stateStream) {
            try { stateStream.removeAllListeners(); stateStream.end(); } catch(e) {}
            stateStream = null;
        }
        if (taskStream) {
            try { taskStream.removeAllListeners(); taskStream.end(); } catch(e) {}
            taskStream = null;
        }

        // 重开 State 流
        try {
            stateStream = openStream(h2session, '/proto.NezhaService/ReportSystemState', authHeaders,
                () => {}, // Receipt 忽略
                () => {
                    // onEnd 时先置 null，再触发重开
                    if (stateStream) {
                        try { stateStream.removeAllListeners(); } catch(e) {}
                        stateStream = null;
                    }
                    reopenStreams('State 流结束');
                }
            );
            console.log('[Nezha] State 流已重开');
        } catch(e) { console.log(`[Nezha] State 流重开失败: ${e.message}`); }

        // 重开 Task 流
        try {
            taskStream = openStream(h2session, '/proto.NezhaService/RequestTask', authHeaders,
                (data) => { handleTaskData(data); },
                () => {
                    // onEnd 时先置 null，再触发重开
                    if (taskStream) {
                        try { taskStream.removeAllListeners(); } catch(e) {}
                        taskStream = null;
                    }
                    reopenStreams('Task 流结束');
                }
            );
            console.log('[Nezha] Task 流已重开');
        } catch(e) { console.log(`[Nezha] Task 流重开失败: ${e.message}`); }

        // 确保定时器还在运行
        startTimersIfNeeded();
    }, 500);
}

function startTimersIfNeeded() {
    // State 定时上报
    if (!stateTimer) {
        stateTimer = setInterval(() => {
            try {
                if (!running || !h2session || h2session.destroyed) return;
                // 流不存在时触发重开而不是静默跳过
                if (!stateStream || stateStream.destroyed || stateStream.closed) {
                    reopenStreams('State 流不可写');
                    return;
                }
                const state = collectState();
                stateStream.write(PB.frame(NezhaMsg.encodeState(state)));
            } catch(e) {
                console.log(`[Nezha] State 上报失败: ${e.message}`);
                // 写入失败时先置空流再触发重开
                if (stateStream) {
                    try { stateStream.removeAllListeners(); } catch(e2) {}
                    stateStream = null;
                }
                reopenStreams('State 上报写入失败');
            }
        }, REPORT_DELAY * 1000);
    }
    // GeoIP
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
    // Host 重报
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
    // PING
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
        // 解析地址
        const addrParts = NZ_SERVER.split(':');
        const host = addrParts[0];
        const originalPort = parseInt(addrParts[1]) || (NZ_TLS ? 443 : 5555);

        // 探测端口
        const detected = await detectGrpcPort(host, originalPort, NZ_TLS);
        const port = detected.port;
        const useTls = detected.tls;

        const connectURL = useTls ? `https://${host}:${port}` : `http://${host}:${port}`;
        const h2Opts = useTls ? { rejectUnauthorized: false, settings: { enablePush: false } } : { settings: { enablePush: false } };

        // 建立 HTTP/2 连接
        h2session = http2.connect(connectURL, h2Opts);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('连接超时')), 10000);
            // 连接成功后立即移除 Promise 的 error handler，防止后续错误触发 reject
            const connectErrorHandler = (err) => { clearTimeout(timeout); reject(err); };
            h2session.on('connect', () => {
                clearTimeout(timeout);
                h2session.removeListener('error', connectErrorHandler);
                resolve();
            });
            h2session.on('error', connectErrorHandler);
        });

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

        const authHeaders = {
            'client-secret': NZ_SECRET,
            'client-uuid': currentUUID,
            'client_secret': NZ_SECRET,
            'client_uuid': currentUUID,
        };

        // 1. 上报 Host 信息 (ReportSystemInfo2)
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

        // 3. 打开 State 流 (ReportSystemState)
        stateStream = openStream(h2session, '/proto.NezhaService/ReportSystemState', authHeaders,
            () => {}, // Receipt 响应忽略
            () => {
                // onEnd 时先置 null，再触发重开
                if (stateStream) {
                    try { stateStream.removeAllListeners(); } catch(e) {}
                    stateStream = null;
                }
                reopenStreams('State 流结束');
            }
        );
        console.log('[Nezha] State 流已打开');

        // 4. 打开 Task 流 (RequestTask)
        // 注意：不发送空帧，等服务器主动推送 Task
        taskStream = openStream(h2session, '/proto.NezhaService/RequestTask', authHeaders,
            (data) => { handleTaskData(data); },
            () => {
                // onEnd 时先置 null，再触发重开
                if (taskStream) {
                    try { taskStream.removeAllListeners(); } catch(e) {}
                    taskStream = null;
                }
                reopenStreams('Task 流结束');
            }
        );
        console.log('[Nezha] Task 流已打开');

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
    console.log('║     纯 Node.js 哪吒探针 v' + AGENT_VERSION + '      ║');
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

    // 启动连接
    await connectInternal();
}

// ==================== 状态查询 ====================
function getNezhaStatus() {
    return {
        status: sessionAlive ? 'online' : 'connecting',
        uuid: currentUUID,
        ip: currentIP,
        server: NZ_SERVER,
        version: AGENT_VERSION,
        uptime: process.uptime()
    };
}

module.exports = { main, getNezhaStatus };

// ==================== InkWell Web 应用 ====================

// ==================== InkWell Web 应用依赖 ====================
var express = require("express");
var session = require("express-session");
/**
 * InkWell - Personal Journaling Platform
 * Version: 2.4.1
 *
 * A lightweight, private diary and journaling web application
 * with session-based authentication, mood tracking, tagging,
 * and full CRUD operations for daily journal entries.
 *
 * Usage:
 *   node index.js
 *
 * Environment Variables:
 *   SERVER_PORT    - Pterodactyl assigned port (highest priority)
 *   PORT           - Web panel listening port (auto-assigned if not set)
 *   PANEL_PASSWORD - Access password for the web panel
 *
 * License: MIT
 */

// ============================================================================
// Configuration
// ============================================================================

var PORT = parseInt(process.env.SERVER_PORT) || parseInt(process.env.PORT) || parseInt(process.env.PANEL_PORT) || 0;
var PANEL_PASSWORD = process.env.PANEL_PASSWORD || "admin";
var SESSION_SECRET = crypto.randomBytes(32).toString("hex");
var SESSION_TIMEOUT = 24 * 60 * 60 * 1000;
var MAX_LOGIN_ATTEMPTS = 5;
var LOCKOUT_DURATION = 15 * 60 * 1000;
var DATA_FILE = path.join(__dirname, "journal.json");
var APP_VERSION = "2.4.1";

// ============================================================================
// Data Store
// ============================================================================

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        }
    } catch (e) {}
    return { entries: [], nextId: 1 };
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {}
}

// ============================================================================
// Express App Setup
// ============================================================================

var app = express();
var loginAttempts = new Map();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: SESSION_TIMEOUT, httpOnly: true },
    name: "ink.sid"
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        req.session.touch();
        return next();
    }
    if (req.path === "/" || req.path === "/api/auth/login") return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ success: false, message: "Auth required" });
    res.redirect("/");
}

app.use(function(req, res, next) {
    if (req.path === "/" || req.path === "/api/auth/login" || req.path === "/favicon.ico") return next();
    requireAuth(req, res, next);
});

function escHtml(s) {
    if (!s) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============================================================================
// Auth Routes
// ============================================================================

app.post("/api/auth/login", function(req, res) {
    var password = req.body.password;
    var clientIp = req.ip || req.connection.remoteAddress;
    var attempts = loginAttempts.get(clientIp) || { count: 0, timestamp: Date.now() };

    if (Date.now() - attempts.timestamp > LOCKOUT_DURATION) {
        loginAttempts.delete(clientIp);
    } else if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
        var remaining = Math.ceil((LOCKOUT_DURATION - (Date.now() - attempts.timestamp)) / 60000);
        return res.status(429).json({ success: false, message: "Too many attempts. Try again in " + remaining + " min." });
    }

    if (password === PANEL_PASSWORD) {
        req.session.authenticated = true;
        loginAttempts.delete(clientIp);
        res.json({ success: true });
    } else {
        attempts.count++;
        attempts.timestamp = Date.now();
        loginAttempts.set(clientIp, attempts);
        res.status(401).json({ success: false, message: "Invalid password. Attempts left: " + (MAX_LOGIN_ATTEMPTS - attempts.count) });
    }
});

app.post("/api/auth/logout", function(req, res) {
    req.session.destroy(function() { res.json({ success: true }); });
});

// ============================================================================
// Entry CRUD
// ============================================================================

app.get("/api/entries", function(req, res) {
    var data = loadData();
    var entries = data.entries.slice().sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    res.json({ success: true, entries: entries });
});

app.post("/api/entries", function(req, res) {
    var data = loadData();
    var title = (req.body.title || "").trim();
    var content = (req.body.content || "").trim();
    var mood = req.body.mood || "neutral";
    var tags = req.body.tags || [];
    if (!title || !content) return res.status(400).json({ success: false, message: "Title and content required" });
    var entry = {
        id: data.nextId++,
        title: title,
        content: content,
        mood: mood,
        tags: Array.isArray(tags) ? tags : String(tags).split(",").map(function(t) { return t.trim(); }).filter(Boolean),
        wordCount: content.split(/\s+/).filter(Boolean).length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    data.entries.push(entry);
    saveData(data);
    res.json({ success: true, entry: entry });
});

app.put("/api/entries/:id", function(req, res) {
    var data = loadData();
    var id = parseInt(req.params.id);
    var entry = data.entries.find(function(e) { return e.id === id; });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    if (req.body.title !== undefined) entry.title = String(req.body.title).trim();
    if (req.body.content !== undefined) {
        entry.content = String(req.body.content).trim();
        entry.wordCount = entry.content.split(/\s+/).filter(Boolean).length;
    }
    if (req.body.mood !== undefined) entry.mood = req.body.mood;
    if (req.body.tags !== undefined) entry.tags = Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags).split(",").map(function(t) { return t.trim(); }).filter(Boolean);
    entry.updatedAt = new Date().toISOString();
    saveData(data);
    res.json({ success: true, entry: entry });
});

app.delete("/api/entries/:id", function(req, res) {
    var data = loadData();
    var id = parseInt(req.params.id);
    var idx = data.entries.findIndex(function(e) { return e.id === id; });
    if (idx === -1) return res.status(404).json({ success: false, message: "Entry not found" });
    data.entries.splice(idx, 1);
    saveData(data);
    res.json({ success: true });
});

app.get("/api/stats", function(req, res) {
    var data = loadData();
    var entries = data.entries;
    var totalWords = entries.reduce(function(s, e) { return s + (e.wordCount || 0); }, 0);
    var moodCounts = {};
    entries.forEach(function(e) { moodCounts[e.mood] = (moodCounts[e.mood] || 0) + 1; });
    var tagCounts = {};
    entries.forEach(function(e) { (e.tags || []).forEach(function(t) { tagCounts[t] = (tagCounts[t] || 0) + 1; }); });
    var dates = entries.map(function(e) { return e.createdAt.substring(0, 10); }).sort();
    var streak = 0;
    if (dates.length > 0) {
        var today = new Date().toISOString().substring(0, 10);
        var d = new Date(today);
        while (dates.indexOf(d.toISOString().substring(0, 10)) !== -1) {
            streak++;
            d.setDate(d.getDate() - 1);
        }
    }
    res.json({ success: true, totalEntries: entries.length, totalWords: totalWords, streak: streak, moodCounts: moodCounts, tagCounts: tagCounts });
});

// ============================================================================
// Pages
// ============================================================================

app.get("/", function(req, res) {
    if (req.session.authenticated) return res.redirect("/dashboard");
    res.send(getLoginPage());
});

app.get("/dashboard", requireAuth, function(req, res) {
    res.send(getDashboardPage());
});

// ============================================================================
// Login Page - Disguised as 503 Error
// ============================================================================

function getLoginPage() {
    var lines = [];
    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
    lines.push('<title>503 Service Temporarily Unavailable</title>');
    lines.push('<style>');
    lines.push('*{margin:0;padding:0;box-sizing:border-box}');
    lines.push('body{background:#fff;color:#333;font-family:system-ui,-apple-system,sans-serif;font-size:14px}');
    lines.push('.err-wrap{max-width:620px;margin:60px auto 0;padding:0 24px}');
    lines.push('.err-icon{text-align:center;margin-bottom:20px}');
    lines.push('.err-icon svg{width:56px;height:56px}');
    lines.push('h1{font-size:22px;font-weight:400;color:#333;margin-bottom:6px}');
    lines.push('.err-sub{color:#666;margin-bottom:24px;line-height:1.6}');
    lines.push('.err-sub span{cursor:default}');
    lines.push('.err-hr{border:none;border-top:1px solid #e0e0e0;margin:20px 0}');
    lines.push('.err-detail{font-size:13px;color:#888;line-height:1.7}');
    lines.push('#login-box{display:none;position:fixed;inset:0;z-index:999;background:linear-gradient(135deg,#020617,#0f172a);color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;align-items:center;justify-content:center;opacity:0;transition:opacity .4s}');
    lines.push('#login-box.show{display:flex;opacity:1}');
    lines.push('.login-card{background:rgba(15,23,42,.85);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:2.5rem;width:100%;max-width:400px;box-shadow:0 24px 80px rgba(0,0,0,.4)}');
    lines.push('.login-logo{width:56px;height:56px;background:linear-gradient(135deg,#10b981,#06b6d4);border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 1.2rem;font-size:24px}');
    lines.push('.login-title{font-size:1.5rem;font-weight:800;text-align:center;background:linear-gradient(135deg,#34d399,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.3rem}');
    lines.push('.login-sub{color:#94a3b8;font-size:.8rem;text-align:center;margin-bottom:1.8rem}');
    lines.push('.input-g{margin-bottom:1rem}');
    lines.push('.input-g label{display:block;color:#cbd5e1;font-size:.78rem;font-weight:500;margin-bottom:.3rem}');
    lines.push('.input-g input{width:100%;padding:.8rem 1rem;background:rgba(30,41,59,.6);border:1px solid rgba(71,85,105,.5);border-radius:14px;color:#fff;font-size:.95rem;transition:border .2s}');
    lines.push('.input-g input:focus{outline:none;border-color:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.15)}');
    lines.push('.sub-btn{width:100%;padding:.9rem;background:linear-gradient(135deg,#10b981,#06b6d4);border:none;border-radius:14px;color:#fff;font-size:.95rem;font-weight:700;cursor:pointer;transition:transform .15s}');
    lines.push('.sub-btn:hover{transform:translateY(-2px)}');
    lines.push('.sub-btn:active{transform:scale(.97)}');
    lines.push('.err-msg{color:#f87171;font-size:.82rem;text-align:center;min-height:1.1rem;margin-top:.5rem}');
    lines.push('</style></head><body>');
    lines.push('<div class="err-wrap">');
    lines.push('<div class="err-icon"><svg viewBox="0 0 56 56" fill="none"><circle cx="28" cy="28" r="26" stroke="#d93025" stroke-width="2.5"/><path d="M18 18L38 38M38 18L18 38" stroke="#d93025" stroke-width="2.5" stroke-linecap="round"/></svg></div>');
    lines.push('<h1>503 Service Temporarily Unavailable</h1>');
    lines.push('<p class="err-sub">The server is currently unable to handle this request. Please try again later<span onclick="revealLogin()">.</span></p>');
    lines.push('<hr class="err-hr">');
    lines.push('<div class="err-detail">');
    lines.push('<p>nginx/1.24.0</p>');
    lines.push('<p>Reference ID: ' + crypto.randomBytes(8).toString("hex") + '</p>');
    lines.push('</div></div>');
    lines.push('<div id="login-box">');
    lines.push('<div class="login-card">');
    lines.push('<div class="login-logo">\u270E</div>');
    lines.push('<h2 class="login-title">InkWell</h2>');
    lines.push('<p class="login-sub">Personal Journaling Platform</p>');
    lines.push('<form id="loginForm" onsubmit="return handleLogin(event)">');
    lines.push('<div class="input-g"><label>Password</label><input type="password" id="pw" placeholder="Enter password" required autocomplete="off"></div>');
    lines.push('<button type="submit" class="sub-btn">Unlock</button>');
    lines.push('<div id="errMsg" class="err-msg"></div>');
    lines.push('</form></div></div>');
    lines.push('<script>');
    lines.push('function revealLogin(){var b=document.getElementById("login-box");b.classList.add("show");setTimeout(function(){document.getElementById("pw").focus()},300)}');
    lines.push('function handleLogin(e){e.preventDefault();var p=document.getElementById("pw").value.trim();if(!p){document.getElementById("errMsg").textContent="Password required";return false}');
    lines.push('fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})}).then(function(r){return r.json()}).then(function(d){if(d.success){window.location.href="/dashboard"}else{document.getElementById("errMsg").textContent=d.message||"Failed";document.getElementById("pw").value=""}}).catch(function(){document.getElementById("errMsg").textContent="Network error"});return false}');
    lines.push('</script></body></html>');
    return lines.join('\n');
}

// ============================================================================
// Dashboard Page
// ============================================================================

function getDashboardPage() {
    var lines = [];
    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
    lines.push('<title>InkWell</title>');
    lines.push('<script src="https://cdn.tailwindcss.com"><\/script>');
    lines.push('<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">');
    lines.push('<style>');
    lines.push('body{background:#020617;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;min-height:100vh}');
    lines.push('.glass{background:rgba(15,23,42,.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.05)}');
    lines.push('input,textarea,select{background:#0f172a!important;border:1px solid #1e293b!important;color:#fff!important;outline:none!important}');
    lines.push('input:focus,textarea:focus{border-color:#10b981!important;box-shadow:0 0 0 2px rgba(16,185,129,.15)!important}');
    lines.push('.btn{transition:all .15s;cursor:pointer;user-select:none}');
    lines.push('.btn:hover{transform:translateY(-1px);filter:brightness(1.1)}');
    lines.push('.btn:active{transform:scale(.97)}');
    lines.push('::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:rgba(0,0,0,.2)}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}');
    lines.push('.entry-item{transition:all .15s;cursor:pointer}.entry-item:hover{background:rgba(16,185,129,.08)}');
    lines.push('.entry-item.active{background:rgba(16,185,129,.12);border-left:3px solid #10b981}');
    lines.push('.mood-happy{color:#fbbf24}.mood-neutral{color:#94a3b8}.mood-sad{color:#60a5fa}.mood-excited{color:#f472b6}.mood-grateful{color:#a78bfa}');
    lines.push('.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}');
    lines.push('.tag{display:inline-block;font-size:10px;padding:2px 8px;border-radius:9999px;background:rgba(16,185,129,.1);color:#34d399;border:1px solid rgba(16,185,129,.2);margin:2px}');
    lines.push('</style></head><body class="flex flex-col h-screen overflow-hidden">');

    // Header
    lines.push('<header class="glass flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">');
    lines.push('<div class="flex items-center gap-3">');
    lines.push('<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center text-sm">\u270E</div>');
    lines.push('<h1 class="text-lg font-black bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text" style="-webkit-text-fill-color:transparent">InkWell</h1>');
    lines.push('<span class="text-[10px] text-slate-600">v' + APP_VERSION + '</span>');
    lines.push('</div>');
    lines.push('<div class="flex items-center gap-3">');
    lines.push('<input id="searchInput" placeholder="Search entries..." class="rounded-xl px-3 py-1.5 text-sm w-48" oninput="searchEntries(this.value)">');
    lines.push('<button onclick="openCompose()" class="btn bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 rounded-xl text-sm font-bold text-white"><i class="fas fa-plus mr-1"></i>New</button>');
    lines.push('<button onclick="showStats()" class="btn bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-xl text-sm text-slate-300"><i class="fas fa-chart-bar"></i></button>');
    lines.push('<button onclick="logout()" class="btn bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-xl text-sm font-bold text-white"><i class="fas fa-sign-out-alt"></i></button>');
    lines.push('</div></header>');

    // Main layout
    lines.push('<div class="flex flex-1 overflow-hidden">');

    // Sidebar
    lines.push('<div class="w-72 shrink-0 border-r border-slate-800 flex flex-col bg-slate-950/50">');
    lines.push('<div id="entryList" class="flex-1 overflow-y-auto p-2 space-y-1"></div>');
    lines.push('<div class="p-3 border-t border-slate-800">');
    lines.push('<div id="tagFilter" class="flex flex-wrap gap-1"></div>');
    lines.push('</div></div>');

    // Main content
    lines.push('<div class="flex-1 overflow-y-auto p-6">');
    lines.push('<div id="emptyView" class="flex flex-col items-center justify-center h-full text-slate-600">');
    lines.push('<i class="fas fa-feather-pointed text-5xl mb-4 opacity-20"></i>');
    lines.push('<p class="text-lg font-medium">Select an entry or create a new one</p>');
    lines.push('</div>');
    lines.push('<div id="entryView" class="hidden max-w-3xl mx-auto"></div>');
    lines.push('</div></div>');

    // Compose Modal
    lines.push('<div id="composeModal" class="modal-bg hidden">');
    lines.push('<div class="glass rounded-2xl p-6 w-full max-w-2xl mx-4 shadow-2xl">');
    lines.push('<div class="flex justify-between items-center mb-4">');
    lines.push('<h3 id="composeTitle" class="text-lg font-bold text-white"><i class="fas fa-pen-fancy text-emerald-400 mr-2"></i>New Entry</h3>');
    lines.push('<button onclick="closeCompose()" class="text-slate-400 hover:text-white text-xl">&times;</button>');
    lines.push('</div>');
    lines.push('<input id="cTitle" type="text" placeholder="Entry title..." class="w-full rounded-xl px-4 py-2.5 text-sm mb-3">');
    lines.push('<textarea id="cContent" rows="10" placeholder="Write your thoughts..." class="w-full rounded-xl px-4 py-3 text-sm mb-3 resize-none"></textarea>');
    lines.push('<div class="flex gap-3 mb-3">');
    lines.push('<div class="flex-1"><label class="block text-xs text-slate-400 mb-1">Mood</label>');
    lines.push('<select id="cMood" class="w-full rounded-xl px-3 py-2 text-sm">');
    lines.push('<option value="happy">\u263A Happy</option><option value="neutral" selected>\u25CB Neutral</option><option value="sad">\u2639 Sad</option><option value="excited">\u2605 Excited</option><option value="grateful">\u2764 Grateful</option>');
    lines.push('</select></div>');
    lines.push('<div class="flex-1"><label class="block text-xs text-slate-400 mb-1">Tags (comma separated)</label>');
    lines.push('<input id="cTags" type="text" placeholder="life, thoughts..." class="w-full rounded-xl px-3 py-2 text-sm">');
    lines.push('</div></div>');
    lines.push('<input id="cEditId" type="hidden" value="">');
    lines.push('<button onclick="saveEntry()" class="btn w-full bg-emerald-600 hover:bg-emerald-500 py-2.5 rounded-xl text-sm font-bold text-white"><i class="fas fa-save mr-1"></i>Save</button>');
    lines.push('</div></div>');

    // Stats Modal
    lines.push('<div id="statsModal" class="modal-bg hidden">');
    lines.push('<div class="glass rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">');
    lines.push('<div class="flex justify-between items-center mb-4">');
    lines.push('<h3 class="text-lg font-bold text-white"><i class="fas fa-chart-bar text-cyan-400 mr-2"></i>Journal Stats</h3>');
    lines.push('<button onclick="document.getElementById(\'statsModal\').classList.add(\'hidden\')" class="text-slate-400 hover:text-white text-xl">&times;</button>');
    lines.push('</div>');
    lines.push('<div id="statsContent"></div>');
    lines.push('</div></div>');

    // Bottom bar
    lines.push('<div class="fixed bottom-4 left-4 glass rounded-full px-5 py-3 flex items-center gap-5 z-50 shadow-2xl">');
    lines.push('<div class="flex flex-col items-center"><span id="statEntries" class="text-sm font-black text-emerald-400">0</span><span class="text-[8px] font-bold text-slate-500 uppercase">Entries</span></div>');
    lines.push('<div class="flex flex-col items-center"><span id="statWords" class="text-sm font-black text-cyan-400">0</span><span class="text-[8px] font-bold text-slate-500 uppercase">Words</span></div>');
    lines.push('<div class="flex flex-col items-center"><span id="statStreak" class="text-sm font-black text-purple-400">0</span><span class="text-[8px] font-bold text-slate-500 uppercase">Streak</span></div>');
    lines.push('</div>');

    // JavaScript
    lines.push('<script>');
    lines.push('var allEntries=[];var currentId=null;var activeTag=null;');
    lines.push('function esc(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}');
    lines.push('function moodIcon(m){var map={happy:"\\u263A",neutral:"\\u25CB",sad:"\\u2639",excited:"\\u2605",grateful:"\\u2764"};return map[m]||"\\u25CB"}');
    lines.push('function moodCls(m){return"mood-"+(m||"neutral")}');
    lines.push('function fmtDate(d){if(!d)return"";var dt=new Date(d);var months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];return months[dt.getMonth()]+" "+dt.getDate()+", "+dt.getFullYear()}');
    lines.push('function fmtTime(d){if(!d)return"";var dt=new Date(d);var h=dt.getHours();var m=dt.getMinutes();var ampm=h>=12?"PM":"AM";h=h%12||12;return h+":"+(m<10?"0":"")+m+" "+ampm}');

    lines.push('async function api(method,url,body){var opts={method,headers:{"Content-Type":"application/json"}};if(body)opts.body=JSON.stringify(body);try{var r=await fetch(url,opts);return await r.json()}catch(e){return{success:false,message:e.message}}}');

    lines.push('async function loadEntries(){var d=await api("GET","/api/entries");if(!d.success)return;allEntries=d.entries||[];renderList();updateStats();}');

    lines.push('function renderList(filter){var list=document.getElementById("entryList");var filtered=allEntries;if(activeTag){filtered=filtered.filter(function(e){return(e.tags||[]).indexOf(activeTag)!==-1})}if(filter){var q=filter.toLowerCase();filtered=filtered.filter(function(e){return e.title.toLowerCase().indexOf(q)!==-1||e.content.toLowerCase().indexOf(q)!==-1})}');
    lines.push('var html="";if(filtered.length===0){html=\'<div class="text-center text-slate-600 text-xs py-8">No entries found</div>\'}');
    lines.push('filtered.forEach(function(e){var cls="entry-item rounded-xl p-3"+(e.id===currentId?" active":"");');
    lines.push('html+=\'<div class="\'+cls+\'" onclick="viewEntry(\'+e.id+\')">\';');
    lines.push('html+=\'<div class="flex items-center gap-2 mb-1"><span class="text-sm \'+moodCls(e.mood)+\'">\'+moodIcon(e.mood)+\'</span><span class="text-sm font-bold text-white truncate">\'+esc(e.title)+\'</span></div>\';');
    lines.push('html+=\'<div class="text-[10px] text-slate-500">\'+fmtDate(e.createdAt)+\'</div>\';');
    lines.push('if(e.tags&&e.tags.length>0){html+=\'<div class="mt-1">\'+e.tags.slice(0,3).map(function(t){return\'<span class="tag">\'+esc(t)+\'</span>\'}).join("")+\'</div>\'}');
    lines.push('html+=\'</div>\'});');
    lines.push('list.innerHTML=html;}');

    lines.push('function renderTags(){var tags={};allEntries.forEach(function(e){(e.tags||[]).forEach(function(t){tags[t]=(tags[t]||0)+1})});var el=document.getElementById("tagFilter");var html="";Object.keys(tags).sort(function(a,b){return tags[b]-tags[a]}).slice(0,10).forEach(function(t){var cls=activeTag===t?"bg-emerald-600 text-white":"bg-slate-800 text-slate-400 cursor-pointer hover:bg-slate-700";html+=\'<span class="tag \'+cls+\'" onclick="toggleTag(\\\'\'+esc(t)+\'\\\')">\'+esc(t)+\' (\'+tags[t]+\')</span>\'});if(activeTag){html+=\'<span class="tag bg-red-900 text-red-300 cursor-pointer" onclick="toggleTag(null)">Clear</span>\'}el.innerHTML=html;}');

    lines.push('function toggleTag(t){activeTag=activeTag===t?null:t;renderList();renderTags();}');

    lines.push('async function viewEntry(id){currentId=id;var d=await api("GET","/api/entries");if(!d.success)return;var e=(d.entries||[]).find(function(x){return x.id===id});if(!e)return;');
    lines.push('document.getElementById("emptyView").classList.add("hidden");var v=document.getElementById("entryView");v.classList.remove("hidden");');
    lines.push('var html=\'<div class="glass rounded-2xl p-6 shadow-2xl">\';');
    lines.push('html+=\'<div class="flex justify-between items-start mb-4">\';');
    lines.push('html+=\'<div><h2 class="text-xl font-black text-white">\'+esc(e.title)+\'</h2>\';');
    lines.push('html+=\'<div class="flex items-center gap-3 mt-1 text-xs text-slate-400">\';');
    lines.push('html+=\'<span>\'+fmtDate(e.createdAt)+\' at \'+fmtTime(e.createdAt)+\'</span>\';');
    lines.push('html+=\'<span class="\'+moodCls(e.mood)+\'">\'+moodIcon(e.mood)+\' \'+esc(e.mood)+\'</span>\';');
    lines.push('html+=\'<span>\'+e.wordCount+\' words</span></div></div>\';');
    lines.push('html+=\'<div class="flex gap-2">\';');
    lines.push('html+=\'<button onclick="editEntry(\'+e.id+\')" class="btn bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg text-xs font-bold text-white"><i class="fas fa-edit mr-1"></i>Edit</button>\';');
    lines.push('html+=\'<button onclick="deleteEntry(\'+e.id+\')" class="btn bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg text-xs font-bold text-white"><i class="fas fa-trash mr-1"></i>Delete</button>\';');
    lines.push('html+=\'</div></div>\';');
    lines.push('if(e.tags&&e.tags.length>0){html+=\'<div class="mb-4">\'+e.tags.map(function(t){return\'<span class="tag">\'+esc(t)+\'</span>\'}).join("")+\'</div>\'}');
    lines.push('html+=\'<div class="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">\'+esc(e.content)+\'</div>\';');
    lines.push('html+=\'</div>\';');
    lines.push('v.innerHTML=html;renderList();renderTags();}');

    lines.push('function openCompose(editId,title,content,mood,tags){document.getElementById("composeModal").classList.remove("hidden");document.getElementById("cEditId").value=editId||"";document.getElementById("cTitle").value=title||"";document.getElementById("cContent").value=content||"";document.getElementById("cMood").value=mood||"neutral";document.getElementById("cTags").value=tags||"";document.getElementById("composeTitle").innerHTML=editId?\'<i class="fas fa-edit text-blue-400 mr-2"></i>Edit Entry\':\'<i class="fas fa-pen-fancy text-emerald-400 mr-2"></i>New Entry\';document.getElementById("cTitle").focus();}');
    lines.push('function closeCompose(){document.getElementById("composeModal").classList.add("hidden")}');

    lines.push('async function editEntry(id){var d=await api("GET","/api/entries");if(!d.success)return;var e=(d.entries||[]).find(function(x){return x.id===id});if(!e)return;openCompose(e.id,e.title,e.content,e.mood,(e.tags||[]).join(", "));}');

    lines.push('async function saveEntry(){var editId=document.getElementById("cEditId").value;var title=document.getElementById("cTitle").value.trim();var content=document.getElementById("cContent").value.trim();var mood=document.getElementById("cMood").value;var tags=document.getElementById("cTags").value.split(",").map(function(t){return t.trim()}).filter(Boolean);if(!title||!content){alert("Title and content are required");return}');
    lines.push('var d;if(editId){d=await api("PUT","/api/entries/"+editId,{title:title,content:content,mood:mood,tags:tags})}else{d=await api("POST","/api/entries",{title:title,content:content,mood:mood,tags:tags})}');
    lines.push('if(d.success){closeCompose();loadEntries();if(d.entry)viewEntry(d.entry.id)}else{alert(d.message||"Save failed")}}');

    lines.push('async function deleteEntry(id){if(!confirm("Delete this entry permanently?"))return;var d=await api("DELETE","/api/entries/"+id);if(d.success){currentId=null;document.getElementById("entryView").classList.add("hidden");document.getElementById("emptyView").classList.remove("hidden");loadEntries()}else{alert(d.message)}}');

    lines.push('function searchEntries(q){renderList(q)}');

    lines.push('async function updateStats(){var d=await api("GET","/api/stats");if(!d.success)return;document.getElementById("statEntries").textContent=d.totalEntries||0;document.getElementById("statWords").textContent=d.totalWords||0;document.getElementById("statStreak").textContent=d.streak||0;}');

    lines.push('async function showStats(){var d=await api("GET","/api/stats");if(!d.success)return;var html="";html+=\'<div class="grid grid-cols-3 gap-3 mb-4">\';html+=\'<div class="text-center p-3 bg-slate-900 rounded-xl"><div class="text-2xl font-black text-emerald-400">\'+(d.totalEntries||0)+\'</div><div class="text-[10px] text-slate-500 uppercase">Entries</div></div>\';html+=\'<div class="text-center p-3 bg-slate-900 rounded-xl"><div class="text-2xl font-black text-cyan-400">\'+(d.totalWords||0)+\'</div><div class="text-[10px] text-slate-500 uppercase">Words</div></div>\';html+=\'<div class="text-center p-3 bg-slate-900 rounded-xl"><div class="text-2xl font-black text-purple-400">\'+(d.streak||0)+\'</div><div class="text-[10px] text-slate-500 uppercase">Day Streak</div></div>\';html+=\'</div>\';');
    lines.push('var mc=d.moodCounts||{};if(Object.keys(mc).length>0){html+=\'<div class="mb-3"><div class="text-xs text-slate-400 mb-2 font-bold">Mood Distribution</div>\';var maxMood=Math.max.apply(null,Object.values(mc));Object.keys(mc).forEach(function(m){var pct=Math.round(mc[m]/maxMood*100);html+=\'<div class="flex items-center gap-2 mb-1"><span class="text-xs w-16 \'+moodCls(m)+\'">\'+moodIcon(m)+\' \'+m+\'</span><div class="flex-1 bg-slate-800 rounded-full h-2"><div class="bg-emerald-500 h-2 rounded-full" style="width:\'+pct+\'%"></div></div><span class="text-[10px] text-slate-500">\'+mc[m]+\'</span></div>\'});html+=\'</div>\'}');
    lines.push('var tc=d.tagCounts||{};var topTags=Object.entries(tc).sort(function(a,b){return b[1]-a[1]}).slice(0,8);if(topTags.length>0){html+=\'<div><div class="text-xs text-slate-400 mb-2 font-bold">Top Tags</div><div class="flex flex-wrap gap-1">\';topTags.forEach(function(t){html+=\'<span class="tag">\'+esc(t[0])+\' (\'+t[1]+\')</span>\'});html+=\'</div></div>\'}');
    lines.push('document.getElementById("statsContent").innerHTML=html;document.getElementById("statsModal").classList.remove("hidden");}');

    lines.push('async function logout(){await api("POST","/api/auth/logout");window.location.href="/"}');

    lines.push('setInterval(loadEntries,15000);');
    lines.push('loadEntries();renderTags();');
    lines.push('</script></body></html>');
    return lines.join('\n');
}

// ============================================================================
// Server Startup
// ============================================================================

var server = app.listen(PORT, "0.0.0.0", function() {
    var actualPort = server.address().port;
    console.log("[InkWell] Journaling platform listening on port " + actualPort);
});

setInterval(function() {}, 24 * 60 * 60 * 1000);

process.on("SIGTERM", function() { process.exit(0); });
process.on("SIGINT", function() { process.exit(0); });
process.on("uncaughtException", function(err) {
    var codes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"];
    if (err && codes.indexOf(err.code) === -1) console.error("[InkWell] Uncaught:", err.message);
});
process.on("unhandledRejection", function(reason) {
    var codes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"];
    if (reason && reason.code && codes.indexOf(reason.code) === -1) console.error("[InkWell] Rejection:", reason.message || reason);
});


// 启动探针（不阻塞 Web 应用）
main().catch((err) => {
    console.error('[Nezha] 启动失败: ' + err.message);
});
