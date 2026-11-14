/**
 * dsh-duty —— DSH 桌面端插件：值班 Agent
 *
 * 设计来源：deepseek-ai/dsh-superagent-prototype 的五条取舍，按桌面端现实做了降级替换
 * （见 README「五条设计怎么落」）。核心保留的是可被断言的那部分：
 *   授权与上下文分离 / 授权是快照 / 幂等靠 Trigger / 注意力预算（observe 默认）
 *
 * 依赖纪律（与 dsh-daily-report 同一条，实测结论，别改）：
 *   本插件**只 import node: 内置模块 + 自己的相对文件**，不 import 任何 @deepseek-ai/*。
 *   link: 安装时 Node 按 realpath 解析，从插件目录一路向上找不到 profile 的 node_modules，
 *   所以官方的 defineTool / schemastery 都要绕开，工具参数必须写成**编译后的**标准 JSON Schema。
 *
 * 触发方式：
 *   1. 定时：每 tickSeconds 扫一次收件箱 <inboxDir>/*.md（错过会在下次启动补扫）
 *   2. 手动：模型调用 duty_submit 工具，或把 .md 丢进收件箱
 *
 * @module dsh-duty
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Duty } from './lib/duty.js';
import { WORKER_PROVIDER, buildActivationRequest } from './lib/executor.js';
import { createPanelApi } from './lib/panel-api.js';
import { makePanelRoutes } from './lib/panel-routes.js';

export const name = 'dsh-duty';

/**
 * `timer` 是硬依赖：ctx.interval 由 cordis-plugin-timer 混入，
 * 没有 inject 时连 `typeof ctx.interval === 'function'` 都会抛（daily-report 实测过）。
 */
export const inject = ['tools', 'timer'];

/** 状态根目录。DSH_DUTY_HOME 只给测试和「一套配置跑多个实例」用，正常不设。 */
const STATE_DIR = process.env.DSH_DUTY_HOME
  ? resolve(process.env.DSH_DUTY_HOME)
  : join(homedir(), '.dsh', 'duty');
const CONFIG_FILE = join(STATE_DIR, 'config.json');
const STATE_FILE = join(STATE_DIR, 'state.jsonl');
const LOG_FILE = join(STATE_DIR, 'duty.log');
const INBOX_DIR = join(STATE_DIR, 'inbox');

// ── 日志 ──────────────────────────────────────────────────

function log(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a', encoding: 'utf8' });
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

// ── 配置与实例 ────────────────────────────────────────────

function ensureConfig() {
  if (existsSync(CONFIG_FILE)) return;
  const initial = {
    _help: 'mode=observe 时只记录不派工；sources.inbox.allowed 为空表示谁也调用不动。',
    inboxDir: INBOX_DIR,
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
    policy: {
      mode: 'observe',
      sources: {
        inbox: { enabled: true, allowed: [{ id: 'operator' }] },
        github: { enabled: true, allowed: [] },
      },
      limits: { cooldownSeconds: 300, maxAcceptsPerActorPerHour: 6 },
      workspace: null,
    },
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  mkdirSync(initial.inboxDir, { recursive: true });
  log(`config created at ${CONFIG_FILE}`);
}

let dutyRef = null;
function duty() {
  return dutyRef;
}

// ── 面板 HTTP 层 ──────────────────────────────────────────
//
// 路由由宿主的 webServer 服务承载：Web 组合下就是 GUI 自己的 origin；桌面端把
// app:// 页面里的非静态路径转发给宿主，因此两端用同一套相对路径即可（客户端
// 用 document.baseURI 解析，见 client.js 的 apiUrl）。
//
// 路由本体在 lib/panel-routes.js（可脱离宿主单测），这里只负责「接上宿主」。

/**
 * 同源门禁。
 *
 * 优先交给宿主的 connection 服务（它同时掌握部署信任与浏览器鉴权，别自己另立一套）；
 * 没有该服务时退回一个保守判断：带 Origin 的请求必须是同源，或来自桌面壳的 app:/file:。
 */
function makeFence(ctx) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  if (connection && typeof connection.requestRejection === 'function') {
    return (req) => {
      try {
        return connection.requestRejection(req) === undefined;
      } catch {
        return false;
      }
    };
  }
  return (req) => {
    const origin = req.headers?.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === 'app:' || parsed.protocol === 'file:') return true;
      return parsed.host === req.headers?.host;
    } catch {
      return false;
    }
  };
}

// ── 工具实现 ──────────────────────────────────────────────

function formatStatus(s) {
  const lines = [
    `模式：${s.mode}${s.mode === 'observe' ? '（只记录，不派工）' : '（可派工）'}`,
    `策略版本：${s.policyVersion}`,
    `收件箱：${s.inboxDir}`,
    `工单：共 ${s.counts.tickets}，开放 ${s.counts.open}（可派 ${s.counts.ready} / 在跑 ${s.counts.running} / 仅记录 ${s.counts.observed} / 等人批 ${s.counts.held ?? 0}），已结 ${s.counts.ended}`,
    `触发：${s.counts.triggers}；策略变更通知：${s.counts.policyChanges}`,
  ];
  const allowed = s.allowed.filter((a) => a.enabled).flatMap((a) => a.allowed);
  lines.push(`允许名单：${allowed.length === 0 ? '（空）谁也调用不动' : allowed.join(', ')}`);

  const typeRules = Object.entries(s.types ?? {}).map(([type, spec]) => `${type}=${spec.dispatch}`);
  const holdTypes = (s.holdTypes ?? []).join(', ');
  lines.push(
    `按类型：${typeRules.length === 0 ? '（无显式配置）' : typeRules.join(', ')}`,
    `内置高危（默认 hold，通配解不开）：${holdTypes}`,
  );
  const webhook = s.allowed.find((a) => a.id === 'webhook');
  if (webhook) {
    lines.push(
      `签名投递源：${webhook.enabled ? '开' : '关'}，鉴权 ${webhook.auth ?? 'none'}` +
        `（目录 ${s.webhookDir ?? '未配置'}）`,
    );
  }

  const gh = s.github;
  if (gh) {
    const who = gh.allowed.length === 0 ? '名单为空 ⇒ 不轮询、不收单' : gh.allowed.join(', ');
    lines.push(
      `GitHub 源：${gh.enabled ? '开' : '关'}，方式 ${gh.mode}，允许 ${who}` +
        `（仓库 ${gh.repos?.length ? gh.repos.join(', ') : '不限'}；每 ${gh.intervalSeconds}s；每轮最多开 ${gh.maxNewPerPoll} 单）`,
    );
  }
  if (s.needsPerson.length > 0) {
    lines.push('', `需要人处理 ${s.needsPerson.length} 件（observe 记录 / 类型被 hold）：`);
    for (const item of s.needsPerson.slice(0, 20)) {
      const tag = item.dispatch === 'held' ? `[${item.type ?? '?'}·待人批]` : '[仅记录]';
      lines.push(`  - ${item.id}  ${tag} ${item.title}`);
    }
  }
  return lines.join('\n');
}

function describeTicket(t) {
  if (!t) return '（没有工单）';
  return [
    `工单 ${t.id}`,
    `标题：${t.title}`,
    `类型：${t.type ?? 'task.manual'}` + (t.link ? `　回链：${t.link}` : ''),
    `状态：${t.state} / ${t.dispatch}`,
    `授权快照：policy=${t.mandate.policyVersion} actor=${t.mandate.actor} strength=${t.mandate.strength} scope=${t.mandate.scope}`,
    `允许工具面：${t.toolScope.join(', ')}`,
    `来源触发：${t.originTriggerId}`,
  ].join('\n');
}

/**
 * 工具返回值形状。
 *
 * 必须显式声明：宿主 `tools.register()` 会调 `assertSupportedJsonSchema(definition.output.schema)`，
 * 不给 schema 直接抛 `unsupported JSON schema: schema must be a schema object`（2026-11-07 实测）。
 * 五个工具统一返回 { ok, summary, text }，`additionalProperties: false` 逼自己别偷偷加字段。
 */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['ok', 'summary', 'text'],
  additionalProperties: false,
});

function buildTools(ctx, dutyRefObj) {
  /** 统一包一层：任何异常都变成可读的文本，不让工具把宿主带崩。 */
  const safe = (label, fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      log(`${label} failed: ${error?.message ?? error}`);
      return { ok: false, summary: `${label} 失败：${error?.message ?? error}`, text: String(error?.stack ?? error) };
    }
  };

  /**
   * 执行器不能被用来再派工/再投递。
   *
   * agent preset 只加工具、不减全局工具，所以执行器 Session 里同样看得见这些工具；
   * 不拦就会「工单开工单」无限套娃。这是运行时兜底，不是靠提示词求它别用。
   */
  const callerRefusal = (exec, toolName) => {
    const agentId = exec?.agent?.id ?? exec?.agent?.session?.id ?? null;
    if (agentId && dutyRefObj.current.isWorkerAgent(agentId)) {
      return {
        ok: false,
        summary: `${toolName} 不允许由执行器调用`,
        text:
          `当前会话是一个正在跑的执行器（${agentId}），不能调用 ${toolName} —— ` +
          '否则一个工单会再开一个工单。请只在自己的工单范围内工作，完成后在结果里说明。',
      };
    }
    return null;
  };

  return [
    {
      name: 'duty_status',
      description:
        '查看值班状态：模式（observe/act）、策略版本、允许名单、工单计数，以及「需要人处理」的清单。健康状态不会占篇幅。',
      parameters: { type: 'object', additionalProperties: false, properties: {} , required: [] },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }] },
      execute: safe('duty_status', async () => {
        const status = dutyRefObj.current.status();
        return { ok: true, summary: `值班：${status.mode}，开放 ${status.counts.open} 单`, text: formatStatus(status) };
      }),
    },
    {
      name: 'duty_submit',
      description:
        '把一件事交给值班 Agent。同一 nativeId 重复提交只会有一张工单（幂等）。默认走 inbox 来源，需要该投递人在允许名单里。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要做什么，自然语言。' },
          title: { type: 'string', description: '工单标题，默认取正文第一行。' },
          actor: { type: 'string', description: '投递人标识，默认取 config.defaultActor。' },
          nativeId: { type: 'string', description: '源侧唯一 id（如文件名）。不填则每次都是新事件。' },
          type: {
            type: 'string',
            description:
              '业务类型（a.b 形式，允许多级），如 code.change / deploy.prod / ops.alert。默认 task.manual。非法值会被拒收。高危类型默认需人批。',
          },
          link: { type: 'string', description: '回到原处的链接（只接受 http/https，≤2048 字符）。' },
          correlationId: {
            type: 'string',
            description: '跨源关联键：同一件事从多个来源来时用同一个值，第二来源只作为上下文并入，不新建工单。',
          },
        },
        required: ['text'],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }] },
      execute: safe('duty_submit', async (args, exec) => {
        const refusal = callerRefusal(exec, 'duty_submit');
        if (refusal) return refusal;
        const result = dutyRefObj.current.submit({
          nativeId: typeof args.nativeId === 'string' && args.nativeId !== '' ? args.nativeId : undefined,
          text: String(args.text ?? ''),
          title: typeof args.title === 'string' ? args.title : undefined,
          actor: typeof args.actor === 'string' && args.actor !== '' ? args.actor : undefined,
          type: typeof args.type === 'string' && args.type !== '' ? args.type : undefined,
          link: typeof args.link === 'string' && args.link !== '' ? args.link : undefined,
          correlationId:
            typeof args.correlationId === 'string' && args.correlationId !== '' ? args.correlationId : undefined,
        });
        const { route, ticket } = result;
        if (route.kind === 'denied' && route.reason === 'bad-type') {
          return {
            ok: false,
            summary: `类型非法：${result.type}`,
            text: `未受理：类型 ${JSON.stringify(result.type)} 不合法（需 a.b 形式，如 code.change）。**不会**降级成 task.manual —— 换个合法类型重投。`,
          };
        }
        const head =
          route.kind === 'evaluate'
            ? `已受理，${ticket.dispatch === 'ready' ? '可派工' : ticket.dispatch === 'held' ? '等人工处置（类型被 hold，改策略不会自动释放）' : '仅记录（observe）'}。`
            : route.kind === 'duplicate'
              ? `重复投递，已有工单 ${route.ticketId}，未新建。`
              : route.kind === 'fanout'
                ? `作为上下文并入已有工单 ${route.ticketIds.join(', ')}，未新建（投递人不在名单也不影响它作为上下文）。`
                : `未受理：${route.reason}`;
        const body = ticket ? `\n\n${describeTicket(ticket)}` : '';
        return { ok: route.kind === 'evaluate', summary: head, text: `${head}${body}` };
      }),
    },
    {
      name: 'duty_claim',
      description: '领取一张可派工的工单（最老优先）。observe 模式或授权已失效时会说明原因，不会静默返回空。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticketId: { type: 'string', description: '指定工单 id；不填则取最早一张 ready 的。' },
        },
        required: [],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }] },
      execute: safe('duty_claim', async (args) => {
        const claimed = dutyRefObj.current.claim(
          typeof args.ticketId === 'string' && args.ticketId !== '' ? args.ticketId : null,
        );
        if (claimed === null) return { ok: false, summary: '没有开放的工单', text: '没有开放的工单。' };
        if (claimed.refused) {
          return {
            ok: false,
            summary: `领不到：${claimed.refused}`,
            text: `领不到：${claimed.refused}${claimed.hint ? `（${claimed.hint}）` : ''}\n\n${describeTicket(claimed.ticket)}`,
          };
        }
        return { ok: true, summary: `已领取 ${claimed.id}`, text: describeTicket(claimed) };
      }),
    },
    {
      name: 'duty_report',
      description: '回报工单结果并关单。outcome=done 表示完成，stopped 表示人显式叫停（此后不会自动恢复）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticketId: { type: 'string', description: '工单 id。' },
          text: { type: 'string', description: '做了什么、结果如何。' },
          outcome: { type: 'string', enum: ['done', 'stopped', 'blocked', 'dropped'], description: '默认 done。' },
        },
        required: ['ticketId'],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }] },
      execute: safe('duty_report', async (args) => {
        const result = dutyRefObj.current.report({
          ticketId: String(args.ticketId ?? ''),
          text: String(args.text ?? ''),
          outcome: typeof args.outcome === 'string' ? args.outcome : 'done',
        });
        if (!result.ok) return { ok: false, summary: `回报失败：${result.reason}`, text: `回报失败：${result.reason}` };
        return { ok: true, summary: `工单 ${result.ticket.id} 已结束`, text: describeTicket(result.ticket) };
      }),
    },
    {
      name: 'duty_policy',
      description:
        '读取或修改值班策略。修改只影响之后的受理；已在跑的工单授权快照不变，只会收到一条变更通知。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['observe', 'act'], description: 'observe=只记录；act=可派工。' },
          sourceId: {
            type: 'string',
            enum: ['inbox', 'github', 'webhook'],
            description: 'allowed 作用在哪个来源上，默认 inbox。',
          },
          allowed: { type: 'array', items: { type: 'string' }, description: '替换该来源的允许名单。' },
          cooldownSeconds: { type: 'integer', description: '同一线程的冷静期。' },
          maxAcceptsPerActorPerHour: { type: 'integer', description: '每人每小时受理上限。' },
          types: {
            type: 'object',
            description:
              '按类型的派工姿态，如 {"deploy.prod":{"dispatch":"observe"},"*":{"dispatch":"inherit"}}。' +
              'dispatch 只允许 inherit / observe / hold（没有 act）；显式传 {} 清空。' +
              '注意：内置高危类型默认 hold，通配 "*" 解不开，只能精确覆盖。',
          },
        },
        required: [],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }] },
      execute: safe('duty_policy', async (args, exec) => {
        const refusal = callerRefusal(exec, 'duty_policy');
        if (refusal) return refusal;
        const current = dutyRefObj.current.policy();
        const changing =
          args.mode !== undefined ||
          args.allowed !== undefined ||
          args.cooldownSeconds !== undefined ||
          args.maxAcceptsPerActorPerHour !== undefined ||
          args.types !== undefined;

        if (!changing) {
          return { ok: true, summary: '当前策略', text: formatStatus(dutyRefObj.current.status()) };
        }

        const targetSource = args.sourceId === 'github' ? 'github' : args.sourceId === 'webhook' ? 'webhook' : 'inbox';
        const nextSources = {};
        for (const [id, source] of Object.entries(current.sources)) {
          nextSources[id] = {
            enabled: source.enabled !== false,
            allowed: source.allowed ?? [],
            // auth 必须原样带回去：漏了它 = 把签名源静默降级成 no-auth。
            ...(source.auth ? { auth: source.auth } : {}),
          };
        }
        if (!nextSources[targetSource]) nextSources[targetSource] = { enabled: true, allowed: [] };
        if (args.allowed !== undefined) {
          nextSources[targetSource].allowed = args.allowed.map((id) => ({ id }));
        }

        const next = {
          mode: args.mode ?? current.mode,
          sources: nextSources,
          limits: {
            cooldownSeconds: args.cooldownSeconds ?? current.limits.cooldownSeconds,
            maxAcceptsPerActorPerHour:
              args.maxAcceptsPerActorPerHour ?? current.limits.maxAcceptsPerActorPerHour,
          },
          types: args.types !== undefined ? args.types : (current.types ?? {}),
          workspace: current.workspace,
        };
        const saved = dutyRefObj.current.savePolicy(next);
        if (saved.ok === false) {
          return {
            ok: false,
            summary: '策略未保存：校验失败',
            text: `策略未保存，校验失败（不做静默降级）：\n${saved.errors.map((e) => `  - ${e}`).join('\n')}`,
          };
        }
        const noticeText = saved.notices.length === 0
          ? '没有在跑工单受影响。'
          : `已向 ${saved.notices.length} 张在跑工单投递变更通知（未撤销授权）：\n${saved.notices
              .map((n) => `  - ${n.ticketId}: ${n.from} → ${n.to}${n.stillAllowed ? '' : '（该投递人已不在名单，恢复时会被拒绝）'}`)
              .join('\n')}`;
        return { ok: true, summary: `策略已保存 ${saved.policy.version}`, text: `策略已保存：${saved.policy.version}\n${noticeText}` };
      }),
    },
    {
      name: 'duty_poll',
      description:
        '立刻轮询一次 GitHub（只读），返回本轮统计。改完配置想马上验证时用它，不用等下一轮定时。只读，不会评论或开 PR。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: ['mentions', 'involves'],
            description: '本次临时覆盖搜索方式（不写回配置）：mentions=谁 @ 了我；involves=与我有牵连。',
          },
        },
        required: [],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }] },
      execute: safe('duty_poll', async (args) => {
        const duty = dutyRefObj.current;
        if (typeof args.mode === 'string' && args.mode !== '') {
          // 只影响这一次：holder 每轮都会从磁盘重建，不会留在内存里。
          duty.config.github = { ...duty.config.github, mode: args.mode };
        }
        const stats = await duty.pollGithub();
        if (stats.skipped) return { ok: false, summary: `已跳过：${stats.skipped}`, text: `本轮跳过：${stats.skipped}` };
        if (stats.error) return { ok: false, summary: '轮询失败', text: `轮询失败：${stats.error}` };
        const lines = [
          `方式 ${stats.mode}（${stats.asked}）：找到 ${stats.found} 条`,
          `开单 ${stats.accepted} · 扇出 ${stats.fanout} · 重复 ${stats.duplicate} · 拒绝 ${stats.denied} · 顺延 ${stats.deferred}`,
        ];
        if (stats.found === 0) lines.push('（没有匹配项。如果是 mentions 为空，可以试 mode=involves 看看。）');
        return {
          ok: true,
          summary: `GitHub：找到 ${stats.found}，开单 ${stats.accepted}`,
          text: lines.join('\n'),
        };
      }),
    },
    {
      name: 'duty_work',
      description:
        '把一张可派工的工单派给**独立执行器 Session**（preset=duty-worker）。执行器的工具面由 preset 决定，并已移除：团队编排、记忆写入、人设修改、再起子代理、递归派工、外网检索。执行器在自己的 Session 里跑，结果回到本会话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticketId: { type: 'string', description: '指定工单 id；不填则取最早一张可派的。' },
        },
        required: [],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }] },
      execute: safe('duty_work', async (args, exec) => {
        const refusal = callerRefusal(exec, 'duty_work');
        if (refusal) return refusal;
        const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined;
        if (!subagents || typeof subagents.startActivation !== 'function') {
          return {
            ok: false,
            summary: '宿主没有 subagents 服务，无法派工',
            text: '宿主没有 subagents 服务（或版本不提供 startActivation），改用 duty_claim 在本会话执行。',
          };
        }
        const parent = exec?.agent;
        if (!parent) {
          return {
            ok: false,
            summary: '派工需要在一个 Session 里调用',
            text: '派工需要调用方的 agent（exec.agent 为空）。请在一个会话里调用本工具。',
          };
        }

        const ticketId = typeof args.ticketId === 'string' && args.ticketId !== '' ? args.ticketId : null;
        const claimed = dutyRefObj.current.claim(ticketId);
        if (claimed === null) {
          return { ok: false, summary: '没有可派工的工单', text: '没有可派工的工单。' };
        }
        if (claimed.refused) {
          return {
            ok: false,
            summary: `派不了：${claimed.refused}`,
            text: `派不了：${claimed.refused}${claimed.hint ? `（${claimed.hint}）` : ''}\n\n${describeTicket(claimed.ticket)}`,
          };
        }

        // 先占位再拉起：两步之间不能让同一张单手滑派两次。
        const assigned = dutyRefObj.current.assign(claimed.id, { executorId: WORKER_PROVIDER });
        if (!assigned.ok) {
          return { ok: false, summary: `派工失败：${assigned.reason}`, text: `派工失败：${assigned.reason}` };
        }

        const workspace = dutyRefObj.current.config?.policy?.workspace ?? null;
        let started;
        try {
          started = await subagents.startActivation({
            provider: WORKER_PROVIDER,
            label: String(claimed.title ?? '').slice(0, 80),
            request: buildActivationRequest({ ticket: claimed, parent, workspace }),
            ...(exec?.signal ? { signal: exec.signal } : {}),
            delivery: 'parent',
          });
        } catch (error) {
          // 拉不起来就把占位释放掉，否则这张单永远卡在 running。
          dutyRefObj.current.releaseAssignment(claimed.id, { reason: 'dispatch-failed' });
          const message = String(error?.message ?? error);
          return {
            ok: false,
            summary: `派工失败：${message}`,
            text: `派工失败，占位已释放，可重试。\n原因：${message}\n\n${describeTicket(claimed)}`,
          };
        }

        const childId = started?.childId ?? '(unknown)';
        dutyRefObj.current.recordChild(claimed.id, childId);
        return {
          ok: true,
          summary: `已派给执行器 ${childId}`,
          text: [
            `已把工单派给独立执行器：${childId}`,
            `作业 ${assigned.assignment.id} 已记录为 running（这张单不会再被派第二次）。`,
            '',
            describeTicket(claimed),
            '',
            '执行器在自己的 Session 里跑，跑完结果会回到本会话。',
          ].join('\n'),
        };
      }),
    },
  ];
}

// ── 定时器 ────────────────────────────────────────────────

/** 与 daily-report 同构的四级回落：ctx.interval → ctx.timer → ctx.setInterval → 全局（必须 unref）。 */
function everyInterval(ctx, fn, ms) {
  const guarded = () => {
    try {
      fn();
    } catch (error) {
      log(`interval callback threw: ${error?.message ?? error}`);
    }
  };
  const probe = (f) => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  const viaContext = probe(() => (typeof ctx.interval === 'function' ? ctx.interval(guarded, ms) : undefined));
  if (typeof viaContext === 'function') return viaContext;
  const viaService = probe(() =>
    ctx.timer && typeof ctx.timer.interval === 'function' ? ctx.timer.interval(guarded, ms) : undefined,
  );
  if (typeof viaService === 'function') return viaService;
  const viaLegacy = probe(() => (typeof ctx.setInterval === 'function' ? ctx.setInterval(guarded, ms) : undefined));
  if (typeof viaLegacy === 'function') return viaLegacy;
  const handle = setInterval(guarded, ms);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

// ── 插件入口 ──────────────────────────────────────────────

export function apply(ctx) {
  log('dsh-duty mounted');

  const holder = { current: null };

  try {
    ensureConfig();
    holder.current = new Duty({ stateFile: STATE_FILE, configFile: CONFIG_FILE, defaultInboxDir: INBOX_DIR }).load();
    holder.current.ensureDirs();
    log(`state loaded: ${STATE_FILE}`);
  } catch (error) {
    log(`init failed: ${error?.message ?? error}`);
    return;
  }

  dutyRef = holder.current;

  // 每次都从磁盘重建：面板/工具/定时器看到的是**当前**状态，而不是进程启动那一刻的投影。
  const makeDuty = () =>
    new Duty({ stateFile: STATE_FILE, configFile: CONFIG_FILE, defaultInboxDir: INBOX_DIR }).load();

  // 1) 模型工具
  for (const definition of buildTools(ctx, holder)) {
    try {
      ctx.tools.register(definition);
      log(`tool ${definition.name} registered`);
    } catch (error) {
      log(`tool ${definition.name} registration FAILED: ${error?.message ?? error}`);
    }
  }

  // 1b) 面板路由（宿主有 webServer 才挂；headless 组合下安静跳过）
  try {
    const panelApi = createPanelApi({ openDuty: makeDuty });
    const fence = makeFence(ctx);
    ctx.inject(['webServer'], (sctx) => {
      for (const route of makePanelRoutes({ api: panelApi, fence, log })) {
        sctx.effect(
          () => sctx.webServer.register(route),
          `dsh-duty: ${route.kind} ${route.path}`,
        );
      }
      log('panel routes mounted: /duty/api/{state,action}');
    });
  } catch (error) {
    log(`panel route registration FAILED: ${error?.message ?? error}`);
  }

  // 2) 定时扫收件箱
  const tickMs = Math.max(10, Number(holder.current.config.tickSeconds) || 60) * 1000;
  try {
    everyInterval(ctx, () => {
      // 每轮重读配置：用户改 config.json 后不用重启 DSH。
      holder.current = makeDuty();
      dutyRef = holder.current;
      const results = holder.current.scanInbox();
      if (results.length > 0) {
        const accepted = results.filter((r) => r.route.kind === 'evaluate').length;
        log(`inbox scan: ${results.length} file(s), ${accepted} accepted`);
      }
    }, tickMs);
    log(`scheduler armed: every ${tickMs / 1000}s`);
  } catch (error) {
    log(`scheduler FAILED: ${error?.message ?? error}`);
  }

  // 3) 定时轮询 GitHub（只读）。与收件箱分开计时，互不拖累。
  let githubBusy = false;
  let cachedLogin = null;
  let lastSkip = null;
  const githubIntervalMs =
    Math.max(30, Number(holder.current.config.github?.intervalSeconds) || 180) * 1000;

  const pollGithub = async () => {
    if (githubBusy) return;
    githubBusy = true;
    try {
      holder.current = makeDuty();
      dutyRef = holder.current;
      if (cachedLogin) holder.current.githubLogin = cachedLogin;

      const stats = await holder.current.pollGithub();
      if (holder.current.githubLogin) cachedLogin = holder.current.githubLogin;

      if (stats?.error) {
        log(`github poll failed: ${stats.error}`);
      } else if (stats?.found > 0) {
        log(
          `github poll: found=${stats.found} accepted=${stats.accepted} fanout=${stats.fanout}` +
            ` duplicate=${stats.duplicate} denied=${stats.denied} deferred=${stats.deferred}`,
        );
      } else if (stats?.skipped && stats.skipped !== lastSkip) {
        // 只在状态变化时记一次，避免每 3 分钟刷同一条。
        lastSkip = stats.skipped;
        log(`github poll skipped: ${stats.skipped}`);
      }
    } catch (error) {
      log(`github poll threw: ${error?.message ?? error}`);
    } finally {
      githubBusy = false;
    }
  };

  try {
    everyInterval(ctx, () => {
      void pollGithub();
    }, githubIntervalMs);
    log(`github poll armed: every ${githubIntervalMs / 1000}s`);
  } catch (error) {
    log(`github poll scheduler FAILED: ${error?.message ?? error}`);
  }

  // 4) 执行器结束时自动关单
  //
  // 不接这个事件的话，执行器跑完了工单还是 open、assignment 还是 running ——
  // 状态里会挂一条假的「在跑」，只有派工方记得手动 duty_report 才会消失。
  // 事件载荷（宿主源码）：{ runId, provider, id: childId, stopReason, lastAssistantMessage? }
  try {
    const onSubagentEnd = (info) => {
      const childId = info?.id;
      if (!childId) return;
      try {
        holder.current = makeDuty();
        dutyRef = holder.current;
        const ticketId = holder.current.ticketOfChild(childId);
        if (!ticketId) return; // 不是我们派的，别插手

        const stopReason = String(info?.stopReason ?? 'ended');
        const said = typeof info?.lastAssistantMessage === 'string' ? info.lastAssistantMessage.trim() : '';
        const failed = /(error|fail|abort|cancel|timeout|kill|crash)/i.test(stopReason);
        // 注意：lastAssistantMessage 是**结构化输出**（只有给了 outputSchema 才有值），
        // 不是执行器的自然语言回答 —— 后者会作为子代理消息回到发起会话。
        const text = said
          ? [`[执行器结束] stopReason=${stopReason}`, '', said].join('\n')
          : [
              `[执行器结束] stopReason=${stopReason}；工单已自动关闭。`,
              '',
              '执行器的最终回答会作为子代理消息回到发起会话，不在工单正文里。',
            ].join('\n');
        const result = holder.current.report({
          ticketId,
          outcome: failed ? 'blocked' : 'done',
          text,
        });
        log(`subagent end: child=${childId} ticket=${ticketId} outcome=${failed ? 'blocked' : 'done'} ok=${result.ok}`);
      } catch (error) {
        log(`subagent end handler failed: ${error?.message ?? error}`);
      }
    };

    if (typeof ctx.on === 'function') {
      ctx.on('subagent/end', onSubagentEnd);
      log('subagent/end hook armed');
    } else {
      log('subagent/end hook NOT armed: ctx.on 不可用');
    }
  } catch (error) {
    log(`subagent/end hook FAILED: ${error?.message ?? error}`);
  }
}
