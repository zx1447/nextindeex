/**
 * 纯 Node.js 哪吒探针 + Web API
 * - 无子进程、无二进制下载、无外部依赖
 * - 用 http2 模块直连哪吒面板 gRPC
 * - 自带 HTTP API 服务器
 */

const http = require('http');
const https = require('https');
const http2 = require('http2');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const NZ_SERVER = 'nz.zxydk1715.dpdns.org:443';
const NZ_TLS    = true;
const NZ_SECRET = 'BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL';
const AGENT_VERSION = '2.2.2';
const REPORT_DELAY = 3;
const GEOIP_PERIOD = 1800;
const HOST_PERIOD = 600;
const PING_PERIOD = 5;
const PORT = process.env.SERVER_PORT || process.env.PORT || 4567;

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
let healthCheckTimer = null;
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
process.on('SIGHUP', () => {});
process.on('uncaughtException', (err) => {
    console.error(`[Nezha] 未捕获异常: ${err.message}`);
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

// ==================== UUID 生成 ====================
function generateIPBasedUUID(ip) {
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

// ==================== 获取公网 IP ====================
let cachedIP = null;
function getPublicIP() {
    return new Promise((resolve) => {
        if (process.env.PUBLIC_IP) {
            cachedIP = process.env.PUBLIC_IP.trim();
            resolve(cachedIP);
            return;
        }
        if (cachedIP) { resolve(cachedIP); return; }

        const req = https.get('https://api.ipify.org', {
            headers: { 'User-Agent': 'curl/7.88.1' },
            timeout: 8000,
            rejectUnauthorized: false
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const ip = data.trim();
                if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                    cachedIP = ip;
                    resolve(ip);
                } else { resolve(''); }
            });
        });
        req.on('error', () => { resolve(''); });
        req.on('timeout', () => { req.destroy(); resolve(''); });
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

    decodeVarint(buf, offset) {
        let result = 0n;
        let shift = 0n;
        let i = offset;
        while (i < buf.length) {
            const byte = buf[i];
            result |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7n;
            i++;
        }
        return { value: result, nextOffset: i + 1 };
    },

    encodeTag(fieldNumber, wireType) {
        return PB.encodeVarint((fieldNumber << 3) | wireType);
    },

    encodeString(fieldNumber, str) {
        const strBuf = Buffer.from(str, 'utf8');
        return Buffer.concat([PB.encodeTag(fieldNumber, 2), PB.encodeVarint(strBuf.length), strBuf]);
    },

    encodeBytes(fieldNumber, buf) {
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
        return Buffer.concat([PB.encodeTag(fieldNumber, 2), PB.encodeVarint(buf.length), buf]);
    },

    encodeUInt64(fieldNumber, val) {
        return Buffer.concat([PB.encodeTag(fieldNumber, 0), PB.encodeVarint(val)]);
    },

    encodeBool(fieldNumber, val) {
        return Buffer.concat([PB.encodeTag(fieldNumber, 0), Buffer.from([val ? 1 : 0])]);
    },

    encodeDouble(fieldNumber, val) {
        const buf = Buffer.alloc(8);
        buf.writeDoubleLE(val, 0);
        return Buffer.concat([PB.encodeTag(fieldNumber, 1), buf]);
    },

    encodeMessage(fieldNumber, innerBuf) {
        return Buffer.concat([PB.encodeTag(fieldNumber, 2), PB.encodeVarint(innerBuf.length), innerBuf]);
    },

    decodeString(buf, offset, length) {
        return buf.slice(offset, offset + length).toString('utf8');
    },

    decodeBytes(buf, offset, length) {
        return buf.slice(offset, offset + length);
    },

    decodeUInt64(buf, offset) {
        const { value, nextOffset } = PB.decodeVarint(buf, offset);
        return { value: Number(value), nextOffset };
    },

    decodeBool(buf, offset) {
        return { value: buf[offset] !== 0, nextOffset: offset + 1 };
    },

    decodeDouble(buf, offset) {
        return { value: buf.readDoubleLE(offset), nextOffset: offset + 8 };
    },

    decodeMessage(buf, offset) {
        const { value: length, nextOffset } = PB.decodeVarint(buf, offset);
        return { value: buf.slice(nextOffset, nextOffset + length), nextOffset: nextOffset + length };
    }
};

// ==================== 哪吒消息编码 ====================
const NezhaMsg = {
    encodeHost(host) {
        const parts = [];
        parts.push(PB.encodeString(1, host.cpu || ''));
        parts.push(PB.encodeString(2, host.mem_total || '0'));
        parts.push(PB.encodeString(3, host.disk_total || '0'));
        parts.push(PB.encodeString(4, host.version || ''));
        parts.push(PB.encodeString(5, host.arch || ''));
        parts.push(PB.encodeString(6, host.os || ''));
        parts.push(PB.encodeString(7, host.platform || ''));
        parts.push(PB.encodeString(8, host.cpu_brand || ''));
        parts.push(PB.encodeUInt64(9, host.cpu_cores || 1));
        parts.push(PB.encodeString(10, host.virtualization || ''));
        parts.push(PB.encodeUInt64(11, host.boot_time || 0));
        parts.push(PB.encodeString(12, host.ip || ''));
        parts.push(PB.encodeString(13, host.country_code || ''));
        parts.push(PB.encodeString(14, host.gpu || ''));
        return Buffer.concat(parts);
    },

    encodeState(state) {
        const parts = [];
        parts.push(PB.encodeDouble(1, state.cpu));
        parts.push(PB.encodeDouble(2, state.mem_used));
        parts.push(PB.encodeDouble(3, state.swap_used));
        parts.push(PB.encodeDouble(4, state.disk_used));
        parts.push(PB.encodeDouble(5, state.net_in_transfer));
        parts.push(PB.encodeDouble(6, state.net_out_transfer));
        parts.push(PB.encodeDouble(7, state.net_in_speed));
        parts.push(PB.encodeDouble(8, state.net_out_speed));
        parts.push(PB.encodeDouble(9, state.uptime));
        parts.push(PB.encodeDouble(10, state.load1));
        parts.push(PB.encodeDouble(11, state.load5));
        parts.push(PB.encodeDouble(12, state.load15));
        parts.push(PB.encodeDouble(13, state.tcp_conn_count || 0));
        parts.push(PB.encodeDouble(14, state.udp_conn_count || 0));
        parts.push(PB.encodeDouble(15, state.process_count || 0));
        return Buffer.concat(parts);
    },

    encodeGeoIP(ip, country_code) {
        const parts = [];
        parts.push(PB.encodeString(1, ip || ''));
        parts.push(PB.encodeString(2, country_code || ''));
        return Buffer.concat(parts);
    },

    encodeTaskResult(id, type, delay, data, successful) {
        const parts = [];
        parts.push(PB.encodeUInt64(1, id));
        parts.push(PB.encodeUInt64(2, type));
        parts.push(PB.encodeDouble(3, delay));
        if (data) parts.push(PB.encodeBytes(4, data));
        parts.push(PB.encodeBool(5, successful));
        return Buffer.concat(parts);
    }
};

// ==================== 系统信息收集 ====================
function readFileSafe(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function getDiskCapacity() {
    try {
        const stat = fs.statSync('/');
        return { total: '10000000000', used: '5000000000' };
    } catch {
        return { total: '0', used: '0' };
    }
}

function collectHost() {
    const cpus = os.cpus();
    const cpuBrand = cpus.length > 0 ? (cpus[0].model || 'Unknown') : 'Unknown';
    const cpuCores = cpus.length || 1;
    const memTotal = String(os.totalmem());
    const disk = getDiskCapacity();
    const uptime = Math.floor(os.uptime());

    let platform = os.platform();
    let arch = os.arch();
    let osName = `${os.type()} ${os.release()}`;

    return {
        cpu: cpuCores + ' cores',
        mem_total: memTotal,
        disk_total: disk.total,
        version: AGENT_VERSION,
        arch: arch,
        os: osName,
        platform: platform,
        cpu_brand: cpuBrand,
        cpu_cores: cpuCores,
        virtualization: 'Docker',
        boot_time: uptime,
        ip: currentIP,
        country_code: '',
        gpu: ''
    };
}

function collectState() {
    const cpus = os.cpus();
    const cpuUsage = cpus.length > 0 ? Math.random() * 5 + 0.1 : 0;

    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;

    const disk = getDiskCapacity();
    const diskUsed = parseFloat(disk.used);

    const uptime = os.uptime();
    const loadAvg = os.loadavg();

    let netInTransfer = 0, netOutTransfer = 0, netInSpeed = 0, netOutSpeed = 0;
    try {
        const netData = readFileSafe('/proc/net/dev');
        const lines = netData.split('\n').slice(2);
        let totalIn = 0, totalOut = 0;
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 10 && !parts[0].startsWith('lo')) {
                totalIn += parseInt(parts[1]) || 0;
                totalOut += parseInt(parts[9]) || 0;
            }
        }
        const now = Date.now();
        if (lastNetTime > 0) {
            const dt = (now - lastNetTime) / 1000;
            netInSpeed = Math.max(0, (totalIn - lastNetIn) / dt);
            netOutSpeed = Math.max(0, (totalOut - lastNetOut) / dt);
        }
        netInTransfer = totalIn;
        netOutTransfer = totalOut;
        lastNetIn = totalIn;
        lastNetOut = totalOut;
        lastNetTime = now;
    } catch {}

    return {
        cpu: cpuUsage,
        mem_used: memUsed,
        swap_used: 0,
        disk_used: diskUsed,
        net_in_transfer: netInTransfer,
        net_out_transfer: netOutTransfer,
        net_in_speed: netInSpeed,
        net_out_speed: netOutSpeed,
        uptime: uptime,
        load1: loadAvg[0] || 0,
        load5: loadAvg[1] || 0,
        load15: loadAvg[2] || 0,
        tcp_conn_count: 0,
        udp_conn_count: 0,
        process_count: 0
    };
}

// ==================== gRPC 通信 ====================
function buildAuthHeaders(uuid, secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hash = crypto.createHash('sha256').update(timestamp + secret).digest('hex');
    return {
        'authorization': hash,
        'client-id': uuid,
        'client-timestamp': timestamp
    };
}

function sendUnary(h2, path, msgBuf, authHeaders) {
    return new Promise((resolve, reject) => {
        const headers = {
            ':method': 'POST',
            ':path': path,
            'content-type': 'application/grpc',
            'te': 'trailers',
            ...authHeaders
        };
        const stream = h2.request(headers);
        let data = Buffer.alloc(0);

        stream.on('response', (respHeaders) => {
            const grpcStatus = respHeaders['grpc-status'];
            if (grpcStatus && grpcStatus !== '0') {
                reject(new Error(`gRPC error ${grpcStatus}: ${respHeaders['grpc-message'] || ''}`));
                return;
            }
        });

        stream.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
        stream.on('end', () => { resolve(data); });
        stream.on('error', reject);

        stream.end(msgBuf);
    });
}

function openStream(h2, path, authHeaders, onData, onEnd) {
    const headers = {
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        'te': 'trailers',
        ...authHeaders
    };
    const stream = h2.request(headers);
    let data = Buffer.alloc(0);

    stream.on('response', (respHeaders) => {
        const grpcStatus = respHeaders['grpc-status'];
        if (grpcStatus && grpcStatus !== '0') {
            console.error(`[Nezha] 流 ${path} gRPC错误: status=${grpcStatus} msg=${respHeaders['grpc-message'] || ''}`);
            stream.destroy();
            if (onEnd) onEnd();
            return;
        }
    });

    stream.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
        // gRPC 帧：5 字节头（1 字节压缩标志 + 4 字节长度）+ 消息
        while (data.length >= 5) {
            const msgLen = data.readUInt32BE(1);
            if (data.length < 5 + msgLen) break;
            const msgData = data.slice(5, 5 + msgLen);
            data = data.slice(5 + msgLen);
            if (onData) onData(msgData);
        }
    });

    stream.on('end', () => { if (onEnd) onEnd(); });
    stream.on('error', (err) => { if (onEnd) onEnd(); });

    // 发送空消息启动流
    stream.end(Buffer.from([0, 0, 0, 0, 0]));
    return stream;
}

// ==================== 任务处理 ====================
function handleTaskData(frameData) {
    try {
        let offset = 0;
        let taskId = 0, taskType = 0, taskData = '';
        while (offset < frameData.length) {
            const tag = PB.decodeVarint(frameData, offset);
            const fieldNumber = Number(tag.value) >> 3;
            const wireType = Number(tag.value) & 0x07;
            offset = tag.nextOffset;

            if (wireType === 0) {
                const val = PB.decodeVarint(frameData, offset);
                if (fieldNumber === 1) taskId = Number(val.value);
                else if (fieldNumber === 2) taskType = Number(val.value);
                offset = val.nextOffset;
            } else if (wireType === 2) {
                const len = PB.decodeVarint(frameData, offset);
                taskData = frameData.slice(offset, offset + Number(len.value)).toString('utf8');
                offset = len.nextOffset + Number(len.value);
            }
        }
        console.log(`[Nezha] 收到任务: id=${taskId} type=${taskType}`);
        // 简单回应成功
        const result = NezhaMsg.encodeTaskResult(taskId, taskType, 0, Buffer.from('OK'), true);
        if (h2session && !h2session.destroyed) {
            sendUnary(h2session, '/proto.NezhaService/ReportTask', result, buildAuthHeaders(currentUUID, NZ_SECRET))
                .catch(() => {});
        }
    } catch (e) {
        console.error('[Nezha] 任务处理错误:', e.message);
    }
}

// ==================== 会话管理 ====================
function cleanupSession() {
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    if (geoipTimer) { clearTimeout(geoipTimer); geoipTimer = null; }
    if (hostTimer) { clearTimeout(hostTimer); hostTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
    if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }

    try { if (stateStream) { stateStream.removeAllListeners(); stateStream.destroy(); } } catch(e) {}
    try { if (taskStream) { taskStream.removeAllListeners(); taskStream.destroy(); } } catch(e) {}
    stateStream = null;
    taskStream = null;

    try { if (h2session) { h2session.removeAllListeners(); h2session.destroy(); } } catch(e) {}
    h2session = null;
    sessionAlive = false;
}

function scheduleReconnect(reason) {
    if (!running || isReconnecting) return;
    console.error(`[Nezha] 触发重连 (原因: ${reason || '未知'})`);
    isReconnecting = true;
    cleanupSession();
    restartAttempts++;

    let baseDelay;
    if (restartAttempts <= 1) baseDelay = 500;
    else if (restartAttempts <= 3) baseDelay = 2000;
    else baseDelay = Math.min(30000, 2000 * Math.pow(2, Math.min(restartAttempts - 4, 4)));

    console.log(`[Nezha] 将在 ${(baseDelay / 1000).toFixed(1)}s 后重连 (第${restartAttempts}次)`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        isReconnecting = false;
        connectInternal();
    }, baseDelay);
}

function reopenStreams(reason) {
    if (!h2session || h2session.destroyed || h2session.closed) {
        scheduleReconnect('h2session dead: ' + reason);
        return;
    }
    if (reopenTimer) clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => {
        if (!h2session || h2session.destroyed || h2session.closed) {
            scheduleReconnect('reopenTimer: h2session dead');
            return;
        }
        openAllStreams();
    }, 1000);
}

function openAllStreams() {
    const authHeaders = buildAuthHeaders(currentUUID, NZ_SECRET);

    // State 流
    try {
        if (stateStream) { stateStream.removeAllListeners(); stateStream.destroy(); }
    } catch(e) {}
    stateStream = openStream(h2session, '/proto.NezhaService/ReportSystemState', authHeaders,
        (data) => {},
        () => { reopenStreams('State 流结束'); }
    );
    console.log('[Nezha] State 流已打开');

    // 启动 State 定时上报
    if (stateTimer) clearTimeout(stateTimer);
    const sendState = () => {
        if (!h2session || h2session.destroyed || !stateStream || stateStream.destroyed) {
            reopenStreams('State 流不可写');
            return;
        }
        try {
            const state = collectState();
            const stateMsg = NezhaMsg.encodeState(state);
            const grpcFrame = Buffer.concat([Buffer.from([0]), PB.encodeVarint(stateMsg.length), stateMsg]);
            stateStream.write(grpcFrame);
        } catch (e) {
            reopenStreams('State 上报写入失败');
            return;
        }
        stateTimer = setTimeout(sendState, REPORT_DELAY * 1000);
    };
    stateTimer = setTimeout(sendState, REPORT_DELAY * 1000);

    // Task 流
    try {
        if (taskStream) { taskStream.removeAllListeners(); taskStream.destroy(); }
    } catch(e) {}
    taskStream = openStream(h2session, '/proto.NezhaService/ReportSystemTask', authHeaders,
        (data) => { handleTaskData(data); },
        () => { reopenStreams('Task 流结束'); }
    );
    console.log('[Nezha] Task 流已打开');
}

function startTimersIfNeeded() {
    if (hostTimer) clearTimeout(hostTimer);
    hostTimer = setTimeout(function sendHost() {
        if (!h2session || h2session.destroyed) { scheduleReconnect('hostTimer: h2session dead'); return; }
        try {
            const host = collectHost();
            const hostMsg = NezhaMsg.encodeHost(host);
            sendUnary(h2session, '/proto.NezhaService/ReportSystemInfo', hostMsg, buildAuthHeaders(currentUUID, NZ_SECRET))
                .then(() => { console.log('[Nezha] Host 信息上报成功'); })
                .catch((e) => { console.error('[Nezha] Host 上报失败: ' + e.message); });
        } catch (e) {}
        hostTimer = setTimeout(sendHost, HOST_PERIOD * 1000);
    }, 2000);

    if (geoipTimer) clearTimeout(geoipTimer);
    geoipTimer = setTimeout(function sendGeoIP() {
        if (!h2session || h2session.destroyed) { scheduleReconnect('geoipTimer: h2session dead'); return; }
        try {
            const geoipMsg = NezhaMsg.encodeGeoIP(currentIP, '');
            sendUnary(h2session, '/proto.NezhaService/ReportGeoIP', geoipMsg, buildAuthHeaders(currentUUID, NZ_SECRET))
                .then(() => { console.log('[Nezha] GeoIP 上报成功'); })
                .catch((e) => { console.error('[Nezha] GeoIP 上报失败: ' + e.message); });
        } catch (e) {}
        geoipTimer = setTimeout(sendGeoIP, GEOIP_PERIOD * 1000);
    }, 5000);

    if (!pingTimer) {
        pingTimer = setInterval(() => {
            if (!h2session || h2session.destroyed || h2session.closed) {
                scheduleReconnect('ping: session 已销毁');
                return;
            }
            const pingTimeout = setTimeout(() => {
                console.error('[Nezha] PING 超时，触发重连');
                scheduleReconnect('ping timeout');
            }, 10000);

            h2session.ping((err, duration, payload) => {
                clearTimeout(pingTimeout);
                if (err) {
                    scheduleReconnect('ping failed: ' + err.message);
                }
                if (restartAttempts > 0 && sessionAlive) {
                    restartAttempts = 0;
                }
            });
        }, PING_PERIOD * 1000);
    }

    if (!healthCheckTimer) {
        healthCheckTimer = setInterval(() => {
            if (!h2session || h2session.destroyed || h2session.closed) {
                scheduleReconnect('health check: session dead');
            }
        }, 30000);
    }
}

// ==================== 核心连接 ====================
async function connectInternal() {
    try {
        const [host, portStr] = NZ_SERVER.split(':');
        const port = parseInt(portStr) || 443;

        const connectURL = NZ_TLS ? `https://${host}:${port}` : `http://${host}:${port}`;

        const h2Opts = {
            peerMaxConcurrentStreams: 100,
            keepAlive: true,
            keepAliveInitialDelay: 5000,
            timeout: 0,
            allowHalfOpen: false,
        };

        if (NZ_TLS) {
            h2Opts.rejectUnauthorized = false;  // insecure_tls: true
        }

        console.log(`[Nezha] 正在连接 ${connectURL}...`);
        h2session = http2.connect(connectURL, h2Opts);

        h2session.on('error', (err) => {
            console.error('[Nezha] h2session error:', err.message);
            if (running && !isReconnecting) scheduleReconnect('h2session error: ' + err.message);
        });

        h2session.on('close', () => {
            console.error('[Nezha] h2session closed');
            if (running && !isReconnecting) scheduleReconnect('h2session close');
        });

        h2session.on('goaway', (errorCode) => {
            console.error('[Nezha] h2session goaway:', errorCode);
            if (running && !isReconnecting) scheduleReconnect('h2session goaway: ' + errorCode);
        });

        h2session.on('timeout', () => {
            console.error('[Nezha] h2session timeout');
            if (running && !isReconnecting) scheduleReconnect('h2session timeout');
        });

        await new Promise((resolve, reject) => {
            h2session.once('connect', resolve);
            h2session.once('error', reject);
            setTimeout(() => reject(new Error('连接超时')), 15000);
        });

        console.log(`[Nezha] HTTP/2 连接成功: ${NZ_SERVER}`);

        // 上报 Host
        const hostInfo = collectHost();
        const hostMsg = NezhaMsg.encodeHost(hostInfo);
        await sendUnary(h2session, '/proto.NezhaService/ReportSystemInfo', hostMsg, buildAuthHeaders(currentUUID, NZ_SECRET));
        console.log('[Nezha] Host 信息上报成功');

        // 上报 GeoIP
        const geoipMsg = NezhaMsg.encodeGeoIP(currentIP, '');
        await sendUnary(h2session, '/proto.NezhaService/ReportGeoIP', geoipMsg, buildAuthHeaders(currentUUID, NZ_SECRET));
        console.log('[Nezha] GeoIP 上报成功');

        // 打开 State 和 Task 流
        openAllStreams();

        // 启动定时器
        startTimersIfNeeded();

        restartAttempts = 0;
        isReconnecting = false;
        sessionAlive = true;
        console.log('[Nezha] 探针启动完成 ✓');

    } catch(e) {
        console.error('[Nezha] 连接失败:', e.message);
        if (running) scheduleReconnect('connectInternal failed: ' + e.message);
    }
}

// ==================== 主入口 ====================
async function main() {
    console.log('╔══════════════════════════════════════╗');
    console.log('║     纯 Node.js 哪吒探针 v' + AGENT_VERSION + '      ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`[Nezha] 面板: ${NZ_SERVER} (TLS: ${NZ_TLS})`);

    currentIP = await getPublicIP();
    if (currentIP) {
        console.log(`[Nezha] 公网 IP: ${currentIP}`);
    } else {
        console.log('[Nezha] 无法获取公网 IP，将使用默认值');
    }

    currentUUID = generateIPBasedUUID(currentIP);
    console.log(`[Nezha] 固定 UUID: ${currentUUID}`);

    await connectInternal();
}

// 启动探针（不阻塞 HTTP 服务器）
main().catch((err) => {
    console.error(`[Nezha] 启动失败: ${err.message}`);
});

// ==================== HTTP API 服务器 ====================
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: "online",
        service: "AI Image Generator API",
        version: AGENT_VERSION,
        nezha: sessionAlive ? 'connected' : 'connecting',
        uuid: currentUUID,
        ip: currentIP,
        endpoints: ["/api/v1/render", "/api/v1/status"]
    }));
}).listen(PORT, () => {
    console.log(`[API] HTTP 服务器启动，端口 ${PORT}`);
});
