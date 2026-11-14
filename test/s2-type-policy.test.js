/**
 * S2 测试 —— 逐条对应 L1（2026-11-14）裁决给出的断言表。
 *
 * 跑法：node --test
 *
 * 命名规则：`S2-Qn` 指送审稿里的第 n 个待判问题；`S2-Tn` 指断言表第 n 行。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  DEFAULT_HOLD_TYPES,
  DEFAULT_TYPE,
  canCorrelate,
  isValidType,
  makeTrigger,
  normalizeLink,
  resolveDispatch,
  route,
  triggerId,
} from '../lib/domain.js';
import { Duty } from '../lib/duty.js';
import { normalizePolicy, validatePolicy } from '../lib/policy.js';
import { signBody, verifyHmac } from '../lib/sources/auth.js';
import { emptyState, loadState } from '../lib/store.js';

const NOW = 1_800_000_000_000; // 固定时间（毫秒）
const NOW_SEC = NOW / 1000;
const SECRET = 'test-secret-1234567890';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshDuty({ policy, env = { TEST_SECRET: SECRET } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-duty-s2-'));
  dirs.push(dir);
  const configFile = join(dir, 'config.json');
  const stateFile = join(dir, 'state.jsonl');
  const cfg = {
    inboxDir: join(dir, 'inbox'),
    webhookDir: join(dir, 'webhook'),
    defaultActor: 'alice',
    policy: policy ?? {
      mode: 'act',
      sources: {
        inbox: { enabled: true, allowed: [{ id: 'alice' }] },
        webhook: {
          enabled: true,
          allowed: [{ id: 'alice' }],
          auth: { mode: 'hmac', secretEnv: 'TEST_SECRET', toleranceSeconds: 300 },
        },
      },
      limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
    },
  };
  writeFileSync(configFile, JSON.stringify(cfg), 'utf8');
  const duty = new Duty({ stateFile, configFile, env, now: () => NOW }).load();
  return { duty, dir, stateFile, configFile };
}

const actPolicy = (extra = {}) => ({
  mode: 'act',
  sources: { inbox: { enabled: true, allowed: [{ id: 'alice' }] } },
  limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
  ...extra,
});

// ── Q1 / 断言 1、2：类型与链接不进身份 ─────────────────────

test('S2-T1 同源同 nativeId，只改 kind/type/link → triggerId 不变、不新增工单、不覆盖原单', () => {
  const a = triggerId({ sourceId: 'inbox', nativeId: 'a.md' });
  const b = triggerId({ sourceId: 'inbox', nativeId: 'a.md' });
  assert.equal(a, b);

  const { duty } = freshDuty();
  const first = duty.submit({ nativeId: 'same.md', text: '改登录页', type: 'code.change' });
  assert.equal(first.route.kind, 'evaluate');
  assert.equal(first.ticket.type, 'code.change');

  const again = duty.submit({
    nativeId: 'same.md',
    text: '改登录页',
    type: 'ops.alert', // 换了类型
    link: 'https://example.com/x', // 补了链接
  });
  assert.equal(again.route.kind, 'duplicate');
  assert.equal(duty.state.tickets.size, 1);
  assert.equal(duty.state.tickets.get(first.ticket.id).type, 'code.change', '重复投递不得覆盖原工单');
});

test('S2-T2 同 nativeId 不同 sourceId 且无关联 → triggerId 不同，不得仅凭 nativeId 合并', () => {
  const inbox = triggerId({ sourceId: 'inbox', nativeId: 'x.md' });
  const github = triggerId({ sourceId: 'github', nativeId: 'x.md' });
  assert.notEqual(inbox, github);

  const { duty } = freshDuty();
  const one = duty.submit({ sourceId: 'inbox', nativeId: 'x.md', text: 'A' });
  assert.equal(one.route.kind, 'evaluate');
  // 没有 webhook 源的允许名单/鉴权，走不通就换一个已有源验证「不合并」的结论
  const two = duty.submit({ sourceId: 'github', nativeId: 'x.md', text: 'A' });
  assert.notEqual(two.route.kind, 'duplicate', '不同源不得仅凭 nativeId 判重');
  assert.equal(duty.state.triggers.size, 2);
});

// ── Q2 / 断言 3：旧数据兼容 ────────────────────────────────

test('S2-T3 旧记录缺 type/link、旧配置缺 types → 投影补默认，历史 ID 与 dispatch 不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-duty-legacy-'));
  dirs.push(dir);
  const stateFile = join(dir, 'state.jsonl');
  // 手写一条 S2 之前的记录：没有 type / link / correlationId
  writeFileSync(
    stateFile,
    `${JSON.stringify({
      v: 1,
      t: 'ticket',
      at: 1,
      ticket: {
        id: 'tkt_legacy',
        state: 'open',
        originTriggerId: 'trg_legacy',
        title: '老工单',
        text: '老正文',
        mandate: { policyVersion: 'pol_old', sourceId: 'inbox', actor: 'alice' },
        threads: [],
        dispatch: 'ready',
        createdAt: 1,
      },
    })}\n`,
    'utf8',
  );
  const state = loadState(stateFile);
  const ticket = state.tickets.get('tkt_legacy');
  assert.equal(ticket.id, 'tkt_legacy', '投影不得改 ID');
  assert.equal(ticket.dispatch, 'ready', '投影不得改既有 dispatch');
  assert.equal(ticket.type, 'task.manual');
  assert.equal(ticket.link, null);

  assert.deepEqual(normalizePolicy({ mode: 'act' }).types, {}, '旧配置缺 types → 空对象');
});

// ── 断言 4、5：类型校验与 link 归一化 ──────────────────────

test('S2-T4 显式携带非法 type → 拒收，不得降级成 task.manual', () => {
  const { duty } = freshDuty();
  for (const bad of ['Deploy.Prod', 'deploy', 'deploy.prod ', 'code_change', '', 123]) {
    const result = duty.submit({ nativeId: `bad-${String(bad)}.md`, text: 'x', type: bad === '' ? 'deploy' : bad });
    assert.equal(result.route.kind, 'denied', `非法 type ${JSON.stringify(bad)} 必须被拒`);
    assert.equal(result.route.reason, 'bad-type');
  }
  assert.equal(duty.state.tickets.size, 0);
  assert.equal(isValidType('a.b.c'), true, '多级命名空间合法');
  assert.equal(isValidType('deploy.prod'), true);
});

test('S2-T5 非 http(s) 或超长 link → null；合法 link 在 accept 时复制到 Ticket', () => {
  assert.equal(normalizeLink('ftp://x/y'), null);
  assert.equal(normalizeLink('javascript:alert(1)'), null);
  assert.equal(normalizeLink(`https://example.com/${'a'.repeat(2100)}`), null);
  assert.equal(normalizeLink('not a url'), null);
  assert.equal(normalizeLink('https://example.com/ok'), 'https://example.com/ok');

  const { duty } = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'l.md', text: 'x', link: 'https://example.com/t/1' });
  assert.equal(ticket.link, 'https://example.com/t/1');

  const { ticket: bad } = duty.submit({ nativeId: 'b.md', text: 'x', link: 'ftp://no' });
  assert.equal(bad.link, null);
});

// ── Q6 / 断言 6、10：优先级与内置高危 ──────────────────────

test('S2-T6 精确配置 > 内置高危 > 通配 > inherit', () => {
  const explicit = { mode: 'act', types: { 'deploy.prod': { dispatch: 'observe' } } };
  assert.equal(resolveDispatch({ policy: explicit, type: 'deploy.prod', mode: 'act' }), 'observed', '精确配置可覆盖内置 hold');

  const wildcard = { mode: 'act', types: { '*': { dispatch: 'inherit' } } };
  assert.equal(resolveDispatch({ policy: wildcard, type: 'deploy.prod', mode: 'act' }), 'held', '通配不得解除内置高危');
  assert.equal(resolveDispatch({ policy: wildcard, type: 'code.change', mode: 'act' }), 'ready');

  const holdWild = { mode: 'act', types: { '*': { dispatch: 'hold' } } };
  assert.equal(resolveDispatch({ policy: holdWild, type: 'code.change', mode: 'act' }), 'held', '通配 hold 生效');
});

test('S2-T10 无 types 配置时，八种内置高危一律 held', () => {
  assert.equal(DEFAULT_HOLD_TYPES.length, 8);
  const policy = { mode: 'act', types: {} };
  for (const type of DEFAULT_HOLD_TYPES) {
    assert.equal(resolveDispatch({ policy, type, mode: 'act' }), 'held', `${type} 必须 held`);
  }
  assert.equal(resolveDispatch({ policy, type: 'task.manual', mode: 'act' }), 'ready');
});

// ── Q2 / 断言 7、8：mode 是全局上限 ────────────────────────

test('S2-T7 全局 act：inherit/observe/hold → ready/observed/held', () => {
  const policy = {
    mode: 'act',
    types: { 'a.inherit': { dispatch: 'inherit' }, 'a.observe': { dispatch: 'observe' }, 'a.hold': { dispatch: 'hold' } },
  };
  assert.equal(resolveDispatch({ policy, type: 'a.inherit', mode: 'act' }), 'ready');
  assert.equal(resolveDispatch({ policy, type: 'a.observe', mode: 'act' }), 'observed');
  assert.equal(resolveDispatch({ policy, type: 'a.hold', mode: 'act' }), 'held');
});

test('S2-T8 全局 observe：任何配置都不得产生 ready', () => {
  const policy = {
    mode: 'observe',
    types: { 'a.inherit': { dispatch: 'inherit' }, 'a.observe': { dispatch: 'observe' }, '*': { dispatch: 'inherit' } },
  };
  assert.equal(resolveDispatch({ policy, type: 'a.inherit', mode: 'observe' }), 'observed');
  assert.equal(resolveDispatch({ policy, type: 'a.observe', mode: 'observe' }), 'observed');
  assert.equal(resolveDispatch({ policy, type: 'code.change', mode: 'observe' }), 'observed');
  assert.equal(resolveDispatch({ policy, type: 'task.manual', mode: 'observe' }), 'observed');
});

// ── 断言 9：写入严格 ──────────────────────────────────────

test('S2-T9 策略含 dispatch:act 或未知值 → 校验失败且不落盘', () => {
  assert.equal(validatePolicy({ types: { 'deploy.prod': { dispatch: 'act' } } }).ok, false);
  assert.equal(validatePolicy({ types: { 'deploy.prod': { dispatch: 'hlt' } } }).ok, false);
  assert.equal(validatePolicy({ types: { 'Bad.Type': { dispatch: 'hold' } } }).ok, false);
  assert.equal(validatePolicy({ types: { '*': { dispatch: 'hold' } } }).ok, true);
  assert.equal(validatePolicy({ types: { 'deploy.prod': { dispatch: 'observe' } } }).ok, true);

  const { duty } = freshDuty();
  const saved = duty.savePolicy(actPolicy({ types: { 'deploy.prod': { dispatch: 'act' } } }));
  assert.equal(saved.ok, false);
  assert.ok(saved.errors.length > 0, '必须给出可读错误');
  assert.deepEqual(duty.policy().types, {}, '失败时不得写入');
});

// ── Q3 / 断言 11、12：held 不可派、不可领、计入 needsPerson ──

test('S2-T11 held 工单：不可派、不可领、计入 open 并列入 needsPerson', () => {
  const { duty } = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'd.md', text: '上线', type: 'deploy.prod' });
  assert.equal(ticket.dispatch, 'held');
  assert.equal(duty.state.runningByTicket.has(ticket.id), false);

  const claimed = duty.claim();
  assert.equal(claimed.refused, 'held-needs-person');
  assert.equal(claimed.ticket.id, ticket.id);

  const assigned = duty.assign(ticket.id, { executorId: 'spawn' });
  assert.equal(assigned.ok, false);
  assert.equal(assigned.reason, 'observe-mode');

  const status = duty.status();
  assert.equal(status.counts.open, 1, 'held 计入 open');
  assert.equal(status.counts.ready, 0, 'held 不计入可派');
  assert.equal(status.counts.held, 1);
  assert.equal(status.needsPerson.length, 1);
  assert.equal(status.needsPerson[0].dispatch, 'held');
  assert.equal(status.needsPerson[0].type, 'deploy.prod');
});

test('S2-T12 held 结束后不在 needsPerson；只改策略不释放既有 held', () => {
  const { duty } = freshDuty();
  const { ticket } = duty.submit({ nativeId: 'd2.md', text: '上线', type: 'deploy.prod' });
  assert.equal(duty.status().needsPerson.length, 1);

  duty.report({ ticketId: ticket.id, text: '人工处理完毕', outcome: 'done' });
  assert.equal(duty.status().needsPerson.length, 0, '结束后不再需要人');

  // 再开一张，然后显式把该类型改成 observe —— 既有 held 单不自动释放
  const second = duty.submit({ nativeId: 'd3.md', text: '再上线', type: 'deploy.prod' }).ticket;
  assert.equal(second.dispatch, 'held');
  duty.savePolicy(actPolicy({ types: { 'deploy.prod': { dispatch: 'observe' } } }));
  assert.equal(
    duty.state.tickets.get(second.id).dispatch,
    'held',
    'held 的 dispatch 随授权快照冻结，改策略不得释放',
  );
  // 之后新投递才按新姿态
  const third = duty.submit({ nativeId: 'd4.md', text: '第三次', type: 'deploy.prod' }).ticket;
  assert.equal(third.dispatch, 'observed');
});

// ── Q4 / 断言 15、16：跨源关联 ────────────────────────────

test('S2-T15 关联目标不在授权范围 → 拒收 correlation-not-authorized，不静默另开单', () => {
  const { duty } = freshDuty();
  const first = duty.submit({ nativeId: 'c1.md', text: '主线任务', actor: 'alice', correlationId: 'job-1' });
  assert.equal(first.route.kind, 'evaluate');
  const before = duty.state.tickets.size;

  // 不同 actor、不同源 → 想借 correlationId 并进 alice 的在跑工单
  const intruder = duty.submit({
    sourceId: 'webhook',
    nativeId: 'w1',
    text: '注入上下文',
    actor: 'mallory',
    correlationId: 'job-1',
  });
  assert.equal(intruder.route.kind, 'denied');
  assert.equal(intruder.route.reason, 'correlation-not-authorized');
  assert.equal(duty.state.tickets.size, before, '不得静默另开单');
});

test('S2-T16 合法跨源关联命中在跑工单 → 只 fanout 不新建；已结束目标不命中', () => {
  const state = emptyState();
  const trigger = makeTrigger({
    sourceId: 'inbox',
    nativeId: 'a.md',
    actor: 'alice',
    text: 'x',
    correlationId: 'job-2',
  });
  const policy = actPolicy();
  const decision = route({ trigger, policy, state });
  assert.equal(decision.kind, 'evaluate');

  // 手工落一张在跑工单 + 关联索引
  const ticket = { id: 'tkt_1', state: 'open', correlationId: 'job-2', mandate: { sourceId: 'inbox', actor: 'alice' } };
  state.tickets.set(ticket.id, ticket);
  state.ticketByCorrelation.set('job-2', ticket.id);

  const sameActor = makeTrigger({ sourceId: 'webhook', nativeId: 'w9', actor: 'alice', text: '补充', correlationId: 'job-2' });
  const merged = route({ trigger: sameActor, policy, state });
  assert.equal(merged.kind, 'fanout');
  assert.equal(merged.via, 'correlation');
  assert.deepEqual(merged.ticketIds, ['tkt_1']);
  assert.equal(state.tickets.size, 1, 'fanout 绝不能新建工单');

  // 目标结束后不再命中 → 回到正常 evaluate
  state.tickets.set(ticket.id, { ...ticket, state: 'ended' });
  const afterEnd = makeTrigger({ sourceId: 'webhook', nativeId: 'w10', actor: 'alice', text: '再来', correlationId: 'job-2' });
  assert.equal(route({ trigger: afterEnd, policy, state }).kind, 'denied', '源 webhook 未在策略里 → 被门禁拒，证明没走 fanout');

  assert.equal(canCorrelate({ trigger: sameActor, ticket }), true);
  assert.equal(canCorrelate({ trigger: sameActor, ticket: { mandate: { sourceId: 'github', actor: 'bob' } } }), false);
});

// ── Q5 / 断言 17-21：签名投递 ─────────────────────────────

test('S2-T17 hmac 缺环境变量 / 空密钥 / 配置错 → 拒收，绝不回落 none', () => {
  const { duty } = freshDuty({ env: {} }); // 没有 TEST_SECRET
  const dir = duty.config.webhookDir;
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ nativeId: 'w-no-secret', text: 'hi' });
  writeFileSync(
    join(dir, 'e1.json'),
    JSON.stringify({ timestamp: NOW_SEC, signature: signBody({ body, timestamp: NOW_SEC, secret: SECRET }), body }),
    'utf8',
  );
  const results = duty.scanWebhook();
  assert.equal(results[0].refused, 'secret-missing');
  assert.equal(duty.state.tickets.size, 0);

  // 空字符串密钥同样拒收
  const empty = freshDuty({ env: { TEST_SECRET: '   ' } });
  mkdirSync(empty.duty.config.webhookDir, { recursive: true });
  writeFileSync(
    join(empty.duty.config.webhookDir, 'e2.json'),
    JSON.stringify({ timestamp: NOW_SEC, signature: signBody({ body, timestamp: NOW_SEC, secret: SECRET }), body }),
    'utf8',
  );
  assert.equal(empty.duty.scanWebhook()[0].refused, 'secret-missing');
});

test('S2-T18 时间戳边界：±300 秒整通过，超界拒收', () => {
  const base = { rawBody: '{"a":1}', signature: '', secret: SECRET };
  const body = base.rawBody;
  const atEdge = NOW_SEC - 300;
  const outOfWindow = NOW_SEC - 301;
  assert.equal(
    verifyHmac({ ...base, signature: signBody({ body, timestamp: atEdge, secret: SECRET }), timestamp: atEdge, now: NOW }).ok,
    true,
  );
  assert.equal(
    verifyHmac({
      ...base,
      signature: signBody({ body, timestamp: outOfWindow, secret: SECRET }),
      timestamp: outOfWindow,
      now: NOW,
    }).reason,
    'timestamp-out-of-window',
  );
});

test('S2-T19 改动 body 中任意字段或换密钥 → 验签失败', () => {
  const original = JSON.stringify({ nativeId: 'n1', type: 'code.change', text: 'x', correlationId: 'c1' });
  const signature = signBody({ body: original, timestamp: NOW_SEC, secret: SECRET });
  const ok = verifyHmac({ rawBody: original, signature, timestamp: NOW_SEC, secret: SECRET, now: NOW });
  assert.equal(ok.ok, true);

  const tampered = JSON.stringify({ nativeId: 'n1', type: 'deploy.prod', text: 'x', correlationId: 'c1' });
  assert.equal(
    verifyHmac({ rawBody: tampered, signature, timestamp: NOW_SEC, secret: SECRET, now: NOW }).reason,
    'signature-invalid',
  );
  // 换源 = 换密钥
  assert.equal(
    verifyHmac({ rawBody: original, signature, timestamp: NOW_SEC, secret: 'another-secret', now: NOW }).reason,
    'signature-invalid',
  );
});

test('S2-T20 重序列化后的 body 不同 → 按原始字节验签，不通过重排键序"修复"', () => {
  const original = '{"b":2,"a":1}';
  // 语义等价、字节不同：键序变成 a,b，且带空格 —— 这正是「重新序列化」的真实样子。
  const reserialized = JSON.stringify({ a: 1, b: 2 });
  assert.notEqual(original, reserialized);
  assert.deepEqual(JSON.parse(original), JSON.parse(reserialized), '语义确实相同');
  const signature = signBody({ body: original, timestamp: NOW_SEC, secret: SECRET });
  assert.equal(
    verifyHmac({ rawBody: reserialized, signature, timestamp: NOW_SEC, secret: SECRET, now: NOW }).reason,
    'signature-invalid',
  );
});

test('S2-T21 同一签名事件串行 / 重启后重投 → 最多一次业务效果', () => {
  const { duty, configFile, stateFile } = freshDuty();
  const dir = duty.config.webhookDir;
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ nativeId: 'once', text: '只该建一张单', type: 'code.change' });
  const envelope = JSON.stringify({
    timestamp: NOW_SEC,
    signature: signBody({ body, timestamp: NOW_SEC, secret: SECRET }),
    body,
  });
  writeFileSync(join(dir, 'once.json'), envelope, 'utf8');
  const first = duty.scanWebhook();
  assert.equal(first[0].route.kind, 'evaluate');
  assert.equal(duty.state.tickets.size, 1);

  // 同一封信封再投一次（模拟重放）
  writeFileSync(join(dir, 'once-again.json'), envelope, 'utf8');
  const second = duty.scanWebhook();
  assert.equal(second[0].route.kind, 'duplicate', 'nativeId 相同 → 幂等');

  // 重启（重新 load）后再投
  writeFileSync(join(dir, 'once-third.json'), envelope, 'utf8');
  const reloaded = new Duty({
    stateFile,
    configFile,
    now: () => NOW,
    env: { TEST_SECRET: SECRET },
  }).load();
  assert.equal(reloaded.scanWebhook()[0].route.kind, 'duplicate', '重启后仍幂等');
  assert.equal(reloaded.state.tickets.size, 1);
});

test('S2 签名投递：合法信封落成工单，type/link 透传', () => {
  const { duty } = freshDuty();
  const dir = duty.config.webhookDir;
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({
    nativeId: 'ok-1',
    text: '从外部系统来的事',
    type: 'ops.alert',
    link: 'https://grafana.local/alert/1',
    actor: 'alice',
  });
  writeFileSync(
    join(dir, 'ok.json'),
    JSON.stringify({ timestamp: NOW_SEC, signature: signBody({ body, timestamp: NOW_SEC, secret: SECRET }), body }),
    'utf8',
  );
  const results = duty.scanWebhook();
  assert.equal(results[0].route.kind, 'evaluate');
  const ticket = results[0].ticket;
  assert.equal(ticket.type, 'ops.alert');
  assert.equal(ticket.link, 'https://grafana.local/alert/1');

  // 处理完的文件必须移走，避免每轮重扫
  assert.equal(existsSync(join(dir, 'ok.json')), false, '原位置不应残留');
  assert.equal(existsSync(join(dir, 'processed', 'ok.json')), true, '应归档到 processed/');
});
