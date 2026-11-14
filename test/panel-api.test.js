/**
 * 面板 API 的契约测试。
 *
 * 守的是「面板看到的字段」与「面板能做的动作」：字段少了面板会崩，
 * 动作放宽了（比如允许任意方法名）就是一条越权路径。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Duty } from '../lib/duty.js';
import {
  PanelError,
  SUBMIT_TEXT_LIMIT,
  createPanelApi,
  dispatchAction,
  panelSnapshot,
} from '../lib/panel-api.js';

let dir;
let stateFile;
let configFile;

function openDuty() {
  return new Duty({ stateFile, configFile, defaultInboxDir: join(dir, 'inbox') }).load();
}

/** 写一份最小 config：mode 为 act，允许 operator 投递。 */
function seedConfig(mode = 'act') {
  const duty = openDuty();
  duty.saveConfig({
    defaultActor: 'operator',
    policy: {
      mode,
      sources: {
        inbox: { enabled: true, allowed: [{ id: 'operator' }] },
        github: { enabled: true, allowed: [] },
      },
      limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
      workspace: null,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duty-panel-'));
  stateFile = join(dir, 'state.jsonl');
  configFile = join(dir, 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('panelSnapshot', () => {
  it('空状态也能渲染：计数全 0、列表为空、模式来自策略', () => {
    seedConfig('observe');
    const snapshot = panelSnapshot(openDuty());
    assert.equal(snapshot.mode, 'observe');
    assert.equal(snapshot.counts.open, 0);
    assert.deepEqual(snapshot.tickets, []);
    assert.deepEqual(snapshot.needsPerson, []);
    assert.equal(typeof snapshot.policyVersion, 'string');
    assert.equal(snapshot.github.mode, 'mentions');
  });

  it('开放工单按创建时间正序、已结束的排在后面，并带在跑信息', () => {
    seedConfig('act');
    const duty = openDuty();
    const first = duty.submit({ text: '第一件事', actor: 'operator' }).ticket;
    const second = duty.submit({ text: '第二件事', actor: 'operator' }).ticket;
    duty.assign(first.id, { executorId: 'spawn' });

    const snapshot = panelSnapshot(openDuty(), { now: () => first.createdAt + 90_000 });
    const ids = snapshot.tickets.map((t) => t.id);
    assert.deepEqual(ids, [first.id, second.id]);
    assert.equal(snapshot.tickets[0].running.executorId, 'spawn');
    assert.equal(snapshot.tickets[1].running, null);
    assert.equal(snapshot.tickets[0].ageMs, 90_000);
    assert.equal(snapshot.tickets[0].dispatch, 'ready');
  });

  it('observe 期的工单进 needsPerson，dispatch 标成 observed', () => {
    seedConfig('observe');
    const duty = openDuty();
    duty.submit({ text: '只记录这一件', actor: 'operator' });
    const snapshot = panelSnapshot(openDuty());
    assert.equal(snapshot.counts.observed, 1);
    assert.equal(snapshot.needsPerson.length, 1);
    assert.equal(snapshot.tickets[0].dispatch, 'observed');
  });

  it('正文超长会截断，避免把整张工单塞进面板', () => {
    seedConfig('act');
    const duty = openDuty();
    duty.submit({ text: 'x'.repeat(5000), actor: 'operator' });
    const snapshot = panelSnapshot(openDuty());
    assert.ok(snapshot.tickets[0].text.length <= 1201);
  });
});

describe('createPanelApi', () => {
  it('state 只读，不落盘', () => {
    seedConfig('act');
    const api = createPanelApi({ openDuty });
    const result = api.state();
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.counts.open, 0);
  });

  it('submit 走同一套门禁：允许名单里的人能投，空正文直接拒', () => {
    seedConfig('act');
    const api = createPanelApi({ openDuty });
    assert.throws(() => api.submit({ text: '   ' }), (error) => error instanceof PanelError && error.code === 'empty-text');
    assert.throws(
      () => api.submit({ text: 'x'.repeat(SUBMIT_TEXT_LIMIT + 1) }),
      (error) => error instanceof PanelError && error.code === 'text-too-long',
    );

    const accepted = api.submit({ text: '面板投递一件事', actor: 'operator' });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.result.kind, 'accepted');
    assert.equal(accepted.snapshot.counts.open, 1);
  });

  it('submit 对不在名单上的人返回 denied 而不是抛错', () => {
    seedConfig('act');
    const api = createPanelApi({ openDuty });
    const result = api.submit({ text: '陌生人投递', actor: 'stranger' });
    assert.equal(result.ok, false);
    assert.equal(result.result.kind, 'denied');
    assert.equal(result.result.reason, 'actor-not-allowed');
  });

  it('policy 切模式会落盘，并把新快照一起返回；同模式是幂等的', () => {
    seedConfig('observe');
    const api = createPanelApi({ openDuty });
    const switched = api.policy({ mode: 'act' });
    assert.equal(switched.changed, true);
    assert.equal(switched.snapshot.mode, 'act');
    assert.equal(openDuty().status().mode, 'act');

    const again = api.policy({ mode: 'act' });
    assert.equal(again.changed, false);
    assert.throws(() => api.policy({ mode: 'turbo' }), (error) => error.code === 'bad-mode');
  });

  it('report 关单；关已结的单返回 409', () => {
    seedConfig('act');
    const api = createPanelApi({ openDuty });
    const ticketId = api.submit({ text: '要被关掉', actor: 'operator' }).snapshot.tickets[0].id;
    const closed = api.report({ ticketId, outcome: 'done' });
    assert.equal(closed.ok, true);
    assert.equal(closed.snapshot.counts.open, 0);
    assert.equal(closed.snapshot.tickets[0].state, 'ended');

    assert.throws(
      () => api.report({ ticketId, outcome: 'done' }),
      (error) => error instanceof PanelError && error.status === 409,
    );
  });

  it('poll 用注入的假 gh 调用，结果原样回给面板', async () => {
    seedConfig('act');
    const duty = openDuty();
    duty.savePolicy({ ...duty.policy(), sources: { ...duty.policy().sources, github: { enabled: true, allowed: [{ id: 'operator' }] } } });

    const api = createPanelApi({
      openDuty,
      poll: async () => ({ asked: 'operator', mode: 'mentions', found: 2, accepted: 1, fanout: 0, duplicate: 1, denied: 0, deferred: 0 }),
    });
    const result = await api.pollOnce({});
    assert.equal(result.ok, true);
    assert.equal(result.stats.found, 2);
  });
});

describe('dispatchAction', () => {
  it('白名单外的方法一律 unknown-action（连原型成员也不行）', async () => {
    seedConfig('act');
    const api = createPanelApi({ openDuty });
    for (const action of ['nope', 'constructor', 'toString', '__proto__', '']) {
      await assert.rejects(
        () => dispatchAction(api, action, {}),
        (error) => error instanceof PanelError && error.code === 'unknown-action' && error.status === 404,
      );
    }
  });

  it('白名单动作会被调用，并带上 payload', async () => {
    seedConfig('act');
    const api = createPanelApi({ openDuty });
    const result = await dispatchAction(api, 'submit', { text: '经 dispatch 投递', actor: 'operator' });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.counts.open, 1);
  });
});
