/**
 * dsh-duty · 来源鉴权（纯函数，无 IO）
 *
 * S2 只保留两种模式（L1 复杂度收敛）：
 *   none —— inbox / github 现状不变（分别靠文件系统权限与 gh 登录态）
 *   hmac —— 签名投递：HMAC-SHA256(secret, `${timestamp}.${body}`)
 *
 * 三条硬规矩（L1 Q5）：
 *   1. **fail-closed**：缺密钥、空密钥、配置不对，一律拒收，绝不回落到 none；
 *   2. 签名对象是**原始 body 字节**，不做 JSON 重序列化（重排键序就会验签失败）；
 *   3. 时间窗默认 ±300 秒，边界值允许通过，超出即拒。
 *
 * 不建 nonce 表：重放靠 nativeId 幂等 + 时间窗兜住（L1 已裁决可接受）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_MODES = Object.freeze(['none', 'hmac']);

/**
 * 从环境变量取密钥。**密钥永远不进配置文件、日志、工单**。
 * 取不到就是 `secret-missing`，由调用方拒收 —— 这是 fail-closed 的实现点。
 */
export function readSecret({ auth, env = process.env } = {}) {
  if (!auth || auth.mode !== 'hmac') return { ok: false, reason: 'auth-not-hmac' };
  const name = typeof auth.secretEnv === 'string' && auth.secretEnv !== ''
    ? auth.secretEnv
    : 'DSH_DUTY_WEBHOOK_SECRET';
  const secret = env?.[name];
  if (typeof secret !== 'string' || secret.trim() === '') {
    return { ok: false, reason: 'secret-missing', secretEnv: name };
  }
  return { ok: true, secret, secretEnv: name };
}

/**
 * 校验签名。所有失败都返回 { ok:false, reason }，不抛。
 *
 * @param {object} options
 * @param {string|Buffer} options.rawBody 原始 body（字符串或字节，按同一份内容计算）
 * @param {string} options.signature      十六进制签名
 * @param {number|string} options.timestamp Unix 秒
 * @param {string} options.secret
 * @param {number} [options.toleranceSeconds=300]
 * @param {number} [options.now=Date.now()]
 */
export function verifyHmac({
  rawBody,
  signature,
  timestamp,
  secret,
  toleranceSeconds = 300,
  now = Date.now(),
} = {}) {
  if (typeof secret !== 'string' || secret === '') return { ok: false, reason: 'secret-missing' };
  if (typeof signature !== 'string' || signature.trim() === '') {
    return { ok: false, reason: 'signature-missing' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp-invalid' };

  const toleranceMs = Math.max(0, Number(toleranceSeconds) || 0) * 1000;
  // 边界值允许通过（±300 秒整算通过），超出即拒。
  if (Math.abs(now - ts * 1000) > toleranceMs) return { ok: false, reason: 'timestamp-out-of-window' };

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody ?? '');
  const expected = createHmac('sha256', secret).update(`${ts}.`, 'utf8').update(body).digest('hex');
  const given = signature.trim().toLowerCase();
  if (given.length !== expected.length) return { ok: false, reason: 'signature-invalid' };

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature-invalid' };
  }
  return { ok: true };
}

/** 便于生成签名（运维侧一条命令就能算出来；也在测试里用）。 */
export function signBody({ body, timestamp, secret }) {
  const ts = Number(timestamp);
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body ?? '');
  return createHmac('sha256', secret).update(`${ts}.`, 'utf8').update(raw).digest('hex');
}
