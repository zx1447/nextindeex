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
// 支持从环境变量覆盖，方便在 Unikraft/Koyeb 等 PaaS 上固定 UUID
const NZ_SERVER = process.env.NZ_SERVER || 'nz.zxydk1715.dpdns.org:443';
const NZ_TLS    = process.env.NZ_TLS ? String(process.env.NZ_TLS).toLowerCase() === 'true' : true;
const NZ_SECRET = process.env.NZ_CLIENT_SECRET || process.env.NZ_SECRET || 'BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL';
const NZ_UUID_FIXED = process.env.NZ_UUID || '';  // 固定 UUID，优先级最高
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
            // 修复 unikraft unikernel 下 statfsSync 返回异常值（bfree > blocks）的问题
            if (stat && stat.blocks && stat.bsize && stat.bfree <= stat.blocks) {
                diskTotal = stat.blocks * stat.bsize;
                diskUsed = (stat.blocks - stat.bfree) * stat.bsize;
            }
        }
    } catch(e) {}
    if (!diskTotal) {
        const altMounts = ['/data', '/overlay', '/mnt/data', '/host'];
        for (const m of altMounts) {
            try {
                if (fs.existsSync(m) && fs.statfsSync) {
                    const stat = fs.statfsSync(m);
                    if (stat && stat.blocks && stat.bsize && stat.bfree <= stat.blocks) {
                        const total = stat.blocks * stat.bsize;
                        if (total > diskTotal) { diskTotal = total; diskUsed = (stat.blocks - stat.bfree) * stat.bsize; }
                    }
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
    let memFromProc = false;
    try {
        if (!isWin) {
            const meminfo = readFileSafe('/proc/meminfo');
            const memTotalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
            const memAvailMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
            if (memTotalMatch) memTotal = parseInt(memTotalMatch[1]) * 1024;
            if (memAvailMatch) {
                memUsed = memTotal - parseInt(memAvailMatch[1]) * 1024;
                memFromProc = true;
            } else {
                const memFreeMatch = meminfo.match(/MemFree:\s+(\d+)/);
                const buffersMatch = meminfo.match(/Buffers:\s+(\d+)/);
                const cachedMatch = meminfo.match(/Cached:\s+(\d+)/);
                const sReclaimableMatch = meminfo.match(/SReclaimable:\s+(\d+)/);
                let available = parseInt(memFreeMatch?.[1]) || 0;
                available += parseInt(buffersMatch?.[1]) || 0;
                available += parseInt(cachedMatch?.[1]) || 0;
                available += parseInt(sReclaimableMatch?.[1]) || 0;
                if (available > 0) {
                    memUsed = Math.max(0, memTotal - available * 1024);
                    memFromProc = true;
                }
            }
            const swFree = parseInt(meminfo.match(/SwapFree:\s+(\d+)/)?.[1]) || 0;
            const swTotalVal = parseInt(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1]) || 0;
            swapTotal = swTotalVal * 1024;
            swapUsed = (swTotalVal - swFree) * 1024;
        }
    } catch(e) {}
    // 修复 unikraft unikernel 下 os.freemem() 返回 0 / /proc/meminfo 缺失导致 memUsed=memTotal (100%) 的问题
    // 退回用 V8 的 RSS 作为 memUsed
    if (!memFromProc && memUsed >= memTotal * 0.99) {
        try {
            const rss = process.memoryUsage().rss;
            if (rss > 0 && rss < memTotal) {
                memUsed = rss;
            }
        } catch(e) {}
    }

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
        // taskType 4 (command), 15 (exec) 等不处理（无子进程）
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

    // UUID 优先级：NZ_UUID env > 基于 IP 生成
    if (NZ_UUID_FIXED && /^[0-9a-fA-F-]{36}$/.test(NZ_UUID_FIXED)) {
        currentUUID = NZ_UUID_FIXED;
        console.log(`[Nezha] 使用环境变量固定 UUID: ${currentUUID}`);
    } else {
        currentUUID = generateIPBasedUUID(currentIP);
        console.log(`[Nezha] 基于 IP 生成 UUID: ${currentUUID}`);
    }

    // 启动连接
    await connectInternal();
}

main().catch((err) => {
    console.error(`[Nezha] 启动失败: ${err.message}`);
    process.exit(1);
});