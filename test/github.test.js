/**
 * GitHub 只读 Source 测试。
 * 纯函数 + 一次真实的 pollGithub 编排（用假 run 注入，不联网）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Duty } from '../lib/duty.js';
import {
  buildSearchArgs,
  deriveCandidates,
  githubThreadId,
} from '../lib/sources/github.js';

const dirs = [];
function freshDuty({ allowed = ['alice'], mode = 'mentions', maxNewPerPoll = 2, repos = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-duty-gh-'));
  dirs.push(dir);
  const configFile = join(dir, 'config.json');
  const stateFile = join(dir, 'state.jsonl');
  writeFileSync(
    configFile,
    JSON.stringify({
      inboxDir: join(dir, 'inbox'),
      defaultActor: 'alice',
      github: { mode, repos, limit: 10, maxNewPerPoll, intervalSeconds: 180 },
      policy: {
        mode: 'act',
        sources: {
          inbox: { enabled: true, allowed: [{ id: 'alice' }] },
          github: { enabled: true, allowed: allowed.map((id) => ({ id })) },
        },
        limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
      },
    }),
    'utf8',
  );
  const duty = new Duty({ stateFile, configFile }).load();
  duty.githubLogin = 'tester';
  return duty;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const issue = (number, over = {}) => ({
  number,
  title: `第 ${number} 号问题`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  repository: { name: 'widgets', nameWithOwner: 'acme/widgets' },
  author: { login: 'alice', is_bot: false },
  updatedAt: '2026-11-07T05:00:00Z',
  state: 'open',
  isPullRequest: false,
  body: '正文',
  ...over,
});

const fakeRun = (items) => async () => ({ code: 0, stdout: JSON.stringify(items), stderr: '' });

test('buildSearchArgs：mentions / involves 两种方式，limit 会被夹在 1..100', () => {
  const a = buildSearchArgs({ mode: 'mentions', me: 'me', limit: 5 });
  assert.deepEqual(a.slice(0, 6), ['search', 'issues', '--mentions', 'me', '--state', 'open']);
  assert.ok(a.includes('--json'));

  assert.equal(buildSearchArgs({ mode: 'involves', me: 'me' })[2], '--involves');
  assert.equal(buildSearchArgs({ mode: 'mentions', me: 'me', limit: 9999 })[7], '100');
  assert.equal(buildSearchArgs({ mode: 'mentions', me: 'me', limit: 0 })[7], '1');
  assert.throws(() => buildSearchArgs({ mode: 'mentions' }), /需要 me/);
});

test('deriveCandidates：仓库过滤、线程 id 稳定、事件 id 随 updatedAt 变化', () => {
  const items = [issue(1), issue(2, { repository: { name: 'other', nameWithOwner: 'x/other' } })];
  const onlyAcme = deriveCandidates(items, { repos: ['acme/widgets'] });
  assert.equal(onlyAcme.length, 1);
  assert.equal(onlyAcme[0].threadId, 'github:acme/widgets#1');

  const all = deriveCandidates(items, { repos: [] });
  assert.equal(all.length, 2);

  const later = deriveCandidates([issue(1, { updatedAt: '2026-11-08T00:00:00Z' })], {});
  assert.notEqual(later[0].nativeId, onlyAcme[0].nativeId, '同一 issue 的新更新必须是新事件');
  assert.equal(later[0].threadId, onlyAcme[0].threadId, '但属于同一线程');
  assert.equal(githubThreadId('acme/widgets', 1), 'github:acme/widgets#1');
});

test('pollGithub：允许名单为空 ⇒ 直接跳过，不调 gh', async () => {
  const duty = freshDuty({ allowed: [] });
  let called = 0;
  const stats = await duty.pollGithub({ run: async () => { called += 1; return { code: 0, stdout: '[]' }; } });
  assert.equal(stats.skipped, 'no-allowed');
  assert.equal(called, 0);
});

test('pollGithub：拿不到登录名 ⇒ 本轮跳过（不崩、不建单）', async () => {
  const duty = freshDuty();
  duty.githubLogin = null;
  const stats = await duty.pollGithub({
    run: async () => ({ code: 1, stdout: '', stderr: 'not logged in' }),
  });
  assert.equal(stats.skipped, 'no-login');
  assert.equal(duty.state.tickets.size, 0);
});

test('pollGithub：gh 失败时返回 error 而不是抛', async () => {
  const duty = freshDuty();
  const stats = await duty.pollGithub({
    run: async () => ({ code: 4, stdout: '', stderr: 'HTTP 401: Bad credentials' }),
  });
  assert.match(stats.error, /Bad credentials/);
});

test('pollGithub：首次轮询开单，每轮受 maxNewPerPoll 限制，剩下的下一轮再来', async () => {
  const duty = freshDuty({ maxNewPerPoll: 2 });
  const items = [issue(1), issue(2), issue(3)];

  const first = await duty.pollGithub({ run: fakeRun(items) });
  assert.equal(first.found, 3);
  assert.equal(first.accepted, 2, '上限 2');
  assert.equal(first.deferred, 1, '第 3 条不提交，下一轮自然重来');
  assert.equal(duty.state.tickets.size, 2);

  const second = await duty.pollGithub({ run: fakeRun(items) });
  assert.equal(second.accepted, 1, '上一轮被推迟的那条这一轮补上');
  assert.equal(second.duplicate, 2, '已开单的两条不重复开');
  assert.equal(duty.state.tickets.size, 3);
});

test('pollGithub：同一 issue 再次更新 ⇒ 作为上下文扇出，不新建工单', async () => {
  const duty = freshDuty({ maxNewPerPoll: 5 });
  await duty.pollGithub({ run: fakeRun([issue(7)]) });
  assert.equal(duty.state.tickets.size, 1);
  const ticketId = [...duty.state.tickets.keys()][0];

  const updated = await duty.pollGithub({
    run: fakeRun([issue(7, { updatedAt: '2026-11-09T00:00:00Z' })]),
  });
  assert.equal(updated.fanout, 1);
  assert.equal(updated.accepted, 0);
  assert.equal(duty.state.tickets.size, 1, '扇出绝不能新建工单');
  assert.deepEqual(duty.state.liveTicketsByThread.get('github:acme/widgets#7'), [ticketId]);
});

test('pollGithub：作者不在 GitHub 允许名单 ⇒ denied，不建单', async () => {
  const duty = freshDuty({ allowed: ['bob'] });
  const stats = await duty.pollGithub({ run: fakeRun([issue(9, { author: { login: 'alice', is_bot: false } })]) });
  assert.equal(stats.denied, 1);
  assert.equal(duty.state.tickets.size, 0);
  assert.equal(duty.state.dispositions.get(stats ? [...duty.state.dispositions.keys()][0] : '').reason, 'actor-not-allowed');
});
