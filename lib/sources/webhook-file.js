/**
 * dsh-duty · 签名投递源（文件形式，无公网监听）
 *
 * 为什么不直接开 HTTP：L1 明令「不新增公网监听、Webhook HTTP 入口」。
 * 所以这一层把签名信封做成**文件投递**：任何进程把一份 `*.json` 写进
 * `<inbox-webhook>/`，扫描器校验签名后转成一条普通事件。
 *
 * 信封格式（外层的 `body` 必须是**字符串**，这样签名才能对原始字节生效）：
 * ```json
 * {
 *   "timestamp": 1793579991,
 *   "signature": "<hex>",
 *   "body": "{\"nativeId\":\"order-123\",\"type\":\"code.change\",\"text\":\"...\"}"
 * }
 * ```
 * 签名算法见 lib/sources/auth.js：HMAC-SHA256(secret, `${timestamp}.${body}`)。
 */

/** 允许出现在 payload 里、并会被透传给 submit 的字段。其余字段忽略。 */
const PAYLOAD_FIELDS = [
  'nativeId',
  'text',
  'title',
  'actor',
  'type',
  'link',
  'correlationId',
];

/**
 * 解析信封。返回 { ok:true, envelope } 或 { ok:false, reason }，不抛。
 * @param {string|Buffer} raw 文件原始内容
 */
export function parseEnvelope(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw ?? '').toString('utf8');
  if (text.trim() === '') return { ok: false, reason: 'empty-envelope' };

  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad-envelope-json' };
  }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) {
    return { ok: false, reason: 'envelope-not-object' };
  }
  // body 必须是字符串：对象身份无法逐字节复现，等于让签名失效。
  if (typeof outer.body !== 'string' || outer.body === '') {
    return { ok: false, reason: 'body-must-be-string' };
  }
  if (typeof outer.signature !== 'string' || outer.signature.trim() === '') {
    return { ok: false, reason: 'signature-missing' };
  }
  if (outer.timestamp === undefined || outer.timestamp === null) {
    return { ok: false, reason: 'timestamp-missing' };
  }

  let payload;
  try {
    payload = JSON.parse(outer.body);
  } catch {
    return { ok: false, reason: 'bad-body-json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'body-not-object' };
  }
  if (typeof payload.text !== 'string' || payload.text.trim() === '') {
    return { ok: false, reason: 'text-missing' };
  }

  const picked = {};
  for (const field of PAYLOAD_FIELDS) {
    if (payload[field] !== undefined && payload[field] !== null) picked[field] = payload[field];
  }

  return {
    ok: true,
    envelope: {
      rawBody: outer.body,
      signature: outer.signature,
      timestamp: outer.timestamp,
      payload: picked,
    },
  };
}
