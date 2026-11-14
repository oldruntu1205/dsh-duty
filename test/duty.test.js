/**
 * 编排层测试 —— 用真实临时目录跑通「投递 → 落库 → 重放」。
 * 跑法：node --test
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Duty, parseFrontMatter } from '../lib/duty.js';
import { loadState } from '../lib/store.js';
import { normalizePolicy } from '../lib/policy.js';

const dirs = [];
function freshDuty(configPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-duty-'));
  dirs.push(dir);
  const configFile = join(dir, 'config.json');
  const stateFile = join(dir, 'state.jsonl');
  writeFileSync(
    configFile,
    JSON.stringify({
      inboxDir: join(dir, 'inbox'),
      defaultActor: 'alice',
      policy: {
        mode: 'act',
        sources: { inbox: { enabled: true, allowed: [{ id: 'alice' }] } },
        limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
      },
      ...configPatch,
    }),
    'utf8',
  );
  return new Duty({ stateFile, configFile }).load();
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('T1 幂等：同一件事投 10 次，只产生 1 张工单', () => {
  const duty = freshDuty();
  const first = duty.submit({ nativeId: 'same.md', text: '修一下登录页' });
  assert.equal(first.route.kind, 'evaluate');
  assert.ok(first.ticket);

  for (let i = 0; i < 9; i += 1) {
    const again = duty.submit({ nativeId: 'same.md', text: '修一下登录页' });
    assert.equal(again.route.kind, 'duplicate');
    assert.equal(again.ticket, undefined, '重复投递不得产生新工单');
  }

  assert.equal(duty.state.tickets.size, 1);
  assert.equal(duty.state.triggers.size, 1);
});

test('T5 observe 模式：工单落成 observed，领不到工单', () => {
  const duty = freshDuty({
    policy: {
      mode: 'observe',
      sources: { inbox: { enabled: true, allowed: [{ id: 'alice' }] } },
      limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
    },
  });
  const { ticket } = duty.submit({ nativeId: 'x.md', text: '顺手帮我改个文案' });
  assert.equal(ticket.dispatch, 'observed');

  const claimed = duty.claim();
  assert.equal(claimed.refused, 'observe-mode');
  assert.equal(duty.status().counts.ready, 0);
  assert.equal(duty.status().needsPerson.length, 1, 'observe 下必须出现在「需要人」列表里');
});

test('T5b act 模式：可领取，回报后关单', () => {
  const duty = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'y.md', text: '加个健康检查' });
  assert.equal(ticket.dispatch, 'ready');

  const claimed = duty.claim();
  assert.equal(claimed.id, ticket.id);

  const reported = duty.report({ ticketId: ticket.id, text: '已完成', outcome: 'done' });
  assert.equal(reported.ok, true);
  assert.equal(reported.ticket.state, 'ended');
  assert.equal(duty.claim(), null, '关单后不能再被领取');
});

test('策略落盘：保存策略会写通知，但不改在跑工单', () => {
  const duty = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'z.md', text: '重构' });
  const frozen = ticket.mandate.policyVersion;

  const saved = duty.savePolicy({
    mode: 'act',
    sources: { inbox: { enabled: true, allowed: [] } },
    limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
  });

  assert.equal(saved.notices.length, 1);
  assert.equal(saved.notices[0].stillAllowed, false);
  assert.equal(duty.state.tickets.get(ticket.id).mandate.policyVersion, frozen);
  assert.equal(duty.state.tickets.get(ticket.id).state, 'open');
  assert.equal(duty.state.policyChanges.length, 1);
});

test('收件箱：同名文件重放不会重复建单，处理器会把文件移走', () => {
  const duty = freshDuty();
  mkdirSync(duty.config.inboxDir, { recursive: true });
  writeFileSync(join(duty.config.inboxDir, 'task-1.md'), 'actor: alice\n修一下导出按钮\n', 'utf8');

  const first = duty.scanInbox();
  assert.equal(first.length, 1);
  assert.equal(first[0].route.kind, 'evaluate');
  assert.equal(duty.state.tickets.size, 1);

  // 同一个文件名再投一次（模拟文件被放回）
  writeFileSync(join(duty.config.inboxDir, 'task-1.md'), 'actor: alice\n修一下导出按钮\n', 'utf8');
  const second = duty.scanInbox();
  assert.equal(second[0].route.kind, 'duplicate');
  assert.equal(duty.state.tickets.size, 1);
});

test('存储：坏行不影响其余记录的重放', () => {
  const duty = freshDuty();
  duty.submit({ nativeId: 'ok.md', text: '正常一条' });
  const raw = readFileSync(duty.stateFile, 'utf8');
  writeFileSync(duty.stateFile, `${raw}{ this is not json\n`, 'utf8');

  const state = loadState(duty.stateFile);
  assert.equal(state.tickets.size, 1);
  assert.equal(state.triggers.size, 1);
});

test('P2 派工：assign 占位后领不到，重复派工被拒；释放后可重派', () => {
  const duty = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'w.md', text: '写个测试' });

  const first = duty.assign(ticket.id, { executorId: 'spawn' });
  assert.equal(first.ok, true);
  assert.equal(first.assignment.state, 'running');

  assert.equal(duty.state.runningByTicket.get(ticket.id), first.assignment.id);

  const claimed = duty.claim();
  assert.equal(claimed.refused, 'all-running');

  const again = duty.assign(ticket.id, { executorId: 'spawn' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-running');

  duty.releaseAssignment(ticket.id, { reason: 'dispatch-failed' });
  assert.equal(duty.state.runningByTicket.has(ticket.id), false);
  const reclaim = duty.claim();
  assert.equal(reclaim.id, ticket.id, '释放后可以重派');
});

test('P2 派工：observe 模式的工单不允许 assign', () => {
  const duty = freshDuty({
    policy: {
      mode: 'observe',
      sources: { inbox: { enabled: true, allowed: [{ id: 'alice' }] } },
      limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
    },
  });
  const { ticket } = duty.submit({ nativeId: 'o.md', text: '看看' });
  const result = duty.assign(ticket.id, { executorId: 'spawn' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'observe-mode');
});

test('P2 派工：report 会同时结束 assignment', () => {
  const duty = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'r.md', text: '跑测试' });
  const assigned = duty.assign(ticket.id, { executorId: 'spawn' });
  assert.equal(duty.state.runningByTicket.has(ticket.id), true);

  duty.report({ ticketId: ticket.id, text: '完成', outcome: 'done' });
  assert.equal(duty.state.runningByTicket.has(ticket.id), false);
  assert.equal(duty.state.assignments.get(assigned.assignment.id).state, 'ended');
  assert.equal(duty.state.assignments.get(assigned.assignment.id).endedReason, 'done');
});

test('P2 防递归：执行器的 agent id 被识别，工单结束后失效', () => {  const duty = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'g.md', text: '看看' });
  duty.assign(ticket.id, { executorId: 'spawn' });

  assert.equal(duty.isWorkerAgent('fc12a442'), false, '还没记录 childId 时不认');
  duty.recordChild(ticket.id, 'fc12a442');
  assert.equal(duty.isWorkerAgent('fc12a442'), true);
  assert.equal(duty.isWorkerAgent('other-agent'), false);

  duty.report({ ticketId: ticket.id, text: '完成', outcome: 'done' });
  assert.equal(duty.isWorkerAgent('fc12a442'), false, '工单结束后不再是执行器');
});

test('P2 自动关单：由 childId 反查工单，关单后不再反查得到', () => {
  const duty = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'auto.md', text: 'x' });
  duty.assign(ticket.id, { executorId: 'spawn' });
  duty.recordChild(ticket.id, 'child-1');

  assert.equal(duty.ticketOfChild('child-1'), ticket.id);
  assert.equal(duty.ticketOfChild('child-2'), null);
  assert.equal(duty.ticketOfChild(''), null);

  const first = duty.report({ ticketId: ticket.id, text: '[执行器结束] stopReason=completed', outcome: 'done' });
  assert.equal(first.ok, true);
  assert.equal(duty.ticketOfChild('child-1'), null, '关单后 assignment 结束，反查为空');

  // 重复关单必须是「已知的 no-op」，不能抛
  const again = duty.report({ ticketId: ticket.id, text: '重复', outcome: 'done' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'not-open');
});

test('前置元信息：actor 覆盖默认投递人，且元信息行不进正文', () => {
  const parsed = parseFrontMatter('actor: bob\n正文第一行\n正文第二行');
  assert.equal(parsed.actor, 'bob');
  assert.equal(parsed.body, '正文第一行\n正文第二行', '元信息行必须从正文剥掉');

  const plain = parseFrontMatter('没有元信息\n第二行');
  assert.equal(plain.actor, undefined);
  assert.equal(plain.body, '没有元信息\n第二行');

  // 前置空行 + 分隔线也不该污染正文
  const spaced = parseFrontMatter('\n---\nactor: carol\n\n真正的正文');
  assert.equal(spaced.actor, 'carol');
  assert.equal(spaced.body, '真正的正文');
});

test('归一化策略：坏值回落默认，缺省时谁也进不来', () => {
  const p = normalizePolicy({ sources: { inbox: { allowed: 'nope' } }, limits: { cooldownSeconds: 'x' } });
  assert.deepEqual(p.sources.inbox.allowed, []);
  assert.equal(p.limits.cooldownSeconds, 300);
  assert.equal(p.mode, 'observe');
});
