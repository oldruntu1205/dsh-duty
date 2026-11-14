/**
 * 执行器工具面过滤：把 restrict 真正调出去，而不是"写了没生效"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WORKER_DENY, apply, parseKnownTools } from '../lib/tool-filter.js';

function fakeCtx() {
  const calls = [];
  return {
    tools: { restrict: (filter) => calls.push(filter) },
    _calls: calls,
  };
}

test('apply 会调用 tools.restrict，且带上高危面', () => {
  const ctx = fakeCtx();
  apply(ctx);
  assert.equal(ctx._calls.length, 1);
  const deny = ctx._calls[0].deny;
  for (const name of ['duty_work', 'duty_submit', 'soul_update', 'agent_teams_create', 'mnemon_remember', 'local_hands', 'create_worktree']) {
    assert.ok(deny.includes(name), `应该 deny ${name}`);
  }
  assert.equal(deny.length, WORKER_DENY.length);
});

test('apply 不能白名单化（allow 一旦给出会连 preset 自己的工具一起砍掉）', () => {
  const ctx = fakeCtx();
  apply(ctx);
  assert.equal('allow' in ctx._calls[0], false, '只 deny，不 allow');
});

test('没有 tools 服务时 fail-closed：拒绝起一个没有约束的执行器', () => {
  assert.throws(() => apply({}), /tools 服务不可用/);
  assert.throws(() => apply({ tools: {} }), /tools 服务不可用/);
});

test('restrict 自己抛错时不吞（作用域不对就该让派工失败）', () => {
  const ctx = {
    tools: {
      restrict: () => {
        throw new Error('tools.restrict() requires a scoped context');
      },
    },
  };
  assert.throws(() => apply(ctx), /scoped context/);
});

test('deny 名单不重复', () => {
  assert.equal(new Set(WORKER_DENY).size, WORKER_DENY.length);
});

test('parseKnownTools：从宿主报错里取回可收敛集合', () => {
  const known = parseKnownTools(
    'tools.restrict() names unknown global tool "duty_work"; known global tools: agent_teams_create, soul_update, (none)',
  );
  assert.deepEqual([...known], ['agent_teams_create', 'soul_update', '(none)']);
  assert.equal(parseKnownTools('别的错'), null);
  assert.deepEqual([...parseKnownTools('known global tools: (none)')], []);
});

test('遇到不认识的工具名时做交集重试，而不是整单失败', () => {
  const calls = [];
  const ctx = {
    tools: {
      restrict: (filter) => {
        calls.push(filter);
        if (calls.length === 1) {
          throw new Error(
            'tools.restrict() names unknown global tools "duty_work", "duty_submit"; known global tools: agent_teams_create, soul_update',
          );
        }
      },
    },
  };
  const result = apply(ctx);
  assert.equal(calls.length, 2, '第一次抛错后重试一次');
  assert.deepEqual(calls[1].deny, ['agent_teams_create', 'soul_update']);
  assert.equal(result.denied, 2);
  assert.ok(result.skipped.includes('duty_work'), 'duty_* 被跳过，交给运行时兜底');
  assert.ok(result.skipped.includes('duty_submit'));
});
