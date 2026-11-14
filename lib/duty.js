/**
 * dsh-duty · 编排层（Engine）
 *
 * 把 domain / policy / store 串成一条可测的流水线。**不碰宿主、不碰网络**——
 * 所以它能被 node:test 直接跑，也能被插件入口直接调。
 *
 * 一次投递的完整路径：
 *   收件箱/工具 → makeTrigger → route → (evaluate) accept → 落库
 *                                    ↘ duplicate / fanout / denied 只落处置，不建单
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_TYPE,
  accept,
  isValidType,
  makeAssignment,
  makeTrigger,
  policyChanged,
  resolveDispatch,
  route,
  validateResume,
} from './domain.js';
import { describePolicy, normalizePolicy, validatePolicy } from './policy.js';
import { readSecret, verifyHmac } from './sources/auth.js';
import {
  buildSearchArgs,
  deriveCandidates,
  resolveLogin,
  runGh,
} from './sources/github.js';
import { parseEnvelope } from './sources/webhook-file.js';
import { appendRecords, loadState, summarize } from './store.js';

export class Duty {
  /**
   * @param {object} options
   * @param {string} options.stateFile  state.jsonl 的绝对路径
   * @param {string} options.configFile config.json 的绝对路径
   * @param {() => number} [options.now] 时间注入（测试用）
   */
  constructor({ stateFile, configFile, defaultInboxDir = null, now = () => Date.now(), env = null }) {
    this.stateFile = stateFile;
    this.configFile = configFile;
    this.defaultInboxDir = defaultInboxDir;
    this.now = now;
    this.config = null;
    this.state = null;
    this.lastPolicyVersion = null;
    /** 密钥只从环境变量读；注入点是为了让测试不污染真实 process.env。 */
    this.envOverride = env;
  }

  /** 每次现读 process.env：改了环境变量不用重建实例，也不会把密钥缓存到内存快照里。 */
  env() {
    return this.envOverride ?? process.env;
  }

  // ── 配置 ────────────────────────────────────────────────

  load() {
    this.config = readConfig(this.configFile, this.defaultInboxDir);
    this.state = loadState(this.stateFile);
    this.lastPolicyVersion = this.state.policyChanges.at(-1)?.to ?? null;
    return this;
  }

  /**
   * 收件箱目录必须始终是绝对路径。
   * 坏配置 / 缺字段时回落到调用方给的默认值 —— 绝不能让 mkdir('') 把整个插件打死。
   */
  ensureDirs() {
    if (typeof this.config.inboxDir !== 'string' || this.config.inboxDir.trim() === '') {
      this.config.inboxDir = this.defaultInboxDir ?? join(process.cwd(), '.duty-inbox');
    }
    mkdirSync(this.config.inboxDir, { recursive: true });
    mkdirSync(join(this.config.inboxDir, 'processed'), { recursive: true });
  }

  /** 策略是 config.json 里的 policy 段；返回归一化后的对象。 */
  policy() {
    return normalizePolicy(this.config?.policy);
  }

  saveConfig(patch) {
    this.config = { ...this.config, ...patch };
    writeFileSync(this.configFile, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
    return this.config;
  }

  /**
   * 保存策略并处理「策略变更」：**只记通知，不撤销任何在跑工单**。
   * 这是五条设计里第 2 条的实现点。
   */
  savePolicy(nextPolicyRaw) {
    // 写入严格：`dispatch:'act'` / 未知值 / 拼错的名字，必须当场报错（不静默降级）。
    const invalid = validatePolicy(nextPolicyRaw);
    if (!invalid.ok) return { ok: false, errors: invalid.errors };

    const before = this.policy();
    const after = normalizePolicy(nextPolicyRaw);
    const notices = policyChanged({
      tickets: [...this.state.tickets.values()],
      nextPolicy: after,
      previousPolicyVersion: describePolicy(before).version,
    });

    this.config = { ...this.config, policy: stripVolatile(after) };
    writeFileSync(this.configFile, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');

    if (notices.length > 0) {
      appendRecords(
        this.stateFile,
        notices.map((n) => ({
          t: 'policy-change',
          at: this.now(),
          ticketId: n.ticketId,
          from: n.from,
          to: n.to,
          stillAllowed: n.stillAllowed,
        })),
      );
      this.state = loadState(this.stateFile);
    }
    return { policy: describePolicy(after), notices };
  }

  // ── 投递 ────────────────────────────────────────────────

  /**
   * 一条请求进来。返回 { trigger, route, ticket? }。
   * 幂等：同一 nativeId 重复投递 → route.kind === 'duplicate'，不会多出工单。
   */
  submit({
    sourceId = 'inbox',
    kind = 'request',
    nativeId,
    text,
    actor,
    threadId = null,
    title,
    type,
    link,
    correlationId,
  } = {}) {
    const at = this.now();

    /**
     * 非法类型**必须拒收**（L1 断言表）：不得降级成 task.manual ——
     * 否则 `deploy.prod ` 这种多了个空格的写法会静默变成可自动派发的普通任务，
     * 恰恰是「高危类型必须人批」最需要挡住的那条路。
     */
    const requestedType = type === undefined || type === null || type === '' ? DEFAULT_TYPE : String(type);
    if (!isValidType(requestedType)) {
      return {
        trigger: null,
        route: { kind: 'denied', reason: 'bad-type', triggerId: null },
        refused: 'bad-type',
        type: requestedType,
      };
    }

    const trigger = makeTrigger({
      sourceId,
      kind,
      nativeId: nativeId ?? `${at}-${Math.random().toString(36).slice(2, 10)}`,
      actor: actor ?? this.config.defaultActor ?? 'operator',
      text: text ?? '',
      title,
      type: requestedType,
      link,
      correlationId,
      threadId,
      at,
    });

    const policy = this.policy();
    const decision = route({ trigger, policy, state: this.state, now: at });

    if (decision.kind === 'evaluate') {
      const dispatch = resolveDispatch({ policy, type: trigger.type, mode: policy.mode });
      const ticket = accept({ trigger, policy, mode: policy.mode, dispatch, now: at });
      appendRecords(this.stateFile, [
        { t: 'trigger', at, trigger },
        { t: 'disposition', at, triggerId: trigger.id, kind: 'accept', ticketId: ticket.id },
        { t: 'ticket', at, ticket },
      ]);
      this.state = loadState(this.stateFile);
      return { trigger, route: decision, ticket };
    }

    appendRecords(this.stateFile, [
      { t: 'trigger', at, trigger },
      { t: 'disposition', at, triggerId: trigger.id, kind: decision.kind, reason: decision.reason ?? null },
    ]);
    this.state = loadState(this.stateFile);
    return { trigger, route: decision };
  }

  /**
   * 扫描收件箱：目录里每个 *.md 就是一封投递，处理完移到 processed/。
   * 文件名就是 nativeId —— 同名再投即为重复，天然幂等。
   */
  scanInbox() {
    this.ensureDirs();
    const results = [];
    const entries = readdirSync(this.config.inboxDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort();

    for (const name of entries) {
      const file = join(this.config.inboxDir, name);
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { actor, body } = parseFrontMatter(text);
      const result = this.submit({
        sourceId: 'inbox',
        kind: 'request',
        nativeId: name,
        text: body,
        actor: actor ?? this.config.defaultActor ?? 'operator',
      });
      try {
        renameSync(file, join(this.config.inboxDir, 'processed', name));
      } catch {
        // 移不动就留在原地：下次扫描会因为 nativeId 相同被判重复，不会重复建单。
      }
      results.push({ file: name, ...result });
    }
    return results;
  }

  // ── 签名投递源（文件形式） ──────────────────────────────

  /**
   * 扫描签名投递目录：每个 *.json 是一封签名信封，校验通过才变成事件。
   *
   * **fail-closed**：缺密钥 / 空密钥 / 签名不对 / 时间窗越界，一律拒收 ——
   * 绝不回落到 `auth: none`（那等于把「有签名要求」的源降级成「谁都能投」）。
   * 无论成败都把文件移入 processed/，避免同一份坏信封每轮重扫、刷日志。
   */
  scanWebhook() {
    const dir = this.config.webhookDir;
    if (typeof dir !== 'string' || dir.trim() === '') return [];
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'processed'), { recursive: true });

    const policy = this.policy();
    const source = policy.sources?.webhook;
    const results = [];
    if (!source || source.enabled === false) return results;

    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
      .map((e) => e.name)
      .sort();

    for (const name of entries) {
      const file = join(dir, name);
      let raw;
      try {
        raw = readFileSync(file);
      } catch {
        continue;
      }
      const archive = () => {
        try {
          renameSync(file, join(dir, 'processed', name));
        } catch {
          // 移不动就留在原地：下一轮签名仍然不过，不会产生错误工单。
        }
      };

      const parsed = parseEnvelope(raw);
      if (!parsed.ok) {
        results.push({ file: name, refused: parsed.reason });
        archive();
        continue;
      }

      const secret = readSecret({ auth: source.auth, env: this.env() });
      if (!secret.ok) {
        results.push({ file: name, refused: secret.reason, secretEnv: secret.secretEnv });
        archive();
        continue;
      }

      const verdict = verifyHmac({
        rawBody: parsed.envelope.rawBody,
        signature: parsed.envelope.signature,
        timestamp: parsed.envelope.timestamp,
        secret: secret.secret,
        toleranceSeconds: source.auth?.toleranceSeconds ?? 300,
        now: this.now(),
      });
      if (!verdict.ok) {
        results.push({ file: name, refused: verdict.reason });
        archive();
        continue;
      }

      const payload = parsed.envelope.payload;
      const result = this.submit({
        sourceId: 'webhook',
        kind: 'request',
        nativeId: payload.nativeId ?? name,
        text: payload.text,
        title: payload.title,
        actor: payload.actor ?? this.config.defaultActor ?? 'operator',
        type: payload.type,
        link: payload.link,
        correlationId: payload.correlationId,
      });
      archive();
      results.push({ file: name, ...result });
    }
    return results;
  }

  // ── GitHub 只读源 ───────────────────────────────────────

  /**
   * 轮询一次 GitHub（只读）。**永不抛**：失败返回可判读的结果，由调用方记日志。
   *
   * 三条短路，都是为了不浪费配额也不产生噪音：
   *   - 源关了 / 允许名单为空 ⇒ 不查
   *   - 拿不到登录名 ⇒ 本轮跳过（下轮再试）
   *   - 一次最多开 `maxNewPerPoll` 张新单，剩下的下一轮再来（不建队列，靠幂等自然排队）
   */
  async pollGithub({ run = runGh, now = this.now } = {}) {
    const policy = this.policy();
    const source = policy.sources?.github;
    if (!source || source.enabled === false) return { skipped: 'source-off' };
    if ((source.allowed ?? []).length === 0) return { skipped: 'no-allowed' };

    const cfg = this.config.github ?? {};
    const login = this.githubLogin ?? (await resolveLogin({ run }));
    if (!login) return { skipped: 'no-login' };
    this.githubLogin = login;

    const args = buildSearchArgs({
      mode: cfg.mode,
      me: login,
      limit: cfg.limit,
      search: cfg.search,
    });
    const result = await run(args);
    if (result.code !== 0) {
      return { error: (result.stderr || 'gh failed').trim().slice(0, 400) };
    }

    let items;
    try {
      items = JSON.parse(result.stdout);
    } catch {
      return { error: 'gh 返回的不是 JSON' };
    }

    const candidates = deriveCandidates(items, { repos: cfg.repos });
    const stats = {
      asked: login,
      mode: cfg.mode ?? 'mentions',
      found: candidates.length,
      accepted: 0,
      fanout: 0,
      duplicate: 0,
      denied: 0,
      deferred: 0,
    };
    const maxNew = Math.max(0, Number(cfg.maxNewPerPoll ?? 3));

    for (const candidate of candidates) {
      const live = this.state.liveTicketsByThread.get(candidate.threadId) ?? [];
      // 已有在跑工单 ⇒ 这次更新只作为上下文扇出；否则才是新单。
      const kind = live.length > 0 ? 'message' : 'request';

      if (kind === 'request' && stats.accepted >= maxNew) {
        // 不提交：没有 trigger 记录，下一轮会自然重来。
        stats.deferred += 1;
        continue;
      }

      const outcome = this.submit({
        sourceId: 'github',
        kind,
        nativeId: candidate.nativeId,
        actor: candidate.actor,
        text: candidate.text,
        title: candidate.title,
        threadId: candidate.threadId,
      });

      if (outcome.route.kind === 'evaluate') stats.accepted += 1;
      else if (outcome.route.kind === 'fanout') stats.fanout += 1;
      else if (outcome.route.kind === 'denied') stats.denied += 1;
      else stats.duplicate += 1;
    }

    return stats;
  }

  // ── 领取与回报 ──────────────────────────────────────────

  /**
   * 领取一张可派工的工单（最老的先出）。observe 模式的工单永远领不到。
   *
   * 领不到时必须说清原因（null 只表示「真的一张都没开」）：
   * 调用方是模型，`{refused}` 比 `null` 有用得多。
   */
  claim(ticketId = null) {
    const open = [...this.state.tickets.values()].filter((t) => t.state === 'open');

    if (ticketId) {
      const picked = open.find((t) => t.id === ticketId);
      return picked ? this.checkClaim(picked) : { refused: 'unknown-or-closed-ticket', ticketId };
    }

    // 已经被某个执行器接走的单不再分配：否则同一张单会被跑两遍。
    const ready = open
      .filter((t) => t.dispatch === 'ready' && !this.state.runningByTicket.has(t.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (ready.length === 0) {
      const busy = open.filter((t) => this.state.runningByTicket.has(t.id));
      if (busy.length > 0 && busy.length === open.length) {
        return { refused: 'all-running', ticket: busy[0], hint: '这些工单已经有执行器在跑' };
      }
      // held 比 observed 更需要人说一句：它不是「等模式切过来」，而是「等人工处置」。
      const held = open.filter((t) => t.dispatch === 'held');
      if (held.length > 0) {
        return {
          refused: 'held-needs-person',
          ticket: held[0],
          hint: `工单类型 ${held[0].type ?? '(未知)'} 被策略要求人工处置；本轮不提供放行入口，改策略也不会自动释放`,
        };
      }
      const observed = open.filter((t) => t.dispatch === 'observed');
      if (observed.length > 0) {
        // 两种「领不到」要分开说：模式没开 vs 这些是 observe 期受理的、快照已冻结。
        const act = this.policy().mode === 'act';
        return {
          refused: act ? 'observed-only' : 'observe-mode',
          ticket: observed[0],
          hint: act
            ? '这些工单是在 observe 期间受理的，dispatch 已随授权快照冻结；切到 act 之后新投递的才会派工'
            : '把 policy.mode 改成 act 才能派工',
        };
      }
      return null;
    }
    return this.checkClaim(ready[0]);
  }

  checkClaim(ticket) {
    if (ticket.dispatch === 'held') {
      return {
        refused: 'held-needs-person',
        ticket,
        hint: `工单类型 ${ticket.type ?? '(未知)'} 被策略要求人工处置`,
      };
    }
    if (ticket.dispatch !== 'ready') {
      return { refused: 'observe-mode', ticket, hint: '把 policy.mode 改成 act 才能派工' };
    }
    if (this.state.runningByTicket.has(ticket.id)) {
      return {
        refused: 'already-running',
        ticket,
        hint: `已由执行器 ${this.state.assignments.get(this.state.runningByTicket.get(ticket.id))?.executorId ?? '?'} 接走`,
      };
    }
    const check = validateResume({ ticket, policy: this.policy() });
    if (!check.ok) return { refused: check.reason, ticket };
    return ticket;
  }

  /**
   * 把工单绑定到一个执行器实例（先占位，再真正拉起子 Session）。
   *
   * 顺序是「先 assign 再 dispatch」：万一 spawn 失败再 release。
   * 反过来的话，两步之间有一个窗口会让同一张单手滑派两次。
   */
  assign(ticketId, { executorId, at = this.now() } = {}) {
    const ticket = this.state.tickets.get(ticketId);
    if (!ticket || ticket.state !== 'open') return { ok: false, reason: 'not-open' };
    if (ticket.dispatch !== 'ready') return { ok: false, reason: 'observe-mode' };
    if (this.state.runningByTicket.has(ticketId)) {
      return { ok: false, reason: 'already-running' };
    }
    const assignment = makeAssignment({ ticketId, executorId, at });
    appendRecords(this.stateFile, [{ t: 'assignment', at, assignment }]);
    this.state = loadState(this.stateFile);
    return { ok: true, assignment };
  }

  /** 派工失败时把占位释放掉，让工单可以重派。 */
  releaseAssignment(ticketId, { reason = 'released', at = this.now() } = {}) {
    if (!this.state.runningByTicket.has(ticketId)) return { ok: false, reason: 'no-running-assignment' };
    appendRecords(this.stateFile, [{ t: 'assignment-ended', at, ticketId, reason }]);
    this.state = loadState(this.stateFile);
    return { ok: true };
  }

  /** 拉起成功后补记执行器的 agent id（用于识别「调用方是执行器」，防递归派工）。 */
  recordChild(ticketId, childId, { at = this.now() } = {}) {
    if (!ticketId || !childId) return { ok: false, reason: 'missing' };
    appendRecords(this.stateFile, [{ t: 'assignment-child', at, ticketId, childId }]);
    this.state = loadState(this.stateFile);
    return { ok: true };
  }

  /**
   * 调用方是不是一个正在跑的执行器。
   *
   * 为什么需要：agent preset **只加工具、不减全局工具**，所以执行器 Session 里同样看得见
   * duty_work / duty_submit。不拦的话，一个工单可以再开一个工单，无限套娃（2026-11-07 实测到
   * 执行器调用了 duty_status）。
   */
  isWorkerAgent(agentId) {
    if (!agentId) return false;
    for (const assignment of this.state.assignments.values()) {
      if (assignment.state === 'running' && assignment.childId === agentId) return true;
    }
    return false;
  }

  /** 由执行器的 agent id 反查它正在跑的工单（用于执行器结束时自动关单）。 */
  ticketOfChild(agentId) {
    if (!agentId) return null;
    for (const assignment of this.state.assignments.values()) {
      if (assignment.state === 'running' && assignment.childId === agentId) return assignment.ticketId;
    }
    return null;
  }

  /** 回报结果并关单。 */
  report({ ticketId, text = '', outcome = 'done' } = {}) {
    const ticket = this.state.tickets.get(ticketId);
    if (!ticket) return { ok: false, reason: 'unknown-ticket' };
    if (ticket.state !== 'open') return { ok: false, reason: 'not-open' };
    const at = this.now();
    appendRecords(this.stateFile, [
      { t: 'report', at, ticketId, outcome, text: String(text).slice(0, 20000) },
      { t: 'assignment-ended', at, ticketId, reason: outcome },
      { t: 'ticket-ended', at, ticketId, reason: outcome === 'stopped' ? 'stopped-by-person' : outcome },
    ]);
    this.state = loadState(this.stateFile);
    return { ok: true, ticket: this.state.tickets.get(ticketId) };
  }

  // ── 状态 ────────────────────────────────────────────────

  status() {
    const policy = describePolicy(this.policy());
    const github = this.config.github ?? {};
    const githubAllowed = (policy.sources.find((s) => s.id === 'github')?.allowed ?? []);
    return {
      mode: policy.mode,
      policyVersion: policy.version,
      workspace: policy.workspace,
      inboxDir: this.config.inboxDir,
      github: {
        enabled: policy.sources.find((s) => s.id === 'github')?.enabled ?? false,
        mode: github.mode,
        repos: github.repos ?? [],
        maxNewPerPoll: github.maxNewPerPoll,
        intervalSeconds: github.intervalSeconds,
        allowed: githubAllowed,
        /** 名单为空时不轮询，也不会有任何 GitHub 工单。 */
        ready: githubAllowed.length > 0,
      },
      allowed: policy.sources,
      limits: policy.limits,
      /** S2：按类型的姿态配置 + 内置高危类型，从 status 一眼看清谁被 hold 住。 */
      types: policy.types,
      holdTypes: policy.holdTypes,
      webhookDir: this.config.webhookDir ?? null,
      counts: summarize(this.state),
      /** 需要人做的事，排在最前；健康的空数组就是「没事」。 */
      needsPerson: [...this.state.tickets.values()]
        .filter((t) => t.state === 'open' && (t.dispatch === 'observed' || t.dispatch === 'held'))
        .map((t) => ({
          id: t.id,
          title: t.title,
          since: t.createdAt,
          dispatch: t.dispatch,
          type: t.type ?? null,
        })),
    };
  }
}

// ── 工具 ──────────────────────────────────────────────────

export function readConfig(file, defaultInboxDir = null) {
  const defaults = {
    inboxDir: defaultInboxDir ?? '',
    /** S2：签名投递目录。为空 = 该源不扫描。 */
    webhookDir: '',
    defaultActor: 'operator',
    tickSeconds: 60,
    github: {
      mode: 'mentions',
      repos: [],
      limit: 20,
      search: '',
      maxNewPerPoll: 3,
      intervalSeconds: 180,
    },
    policy: normalizePolicy(null),
  };
  if (!existsSync(file)) {
    return { ...defaults, policy: stripVolatile(defaults.policy) };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ...defaults,
      ...parsed,
      inboxDir:
        typeof parsed?.inboxDir === 'string' && parsed.inboxDir.trim() !== ''
          ? parsed.inboxDir
          : defaults.inboxDir,
      github: { ...defaults.github, ...(parsed?.github ?? {}) },
      policy: stripVolatile(normalizePolicy(parsed?.policy)),
    };
  } catch {
    // 坏配置不打死插件：回落默认，用户改回来即可。
    return { ...defaults, policy: stripVolatile(defaults.policy) };
  }
}

/** 落盘的策略只保留规则本身，不写派生字段（版本是算出来的，不是存出来的）。 */
function stripVolatile(policy) {
  return {
    mode: policy.mode,
    sources: policy.sources,
    limits: policy.limits,
    types: policy.types ?? {},
    workspace: policy.workspace ?? null,
  };
}

/**
 * 可选的前置元信息：文件头几行里的 `actor: <id>` 指定投递人。
 *
 * 元信息行必须从正文里**剥掉**（2026-11-07 端到端实测踩到：不剥的话
 * 工单标题会变成 "actor: operator"，正文也带着这一行）。
 */
export function parseFrontMatter(text) {
  const lines = String(text ?? '').split('\n');
  let actor;
  let index = 0;
  for (; index < Math.min(lines.length, 6); index += 1) {
    const line = lines[index];
    const match = /^\s*actor\s*:\s*(\S+)\s*$/.exec(line);
    if (match) {
      actor = match[1];
      continue; // 元信息行：消费掉，不进正文
    }
    if (line.trim() === '' || /^\s*---\s*$/.test(line)) continue; // 分隔行：跳过
    break; // 正文从这里开始
  }
  return { actor, body: lines.slice(index).join('\n').trim() };
}
