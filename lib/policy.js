/**
 * dsh-duty · 策略（默认值 + 归一化）
 *
 * 策略是「谁能通过哪个来源让我干活」的唯一出处。没有分散在各处的隐含规则。
 *
 * S2（2026-11-14）新增 `types`：按业务类型的派工姿态。
 * 两个入口的严格度**故意不同**：
 *   · normalizePolicy（读盘）—— 宽容：坏值丢弃，绝不让坏配置打死插件；
 *   · validatePolicy（写入）—— 严格：`dispatch:'act'` 或未知值必须报错，
 *     不得静默降级成 inherit（L1 断言表要求「不静默降级」）。
 */

import {
  DEFAULT_HOLD_TYPES,
  DISPATCH_MODES,
  isValidType,
  isAllowed,
  policyVersion,
} from './domain.js';

/** 默认策略：**一个人都没有** —— 不配置就谁也调用不动。这是故意的。 */
export function defaultPolicy({ workspace = null } = {}) {
  return {
    mode: 'observe',
    sources: {
      inbox: { enabled: true, allowed: [] },
      /** GitHub 只读源：默认开着但名单为空 ⇒ 不轮询、也收不了单。 */
      github: { enabled: true, allowed: [] },
      /** S2：签名投递源。默认关闭；打开必须配 auth.mode='hmac' + secretEnv。 */
      webhook: { enabled: false, allowed: [], auth: { mode: 'none' } },
    },
    limits: {
      cooldownSeconds: 300,
      maxAcceptsPerActorPerHour: 6,
    },
    /** type -> { dispatch: 'inherit'|'observe'|'hold' }；'*' 是通配。 */
    types: {},
    workspace,
  };
}

/** 归一化：从磁盘读回的东西一律过一遍，坏值回落默认，绝不让坏配置打死插件。 */
export function normalizePolicy(input) {
  const base = defaultPolicy();
  const value = input && typeof input === 'object' ? input : {};

  // 先铺默认来源，再用配置覆盖：这样老配置文件（只有 inbox）也能自动长出 github，
  // 而不是因为「没写这个 key」就静默少一个源。
  const sources = {};
  for (const [id, source] of Object.entries(base.sources)) sources[id] = { ...source };
  for (const [id, source] of Object.entries(value.sources ?? {})) {
    if (!source || typeof source !== 'object') continue;
    sources[id] = {
      enabled: source.enabled !== false,
      allowed: Array.isArray(source.allowed)
        ? source.allowed
            .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
            .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
        : [],
      auth: normalizeAuth(source.auth),
    };
  }
  if (Object.keys(sources).length === 0) sources.inbox = { enabled: true, allowed: [] };

  const limits = value.limits && typeof value.limits === 'object' ? value.limits : {};
  return {
    mode: value.mode === 'act' ? 'act' : 'observe',
    sources,
    limits: {
      cooldownSeconds: clampInt(limits.cooldownSeconds, base.limits.cooldownSeconds, 0, 86400),
      maxAcceptsPerActorPerHour: clampInt(
        limits.maxAcceptsPerActorPerHour,
        base.limits.maxAcceptsPerActorPerHour,
        0,
        1000,
      ),
    },
    types: normalizeTypes(value.types),
    workspace: typeof value.workspace === 'string' ? value.workspace : base.workspace,
  };
}

/**
 * 来源鉴权归一化（L1 复杂度收敛：只保留 {none, hmac}，不引入 allowlist ——
 * actor 白名单已是独立规则，同名机制会把「谁的人」与「怎么证明」混为一谈）。
 */
export function normalizeAuth(auth) {
  const value = auth && typeof auth === 'object' ? auth : null;
  if (!value) return { mode: 'none' };
  if (value.mode !== 'hmac') return { mode: 'none' };
  return {
    mode: 'hmac',
    /** 密钥只从环境变量读，**绝不写进配置文件**。 */
    secretEnv: typeof value.secretEnv === 'string' && value.secretEnv !== ''
      ? value.secretEnv
      : 'DSH_DUTY_WEBHOOK_SECRET',
    toleranceSeconds: clampInt(value.toleranceSeconds, 300, 0, 3600),
  };
}

/** 读盘宽容：非法 dispatch 值直接丢弃（不让坏配置打死插件）。 */
function normalizeTypes(types) {
  const out = {};
  if (!types || typeof types !== 'object') return out;
  for (const [type, value] of Object.entries(types)) {
    if (!value || typeof value !== 'object') continue;
    if (!DISPATCH_MODES.includes(value.dispatch)) continue;
    if (type !== '*' && !isValidType(type)) continue;
    out[type] = { dispatch: value.dispatch };
  }
  return out;
}

/**
 * 写入严格：返回 { ok, errors }。**不静默降级**——
 * 写进 `dispatch:'act'` 或拼错的 `hold` 都必须被拒，否则人会以为生效了。
 */
export function validatePolicy(input) {
  const errors = [];
  const value = input && typeof input === 'object' ? input : {};
  if (value.mode !== undefined && !['observe', 'act'].includes(value.mode)) {
    errors.push(`mode 只能是 observe 或 act，收到 ${JSON.stringify(value.mode)}`);
  }
  const types = value.types;
  if (types !== undefined) {
    if (!types || typeof types !== 'object' || Array.isArray(types)) {
      errors.push('types 必须是对象');
    } else {
      for (const [type, spec] of Object.entries(types)) {
        if (type !== '*' && !isValidType(type)) {
          errors.push(`types.${type}: 类型名不合法（需 a.b 形式）`);
          continue;
        }
        if (!spec || typeof spec !== 'object') {
          errors.push(`types.${type}: 值必须是 { dispatch }`);
          continue;
        }
        if (!DISPATCH_MODES.includes(spec.dispatch)) {
          errors.push(
            `types.${type}.dispatch=${JSON.stringify(spec.dispatch)} 非法（只允许 ${DISPATCH_MODES.join(' / ')}；没有 act）`,
          );
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 便于面板/工具显示：这一版策略「收口」得多严。 */
export function describePolicy(policy) {
  const version = policyVersion(policy);
  const sources = Object.entries(policy.sources ?? {}).map(([id, s]) => ({
    id,
    enabled: s.enabled !== false,
    allowed: (s.allowed ?? []).map((a) => a.id),
    auth: s.auth?.mode ?? 'none',
  }));
  return {
    version,
    mode: policy.mode,
    workspace: policy.workspace,
    limits: policy.limits,
    sources,
    /** 按类型配置的姿态 + 内置高危类型，面板与 status 都看这一份。 */
    types: policy.types ?? {},
    holdTypes: [...DEFAULT_HOLD_TYPES],
    /** 一条白名单都没有 = 谁都进不来。 */
    open: sources.some((s) => s.enabled && s.allowed.length > 0) === false,
  };
}

export { isAllowed };
