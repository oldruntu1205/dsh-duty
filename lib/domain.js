/**
 * dsh-duty · 领域模型（纯函数，无 IO、无宿主依赖）
 *
 * 这里放的是「五条设计」里可被确定性断言的那部分：
 *   1. 授权与上下文分离 —— route() 的 fanout 分支不产生工单，权限只来自 Mandate
 *   2. 授权是快照      —— Mandate 记录 accept 时的 policyVersion；policyChanged() 只记不撤
 *   3. 幂等靠 Trigger  —— triggerId 是内容哈希，accept 的工单 id 也由它派生
 *   5. 注意力预算      —— observe 模式下工单落成 'observed'，不派工
 *
 * S2（2026-11-14）新增，全部经 L1 裁决：
 *   · Trigger 带 type / link / correlationId，**三者都不进 triggerId**（Q1）
 *   · 按类型分级派工 { inherit | observe | hold }；policy.mode='observe' 是全局上限（Q2）
 *   · held 复用 state='open' + dispatch='held'，不可领、不可派（Q3）
 *   · 跨源关联 fanout 不前置授权门禁（Q4 二次裁定 A），但关联本身要校验来源权限
 *   · 内置高危类型默认 hold，通配 `*` 不得解除（Q6）
 *
 * 所有入参都不被修改；返回新对象。时间用毫秒整数，方便测试注入。
 */

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;

export const DECISIONS = Object.freeze(['accept', 'stop', 'ignore', 'unavailable']);
export const STRENGTHS = Object.freeze(['explicit', 'inferred']);

/** 缺省业务类型：手工投递、没有更具体分类时用它。 */
export const DEFAULT_TYPE = 'task.manual';

/**
 * 业务类型命名空间：至少两级（`code.change`），允许多级（`a.b.c`）。
 * 早前文案写的「两级」是错的 —— 正则本来就允许多级，S2 按 L1 裁决修正文案。
 */
export const TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * 按类型可配置的派工姿态。
 *
 * 只有三种，**没有 `act`**（L1 Q2）：`policy.mode` 已经是全局开关，
 * 再给类型一个 `act` 就等于允许局部突破全局上限，会造成越权执行。
 *   inherit = 跟随 policy.mode
 *   observe = 即使在 act 全局下也只观察
 *   hold    = 等人工处置，永不自动派工
 */
export const DISPATCH_MODES = Object.freeze(['inherit', 'observe', 'hold']);

/**
 * 内置高危类型：默认 hold，**通配 `*` 不得解除**（L1 Q6）。
 * 精确配置可以覆盖（例如显式把 `deploy.prod` 设成 observe），且只接受受信任的人工策略修改。
 */
export const DEFAULT_HOLD_TYPES = Object.freeze([
  'deploy.prod',
  'delete.data',
  'stop.service',
  'spend.money',
  'send.external',
  'rotate.secret',
  'change.permission',
  'change.direction',
]);

/** 类型是否合法。非法类型**必须被拒收**，不得降级成 task.manual（L1 断言表）。 */
export function isValidType(type) {
  return typeof type === 'string' && TYPE_PATTERN.test(type);
}

/** link 归一化：只接受 http(s)、≤2048 字符；其余一律 null，且不抛错。 */
export function normalizeLink(link) {
  if (typeof link !== 'string') return null;
  const value = link.trim();
  if (value === '' || value.length > 2048) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    return null;
  }
  return value;
}

/**
 * 按类型解析派工姿态 → 'ready' | 'observed' | 'held'。
 *
 * 优先级（L1 Q6 固定）：精确配置 → 内置高危 → `*` → inherit。
 * `policy.mode !== 'act'` 是**全局上限**：任何配置都不得产生 'ready'。
 */
export function resolveDispatch({ policy, type = DEFAULT_TYPE, mode = null } = {}) {
  const effectiveMode = mode ?? policy?.mode ?? 'observe';
  const types = policy?.types ?? {};

  const explicit = types?.[type]?.dispatch;
  let posture;
  if (explicit && DISPATCH_MODES.includes(explicit)) posture = explicit;
  else if (DEFAULT_HOLD_TYPES.includes(type)) posture = 'hold';
  else posture = types?.['*']?.dispatch ?? 'inherit';

  if (posture === 'hold') return 'held';
  if (effectiveMode !== 'act') return 'observed';
  if (posture === 'observe') return 'observed';
  return 'ready';
}

/**
 * 工单声明的工具面 = 执行器 preset **实际**给出的工具。
 *
 * 为什么必须一字不差：preset 自带的工具无法用 `tools.restrict` 收回
 * （它们不在 restrict 的可收敛集合里，见 lib/tool-filter.js），只能靠 preset 里「不给」。
 * 2026-11-07 实测：声明 8 个、实际给 14 个，执行器当场指出这个不一致。
 * 所以这份清单必须与 cordis.patch.yml 的 duty-worker preset 保持一致。
 */
export const DEFAULT_TOOL_SCOPE = Object.freeze([
  'read',
  'write',
  'edit',
  'grep',
  'glob',
  'pwsh',
  'job_list',
  'job_output',
  'job_kill',
  'read_image',
  'skill',
  'todo_write',
  'working_directory',
]);

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 稳定序列化：同样的对象内容永远得到同样的字符串（键序无关）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 幂等的根：一个 Trigger 的 id 只由「哪个源 + 源自己的原生 id」决定。
 *
 * **刻意不含 kind**：kind（request/message）只是路由时的读法，同一件源侧的事
 * 不该因为这次被读成"消息"、下次被读成"请求"就换一个身份。
 * （2026-11-07 P1 实测踩到：把 kind 算进去后，同一 issue 的第二次轮询绕过了幂等。）
 *
 * **S2 同样不含 type / link / correlationId**（L1 Q1）：重新分类或补链接
 * 都不该产生新工单。代价是「投错类型无法原位纠正」——本轮不提供纠正入口，
 * 如需纠正应走显式、可审计的变更并保留原 id。
 */
export function triggerId({ sourceId, nativeId }) {
  const raw = `${sourceId}\u0000${nativeId}`;
  return `trg_${digest(raw).slice(0, 32)}`;
}

/** 策略版本 = 策略内容的哈希。改一个字段，版本就变；不存储、不递增、不依赖时钟。 */
export function policyVersion(policy) {
  return `pol_${digest(stableStringify(policy)).slice(0, 32)}`;
}

/** 构造一个不可变的 Trigger。类型合法性由调用方校验（Duty.submit 负责拒收）。 */
export function makeTrigger({
  sourceId,
  kind = 'request',
  nativeId,
  actor = 'unknown',
  text = '',
  title,
  type = DEFAULT_TYPE,
  link = null,
  correlationId = null,
  threadId = null,
  at = Date.now(),
}) {
  const trigger = {
    id: triggerId({ sourceId, nativeId }),
    sourceId,
    kind,
    nativeId,
    actor,
    text,
    title: title ?? firstLine(text),
    type,
    link: normalizeLink(link),
    correlationId: typeof correlationId === 'string' && correlationId.trim() !== ''
      ? correlationId.trim().slice(0, 200)
      : null,
    threadId,
    at,
  };
  return Object.freeze(trigger);
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, 120);
}

/** 某来源里这个 actor 是否在允许名单上。名单是「来源的一部分」，不跨源映射身份。 */
export function isAllowed(policy, sourceId, actor) {
  const source = policy?.sources?.[sourceId];
  if (!source || source.enabled === false) return false;
  const allowed = Array.isArray(source.allowed) ? source.allowed : [];
  return allowed.some((entry) => (typeof entry === 'string' ? entry : entry?.id) === actor);
}

const deny = (reason, extra = {}) => ({ verdict: 'deny', reason, ...extra });

/**
 * 确定性门禁：只有规则，没有模型判断。
 * 顺序：来源开没开 → 是不是允许的人 → 线程冷静期 → 该 actor 的频率上限。
 */
export function gate({ trigger, policy, state, now = Date.now() }) {
  const source = policy?.sources?.[trigger.sourceId];
  if (!source || source.enabled === false) return deny('source-off');
  if (!isAllowed(policy, trigger.sourceId, trigger.actor)) return deny('actor-not-allowed');

  const limits = policy?.limits ?? {};
  const cooldownMs = Math.max(0, Number(limits.cooldownSeconds ?? 0)) * 1000;
  if (trigger.threadId && cooldownMs > 0) {
    const last = state?.lastAcceptByThread?.get(trigger.threadId);
    if (typeof last === 'number' && now - last < cooldownMs) {
      return deny('thread-cooldown', { retryAfterMs: cooldownMs - (now - last) });
    }
  }

  const maxPerHour = Number(limits.maxAcceptsPerActorPerHour ?? 0);
  if (maxPerHour > 0) {
    const windowStart = now - 3600_000;
    const used = (state?.accepts ?? []).filter(
      (a) => a.actor === trigger.actor && a.at >= windowStart,
    ).length;
    if (used >= maxPerHour) return deny('actor-rate-limit', { used, maxPerHour });
  }

  return { verdict: 'allow' };
}

/**
 * 跨源关联的授权校验（L1 Q4 后半段，未被撤回）。
 *
 * 光知道 correlationId 不够：只有「同一来源」或「同一投递人」才能把自己的事件并进
 * 别人的在跑工单，否则一个陌生来源就能借 correlationId 污染上下文。
 */
export function canCorrelate({ trigger, ticket }) {
  const mandate = ticket?.mandate;
  if (!mandate) return false;
  if (trigger?.sourceId && trigger.sourceId === mandate.sourceId) return true;
  if (trigger?.actor && trigger.actor === mandate.actor) return true;
  return false;
}

/**
 * 路由：一条 Trigger 该走哪条路。**这是「授权与上下文分离」唯一实现处。**
 *
 *   1. 已经受理过           → duplicate（幂等）
 *   2. correlationId 命中在跑工单 → fanout（跨源合并；关联权限不足则 denied）
 *   3. 它落在某个在跑工单的线程上 → fanout（只加上下文，绝不新建工单、不查白名单）
 *   4. 门禁不放行           → denied
 *   5. 其余                 → evaluate（P0 的显式投递直接 accept）
 *
 * 注：fanout 分支**不前置授权门禁**。2026-11-14 L1 二次裁定：fanout 只写一条审计
 * 处置记录，不碰 ticket、不改变执行器输入，因此「授权与上下文分离」保留原语义。
 * 若将来 fanout 真要往工单里写内容，必须先补准入门禁。
 */
export function route({ trigger, policy, state, now = Date.now() }) {
  if (state?.ticketByTrigger?.has(trigger.id)) {
    return { kind: 'duplicate', triggerId: trigger.id, ticketId: state.ticketByTrigger.get(trigger.id) };
  }

  if (trigger.correlationId && state?.ticketByCorrelation) {
    const correlatedId = state.ticketByCorrelation.get(trigger.correlationId);
    const correlated = correlatedId ? state.tickets?.get(correlatedId) : null;
    // 已结束的目标不得命中：合并只对「正在跑」的工单有意义。
    if (correlated && correlated.state === 'open') {
      if (canCorrelate({ trigger, ticket: correlated })) {
        return { kind: 'fanout', triggerId: trigger.id, ticketIds: [correlated.id], via: 'correlation' };
      }
      return { kind: 'denied', triggerId: trigger.id, reason: 'correlation-not-authorized', ticketId: correlated.id };
    }
  }

  if (trigger.kind === 'message' && trigger.threadId) {
    const owned = state?.liveTicketsByThread?.get(trigger.threadId) ?? [];
    if (owned.length > 0) return { kind: 'fanout', triggerId: trigger.id, ticketIds: [...owned], via: 'thread' };
  }

  const verdict = gate({ trigger, policy, state, now });
  if (verdict.verdict === 'deny') return { kind: 'denied', triggerId: trigger.id, ...verdict };

  return { kind: 'evaluate', triggerId: trigger.id };
}

/**
 * 受理：把 Trigger 变成一张带 Mandate 的工单。
 *
 * mandate 是**授权快照**：policyVersion 冻结在此刻；之后策略怎么改，这张工单的授权不跟着变。
 * 工单 id 由 triggerId + policyVersion 派生 → 同一件事在同一版策略下只可能有一张工单。
 *
 * dispatch 由调用方用 resolveDispatch() 算好传入；不传时按 mode 的旧语义回落（保持兼容）。
 */
export function accept({
  trigger,
  policy,
  plan = {},
  mode = 'observe',
  dispatch = null,
  now = Date.now(),
}) {
  const mandate = Object.freeze({
    policyVersion: policyVersion(policy),
    sourceId: trigger.sourceId,
    actor: trigger.actor,
    strength: plan.strength ?? 'explicit',
    scope: plan.scope ?? 'propose',
    rules: Object.freeze([...(plan.rules ?? [])]),
    grantedAt: now,
  });

  const id = `tkt_${digest(`${trigger.id}\u0000${mandate.policyVersion}`).slice(0, 24)}`;

  return {
    id,
    state: 'open',
    originTriggerId: trigger.id,
    title: plan.title ?? trigger.title,
    /**
     * 请求原文。**必须存**：执行器只看得到工单，看不到 Trigger。
     * 2026-11-07 实测踩到：只存 title 时，执行器拿到的是一句标题（"验证工具面…"），
     * 于是自己去做开放式调查，跑 250+ 事件不结束 —— 因为它根本不知道要做什么。
     */
    text: String(trigger.text ?? ''),
    /** S2：执行器与面板都要看得到分类与回链，所以从 Trigger 复制一份。 */
    type: trigger.type ?? DEFAULT_TYPE,
    link: trigger.link ?? null,
    correlationId: trigger.correlationId ?? null,
    mandate,
    threads: trigger.threadId ? [trigger.threadId] : [],
    toolScope: Object.freeze([...(plan.toolScope ?? DEFAULT_TOOL_SCOPE)]),
    /** observed = 只记下「本来会做」，不派工；ready = 可被领取；held = 等人工处置，永不自动派。 */
    dispatch: dispatch ?? resolveDispatch({ policy, type: trigger.type ?? DEFAULT_TYPE, mode }),
    assignments: [],
    createdAt: now,
    endedAt: null,
    endedReason: null,
    stoppedByPerson: false,
  };
}

/** 派工只读 Mandate，不读 Trigger。调用方拿不到 Trigger 也能判断。 */
export function canDispatch(ticket) {
  return ticket?.state === 'open' && ticket?.dispatch === 'ready';
}

/**
 * Assignment：把一张工单绑定到一个执行器实例。
 *
 * 一张工单可以有多条 Assignment（重派、换执行器），但同一时刻只允许一条在跑 ——
 * 否则同一个工单会被两个执行器同时改。
 */
export function makeAssignment({ ticketId, executorId, at = Date.now() }) {
  const id = `asg_${digest(`${ticketId}\u0000${executorId}\u0000${at}`).slice(0, 24)}`;
  return {
    id,
    ticketId,
    executorId,
    state: 'running',
    startedAt: at,
    endedAt: null,
    endedReason: null,
  };
}

/**
 * 策略变更：**只投递通知，不撤销授权**。
 * 返回每条受影响工单该收到的说明；使命中不了任何人的变更返回空数组。
 *
 * S2：held 工单也照常收通知，但**不会因为改策略自动释放**（L1 Q3）——
 * 放行必须针对具体工单显式记录，本轮不提供放行入口。
 */
export function policyChanged({ tickets = [], nextPolicy, previousPolicyVersion = null }) {
  const next = policyVersion(nextPolicy);
  const out = [];
  for (const ticket of tickets) {
    if (ticket.state !== 'open') continue;
    const same = ticket.mandate?.policyVersion === next;
    if (same && previousPolicyVersion === next) continue;
    out.push({
      ticketId: ticket.id,
      kind: 'policy-change',
      from: ticket.mandate?.policyVersion ?? null,
      to: next,
      stillAllowed: isAllowed(nextPolicy, ticket.mandate?.sourceId, ticket.mandate?.actor),
    });
  }
  return out;
}

/**
 * 恢复工单前的重新校验。授权是快照，但**快照过期不等于永远有效**：
 * 人显式停掉的永远不能自己恢复；白名单已删除这个人的，拒绝恢复。
 */
export function validateResume({ ticket, policy }) {
  if (ticket?.stoppedByPerson) return { ok: false, reason: 'stopped-by-person' };
  if (ticket?.state === 'ended') return { ok: false, reason: 'ended' };
  if (ticket?.dispatch === 'held') return { ok: false, reason: 'held-needs-person' };
  const { sourceId, actor } = ticket?.mandate ?? {};
  if (!isAllowed(policy, sourceId, actor)) return { ok: false, reason: 'mandate-revoked' };
  return { ok: true };
}
