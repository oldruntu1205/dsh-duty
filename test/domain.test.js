/**
 * 领域层测试 —— 对应设计文档里的可观测断言。
 * 跑法：node --test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TOOL_SCOPE,
  accept,
  gate,
  isAllowed,
  makeTrigger,
  policyChanged,
  policyVersion,
  route,
  triggerId,
  validateResume,
} from '../lib/domain.js';
import { emptyState } from '../lib/store.js';

const policy = (overrides = {}) => ({
  mode: 'observe',
  sources: { inbox: { enabled: true, allowed: [{ id: 'alice' }] } },
  limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
  ...overrides,
});

const trig = (over = {}) =>
  makeTrigger({ sourceId: 'inbox', nativeId: 'a.md', actor: 'alice', text: '帮我看看', ...over });

test('triggerId 只由 源/类型/原生id 决定', () => {
  const a = triggerId({ sourceId: 'inbox', kind: 'request', nativeId: 'a.md' });
  const b = triggerId({ sourceId: 'inbox', kind: 'request', nativeId: 'a.md' });
  const c = triggerId({ sourceId: 'inbox', kind: 'request', nativeId: 'b.md' });
  const d = triggerId({ sourceId: 'github', kind: 'request', nativeId: 'a.md' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d, '同 id 不同源必须是不同 Trigger');
});

test('policyVersion 与键序无关，改内容就变', () => {
  const p1 = { mode: 'act', limits: { a: 1, b: 2 } };
  const p2 = { limits: { b: 2, a: 1 }, mode: 'act' };
  const p3 = { limits: { b: 2, a: 3 }, mode: 'act' };
  assert.equal(policyVersion(p1), policyVersion(p2));
  assert.notEqual(policyVersion(p1), policyVersion(p3));
});

test('T2 授权与上下文分离：白名单外的人在已有工单线程发言 → 只 fanout，不建单', () => {
  const state = emptyState();
  const allowedPolicy = policy();
  const first = trig({ nativeId: 'a.md', threadId: 'thread-1' });
  assert.equal(route({ trigger: first, policy: allowedPolicy, state }).kind, 'evaluate');

  const ticket = accept({ trigger: first, policy: allowedPolicy, now: 1 });
  state.tickets.set(ticket.id, ticket);
  state.ticketByTrigger.set(first.id, ticket.id);
  state.liveTicketsByThread.set('thread-1', [ticket.id]);

  // mallory 不在名单上，但她的消息落在已有工单的线程上 → 只作为上下文
  const outsider = trig({ nativeId: 'm1', actor: 'mallory', kind: 'message', threadId: 'thread-1' });
  const decision = route({ trigger: outsider, policy: allowedPolicy, state });
  assert.equal(decision.kind, 'fanout');
  assert.deepEqual(decision.ticketIds, [ticket.id]);
  assert.equal(state.tickets.size, 1, 'fanout 绝不能新建工单');
});

test('T2b 白名单外的人在新线程发言 → denied', () => {
  const outsider = trig({ nativeId: 'm2', actor: 'mallory', kind: 'message', threadId: 'thread-9' });
  const decision = route({ trigger: outsider, policy: policy(), state: emptyState() });
  assert.equal(decision.kind, 'denied');
  assert.equal(decision.reason, 'actor-not-allowed');
});

test('T2c 白名单里没有这个人时，连显式请求也进不来', () => {
  const p = policy({ sources: { inbox: { enabled: true, allowed: [] } } });
  assert.equal(isAllowed(p, 'inbox', 'alice'), false);
  assert.equal(route({ trigger: trig(), policy: p, state: emptyState() }).reason, 'actor-not-allowed');
});

test('T3 授权是快照：策略变更不改变在跑工单的 Mandate，且只产生通知', () => {
  const before = policy();
  const trigger = trig({ nativeId: 'a.md' });
  const ticket = accept({ trigger, policy: before, mode: 'act', now: 1 });
  const frozen = ticket.mandate.policyVersion;
  assert.equal(frozen, policyVersion(before));

  // 规则变了：alice 被移出名单
  const after = policy({ sources: { inbox: { enabled: true, allowed: [] } } });
  assert.notEqual(policyVersion(after), frozen);

  // 工单的授权快照逐字不动
  assert.equal(ticket.mandate.policyVersion, frozen);

  // 变更只产生通知，不撤销
  const notices = policyChanged({ tickets: [ticket], nextPolicy: after, previousPolicyVersion: frozen });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].stillAllowed, false);
  assert.equal(ticket.state, 'open', '策略变更不得关闭工单');
});

test('T3b 恢复时按新策略重新校验：人停过的永远不自动恢复', () => {
  const trigger = trig({ nativeId: 'a.md' });
  const ticket = accept({ trigger, policy: policy(), mode: 'act', now: 1 });

  assert.equal(validateResume({ ticket, policy: policy() }).ok, true);
  const revoked = validateResume({
    ticket,
    policy: policy({ sources: { inbox: { enabled: true, allowed: [] } } }),
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, 'mandate-revoked');

  const stopped = validateResume({ ticket: { ...ticket, stoppedByPerson: true }, policy: policy() });
  assert.equal(stopped.reason, 'stopped-by-person');
});

test('T3c 派工只读 Mandate：拿不到 Trigger 也能判断，且工单 id 由授权快照派生', () => {
  const p = policy();
  const ticket = accept({ trigger: trig(), policy: p, now: 1 });
  const again = accept({ trigger: trig(), policy: p, now: 2 });
  assert.equal(ticket.id, again.id, '同一 trigger + 同一版策略 → 同一张工单');
  assert.deepEqual(ticket.toolScope, [...DEFAULT_TOOL_SCOPE]);
});

test('门禁：线程冷静期按线程算', () => {
  const p = policy({ limits: { cooldownSeconds: 60, maxAcceptsPerActorPerHour: 0 } });
  const trigger = trig({ nativeId: 'a.md', threadId: 'th' });
  const state = emptyState();
  state.lastAcceptByThread.set('th', 1_000);
  const denied = gate({ trigger, policy: p, state, now: 30_000 });
  assert.equal(denied.reason, 'thread-cooldown');
  assert.equal(gate({ trigger, policy: p, state, now: 61_001 }).verdict, 'allow');
});

test('门禁：actor 频率上限', () => {
  const p = policy({ limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 2 } });
  const state = emptyState();
  state.accepts.push({ actor: 'alice', at: 1_000 }, { actor: 'alice', at: 2_000 });
  const denied = gate({ trigger: trig({ nativeId: 'x.md' }), policy: p, state, now: 3_000 });
  assert.equal(denied.reason, 'actor-rate-limit');
  // 窗口滑过去之后不占额度：now - 1h = 2001，早于两条记录
  assert.equal(gate({ trigger: trig({ nativeId: 'x.md' }), policy: p, state, now: 3_602_001 }).verdict, 'allow');
});
