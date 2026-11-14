/**
 * dsh-duty · 存储（append-only JSONL，无第三方依赖）
 *
 * 为什么不用 sqlite：桌面端单进程、低频；JSONL 追加写没有原生模块编译问题（Windows 上
 * better-sqlite3 是常见坑），而且出问题时能用 read / grep 直接看。
 *
 * 写：一次 `appendFileSync` 写多行（一条记录一行），O_APPEND 下不会互相覆盖。
 * 读：全量扫描 → fold 成内存投影。数据量在「一个工作区的值班记录」这个量级，够用。
 *
 * S2（2026-11-14）：旧记录没有 type / link / correlationId 是常态，**投影补默认值**，
 * 绝不回写历史 JSONL（L1 不得做的事：不重写历史、不批量重算既有工单授权）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULT_TYPE, SCHEMA_VERSION } from './domain.js';

export function emptyState() {
  return {
    triggers: new Map(), // triggerId -> trigger
    dispositions: new Map(), // triggerId -> disposition（最后一次）
    tickets: new Map(), // ticketId -> ticket
    ticketByTrigger: new Map(), // triggerId -> ticketId
    /** S2：correlationId -> 在跑工单 ticketId（跨源合并用）。 */
    ticketByCorrelation: new Map(),
    liveTicketsByThread: new Map(), // threadId -> [ticketId]
    accepts: [], // { actor, at, ticketId } —— 频率门禁用
    lastAcceptByThread: new Map(),
    policyChanges: [],
    assignments: new Map(), // assignmentId -> assignment（派工记录）
    runningByTicket: new Map(), // ticketId -> assignmentId（在跑的那一个）
  };
}

/** 把一条记录折进投影。纯函数式：就地改传入的 state（调用方自持），返回 state。 */
export function fold(state, record) {
  if (!record || typeof record !== 'object') return state;
  const at = Number(record.at ?? 0);

  switch (record.t) {
    case 'trigger': {
      if (!record.trigger?.id) break;
      state.triggers.set(record.trigger.id, record.trigger);
      break;
    }
    case 'disposition': {
      if (!record.triggerId) break;
      state.dispositions.set(record.triggerId, record);
      break;
    }
    case 'ticket': {
      const raw = record.ticket;
      if (!raw?.id) break;
      // 投影补默认值：S2 之前的工单没有 type/link，读出来必须仍是合法工单。
      const ticket = {
        ...raw,
        type: typeof raw.type === 'string' ? raw.type : DEFAULT_TYPE,
        link: typeof raw.link === 'string' ? raw.link : null,
        correlationId: typeof raw.correlationId === 'string' ? raw.correlationId : null,
      };
      state.tickets.set(ticket.id, ticket);
      if (ticket.originTriggerId) state.ticketByTrigger.set(ticket.originTriggerId, ticket.id);
      if (ticket.correlationId) state.ticketByCorrelation.set(ticket.correlationId, ticket.id);
      for (const threadId of ticket.threads ?? []) {
        const list = state.liveTicketsByThread.get(threadId) ?? [];
        if (!list.includes(ticket.id)) list.push(ticket.id);
        state.liveTicketsByThread.set(threadId, list);
      }
      state.accepts.push({ actor: ticket.mandate?.actor, at: ticket.createdAt ?? at, ticketId: ticket.id });
      if (ticket.mandate?.actor) {
        for (const threadId of ticket.threads ?? []) {
          state.lastAcceptByThread.set(threadId, ticket.createdAt ?? at);
        }
      }
      break;
    }
    case 'ticket-ended': {
      const ticket = state.tickets.get(record.ticketId);
      if (!ticket) break;
      const ended = {
        ...ticket,
        state: 'ended',
        endedAt: at,
        endedReason: record.reason ?? 'ended',
        stoppedByPerson: record.reason === 'stopped-by-person',
      };
      state.tickets.set(ended.id, ended);
      // 已结束的工单不再接受跨源关联：合并只对「正在跑」的有意义。
      if (ended.correlationId && state.ticketByCorrelation.get(ended.correlationId) === ended.id) {
        state.ticketByCorrelation.delete(ended.correlationId);
      }
      for (const threadId of ended.threads ?? []) {
        const list = (state.liveTicketsByThread.get(threadId) ?? []).filter((id) => id !== ended.id);
        if (list.length > 0) state.liveTicketsByThread.set(threadId, list);
        else state.liveTicketsByThread.delete(threadId);
      }
      break;
    }
    case 'policy-change': {
      state.policyChanges.push(record);
      break;
    }
    case 'assignment': {
      const assignment = record.assignment;
      if (!assignment?.id || !assignment.ticketId) break;
      state.assignments.set(assignment.id, assignment);
      if (assignment.state !== 'ended') state.runningByTicket.set(assignment.ticketId, assignment.id);
      break;
    }
    case 'assignment-ended': {
      const runningId = state.runningByTicket.get(record.ticketId);
      if (runningId !== undefined) {
        const existing = state.assignments.get(runningId);
        if (existing) {
          state.assignments.set(runningId, {
            ...existing,
            state: 'ended',
            endedAt: at,
            endedReason: record.reason ?? 'ended',
          });
        }
        state.runningByTicket.delete(record.ticketId);
      }
      break;
    }
    case 'assignment-child': {
      // 执行器真正拉起来之后补记它的 agent id：用来识别「调用方本身是执行器」，防递归。
      const runningId = state.runningByTicket.get(record.ticketId);
      const existing = runningId !== undefined ? state.assignments.get(runningId) : undefined;
      if (existing && record.childId) {
        state.assignments.set(runningId, { ...existing, childId: record.childId });
      }
      break;
    }
    default:
      break;
  }
  return state;
}

/** 读全量 → 投影。文件不存在 = 空状态（不是错误）。 */
export function loadState(file) {
  const state = emptyState();
  if (!file || !existsSync(file)) return state;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      fold(state, JSON.parse(line));
    } catch {
      // 单行坏了不影响整个投影：值班记录不能因为一行截断就全丢。
    }
  }
  return state;
}

/** 追加记录。一次调用写多行，减少落盘次数。 */
export function appendRecords(file, records) {
  const list = Array.isArray(records) ? records : [records];
  if (list.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const body = list.map((r) => JSON.stringify({ v: SCHEMA_VERSION, ...r })).join('\n') + '\n';
  appendFileSync(file, body, { encoding: 'utf8', flag: 'a' });
}

/** 给 status 用的摘要：只报「需要人看的」，健康状态不占字数。 */
export function summarize(state) {
  const tickets = [...state.tickets.values()];
  const open = tickets.filter((t) => t.state === 'open');
  return {
    triggers: state.triggers.size,
    tickets: tickets.length,
    open: open.length,
    observed: open.filter((t) => t.dispatch === 'observed').length,
    /** S2：类型被要求人工处置的工单 —— 不计入可派，但计入 open。 */
    held: open.filter((t) => t.dispatch === 'held').length,
    // 「可派」必须排除已在跑的：同一张单不能既算可派又算在跑。
    ready: open.filter((t) => t.dispatch === 'ready' && !state.runningByTicket.has(t.id)).length,
    running: open.filter((t) => state.runningByTicket.has(t.id)).length,
    ended: tickets.length - open.length,
    policyChanges: state.policyChanges.length,
  };
}
