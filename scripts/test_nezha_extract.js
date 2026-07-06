// 模拟项目里的 parseImageMetadata + parseEnv 逻辑，独立验证配置能否解出
const fs = require('fs');
const crypto = require('crypto');

const CRYPTO_KEY = "1234567890abcdef1234567890abcdef";
const imagePath = '/tmp/dknz.png';

const buffer = fs.readFileSync(imagePath);
const startMarker = Buffer.from('==NZ_CONFIG_START==');
const endMarker = Buffer.from('==NZ_CONFIG_END==');

const startPos = buffer.indexOf(startMarker);
console.log('startPos:', startPos);

if (startPos === -1) {
    console.log('ERROR: 未找到 NZ_CONFIG_START 标记 → 图片里没有嵌入哪吒配置');
    process.exit(1);
}

const endPos = buffer.indexOf(endMarker, startPos);
console.log('endPos:', endPos);

if (endPos === -1) {
    console.log('ERROR: 找到起始标记但没找到结束标记 → 配置不完整');
    process.exit(1);
}

const payloadStr = buffer.slice(startPos + startMarker.length, endPos).toString('utf8').trim();
console.log('payloadStr length:', payloadStr.length);
console.log('payloadStr preview (first 200 chars):', payloadStr.substring(0, 200));

try {
    const parts = payloadStr.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encrypted = Buffer.from(parts.join(':'), 'hex');

    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(CRYPTO_KEY), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    console.log('\n=== DECRYPTED CONFIG ===');
    console.log(decrypted);

    // 解析 env
    const env = {};
    const regex = /(?:export\s+)?(NZ_SERVER|NZ_TLS|NZ_SECRET)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(decrypted)) !== null) {
        env[match[1]] = match[2];
    }
    console.log('\n=== PARSED ENV ===');
    console.log(JSON.stringify(env, null, 2));

    if (!env.NZ_SERVER || !env.NZ_SECRET) {
        console.log('\nERROR: 关键字段缺失 → NZ_SERVER 或 NZ_SECRET 为空');
    } else {
        console.log('\nOK: 配置完整，哪吒 agent 应该能启动');
    }
} catch (e) {
    console.log('\nDECRYPT ERROR:', e.message);
}
