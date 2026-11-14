/**
 * dsh-duty · 面板 API（宿主侧）
 *
 * 为什么单独一层：面板要读的东西比 `duty_status` 多（工单列表、在跑状态、最近结束），
 * 而 HTTP 层不该长业务判断。这里只做两件事：
 *   1. `panelSnapshot(duty)` —— 把内存投影映射成**可直接渲染**的 JSON（纯函数，可单测）
 *   2. `createPanelApi({ openDuty })` —— 五个动作：state / submit / poll / policy / report
 *
 * 约束：
 *   - 不 import 任何 @deepseek-ai/*（link: 安装解析不到 profile 的 node_modules）
 *   - 不碰 req/res（HTTP 细节留给 index.js），因此可以脱离宿主跑测试
 *   - 每次动作前用 `openDuty()` 重读磁盘：面板看到的是**当前**状态，
 *     不是插件启动那一刻的快照（定时器也在做同样的事）
 */

/** 单条工单展示时最多带多少正文（面板不负责展示完整报告）。 */
const TEXT_LIMIT = 1200;
/** 快照里最多列多少张工单（开放优先，其余按创建时间倒序）。 */
const TICKET_LIMIT = 60;
/** 投递正文上限：面板是入口，不是文档库。 */
export const SUBMIT_TEXT_LIMIT = 8000;

export class PanelError extends Error {
  /**
   * @param {string} code 机器可读的错误码（客户端按它决定提示语）
   * @param {string} message 给人看的一句话
   * @param {number} [status] HTTP 状态码（仅 HTTP 层使用）
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PanelError';
    this.code = code;
    this.status = status;
  }
}

const clip = (text, limit = TEXT_LIMIT) => {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

/** 工单 → 面板行。字段全部显式，免得客户端猜。 */
function ticketRow(ticket, { runningAssignment = null, now = Date.now() } = {}) {
  return {
    id: ticket.id,
    title: String(ticket.title ?? ''),
    text: clip(ticket.text),
    state: ticket.state,
    dispatch: ticket.dispatch,
    source: ticket.mandate?.sourceId ?? null,
    actor: ticket.mandate?.actor ?? null,
    scope: ticket.mandate?.scope ?? null,
    policyVersion: ticket.mandate?.policyVersion ?? null,
    createdAt: Number(ticket.createdAt ?? 0),
    endedAt: ticket.endedAt === null || ticket.endedAt === undefined ? null : Number(ticket.endedAt),
    endedReason: ticket.endedReason ?? null,
    stoppedByPerson: ticket.stoppedByPerson === true,
    ageMs: Math.max(0, (ticket.endedAt ?? now) - Number(ticket.createdAt ?? now)),
    running: runningAssignment
      ? {
          executorId: runningAssignment.executorId ?? null,
          childId: runningAssignment.childId ?? null,
          startedAt: Number(runningAssignment.startedAt ?? 0),
        }
      : null,
  };
}

/**
 * 快照。**这是面板与宿主之间唯一的读契约**，改字段要同步改 client.js 与测试。
 *
 * @param {object} duty 已 load() 的 Duty 实例
 * @param {{ now?: () => number }} [options] 时间注入（测试用）
 */
export function panelSnapshot(duty, { now = () => Date.now() } = {}) {
  const at = now();
  const status = duty.status();
  const all = [...duty.state.tickets.values()];
  const open = all.filter((t) => t.state === 'open');
  const ended = all.filter((t) => t.state !== 'open');

  const openRows = open
    .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
    .map((ticket) =>
      ticketRow(ticket, {
        now: at,
        runningAssignment:
          duty.state.assignments.get(duty.state.runningByTicket.get(ticket.id)) ?? null,
      }),
    );

  const endedRows = ended
    .sort((a, b) => Number(b.endedAt ?? 0) - Number(a.endedAt ?? 0))
    .slice(0, Math.max(0, TICKET_LIMIT - openRows.length))
    .map((ticket) => ticketRow(ticket, { now: at }));

  return {
    at,
    mode: status.mode,
    policyVersion: status.policyVersion,
    workspace: status.workspace ?? null,
    inboxDir: status.inboxDir,
    counts: status.counts,
    limits: status.limits,
    allowed: status.allowed,
    github: status.github,
    needsPerson: status.needsPerson,
    tickets: [...openRows, ...endedRows],
    openCount: openRows.length,
    /** 最近 5 条策略变更通知（只记不撤，见 domain.policyChanged）。 */
    policyChanges: [...duty.state.policyChanges]
      .slice(-5)
      .reverse()
      .map((record) => ({
        at: Number(record.at ?? 0),
        ticketId: record.ticketId ?? null,
        from: record.from ?? null,
        to: record.to ?? null,
        stillAllowed: record.stillAllowed === true,
      })),
  };
}

/** 投递结果摘要（面板只需要「成没成 + 为什么」）。 */
function submitSummary(result) {
  const { route, ticket } = result;
  if (route.kind === 'evaluate') {
    return {
      kind: 'accepted',
      ticketId: ticket?.id ?? null,
      dispatch: ticket?.dispatch ?? null,
      message:
        ticket?.dispatch === 'ready'
          ? `已受理，可派工（${ticket.id}）`
          : `已受理，仅记录（${ticket?.id ?? '?'}）`,
    };
  }
  if (route.kind === 'duplicate') {
    return { kind: 'duplicate', ticketId: route.ticketId ?? null, message: `重复投递，已有工单 ${route.ticketId}` };
  }
  if (route.kind === 'fanout') {
    return {
      kind: 'fanout',
      ticketId: null,
      ticketIds: [...(route.ticketIds ?? [])],
      message: `作为上下文并入已有工单 ${(route.ticketIds ?? []).join(', ')}`,
    };
  }
  return { kind: 'denied', reason: route.reason ?? 'denied', message: `未受理：${route.reason ?? 'denied'}` };
}

/**
 * 面板动作。每个动作都是「重读磁盘 → 做事 → 回快照」，因此面板不需要自己推测状态。
 *
 * @param {{ openDuty: () => object, now?: () => number, poll?: (duty: object) => Promise<object> }} options
 *   `poll` 允许测试注入假 gh 调用（默认走 duty.pollGithub）。
 */
export function createPanelApi({ openDuty, now = () => Date.now(), poll = null }) {
  const snapshotOf = (duty) => panelSnapshot(duty, { now });

  return {
    /** 只读。 */
    state() {
      const duty = openDuty();
      return { ok: true, snapshot: snapshotOf(duty) };
    },

    /** 投递一件事。与人手丢进收件箱走同一套门禁，因此可能被拒。 */
    submit(payload = {}) {
      const text = String(payload.text ?? '').trim();
      if (text === '') throw new PanelError('empty-text', '正文不能为空');
      if (text.length > SUBMIT_TEXT_LIMIT) {
        throw new PanelError('text-too-long', `正文超过 ${SUBMIT_TEXT_LIMIT} 字`);
      }
      const duty = openDuty();
      const result = duty.submit({
        sourceId: 'inbox',
        kind: 'request',
        text,
        title: typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title.trim() : undefined,
        actor: typeof payload.actor === 'string' && payload.actor.trim() !== '' ? payload.actor.trim() : undefined,
      });
      return {
        ok: result.route.kind === 'evaluate' || result.route.kind === 'fanout',
        result: submitSummary(result),
        snapshot: snapshotOf(openDuty()),
      };
    },

    /** 立刻轮询一次 GitHub（只读）。 */
    async pollOnce(payload = {}) {
      const duty = openDuty();
      const mode = payload.mode === 'involves' ? 'involves' : payload.mode === 'mentions' ? 'mentions' : null;
      if (mode) duty.config.github = { ...duty.config.github, mode };
      const stats = await (poll ? poll(duty) : duty.pollGithub());
      return { ok: !stats?.error && !stats?.skipped, stats, snapshot: snapshotOf(openDuty()) };
    },

    /** 切换 observe / act。**不追认** observe 期已受理的工单（授权快照已冻结）。 */
    policy(payload = {}) {
      const mode = payload.mode;
      if (mode !== 'observe' && mode !== 'act') throw new PanelError('bad-mode', 'mode 只能是 observe 或 act');
      const duty = openDuty();
      const before = duty.status();
      if (before.mode === mode) {
        return { ok: true, changed: false, message: `已经是 ${mode}`, snapshot: snapshotOf(duty) };
      }
      const saved = duty.savePolicy({ ...duty.policy(), mode });
      return {
        ok: true,
        changed: true,
        message: `已切到 ${mode}（策略 ${saved.policy.version}）`,
        notices: saved.notices.length,
        snapshot: snapshotOf(openDuty()),
      };
    },

    /** 关单。面板只能结束工单，不能代替执行器「领取」。 */
    report(payload = {}) {
      const ticketId = String(payload.ticketId ?? '');
      if (ticketId === '') throw new PanelError('missing-ticket', '缺少 ticketId');
      const outcome = ['done', 'stopped', 'blocked', 'dropped'].includes(payload.outcome)
        ? payload.outcome
        : 'dropped';
      const duty = openDuty();
      const result = duty.report({
        ticketId,
        outcome,
        text: String(payload.text ?? `由面板标记为 ${outcome}`),
      });
      if (!result.ok) throw new PanelError(result.reason ?? 'not-open', `关单失败：${result.reason}`, 409);
      return { ok: true, message: `工单 ${ticketId} 已结束（${outcome}）`, snapshot: snapshotOf(openDuty()) };
    },
  };
}

/**
 * 动作名 → 方法名。**白名单**，不用动态属性查表：
 * 动态查表会把 `constructor` / `toString` 这类原型成员当成方法。
 */
const ACTIONS = Object.freeze({
  state: 'state',
  submit: 'submit',
  poll: 'pollOnce',
  policy: 'policy',
  report: 'report',
});

/**
 * 分派一次请求。未知动作一律 `unknown-action`，不做兜底猜测。
 *
 * @param {object} api createPanelApi 的返回值
 * @param {string} action 动作名
 * @param {object} payload 请求体
 */
export async function dispatchAction(api, action, payload = {}) {
  const method = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  const handler = method === undefined ? undefined : api[method];
  if (typeof handler !== 'function') throw new PanelError('unknown-action', `未知动作：${action}`, 404);
  return await handler.call(api, payload);
}
