/**
 * 执行器（P2）：prompt 与 activation 请求的形状。
 * 不起真子代理——形状错了在这里就该红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WORKER_PRESET,
  WORKER_PROVIDER,
  buildActivationRequest,
  renderTicketPrompt,
} from '../lib/executor.js';
import { DEFAULT_TOOL_SCOPE } from '../lib/domain.js';

const ticket = {
  id: 'tkt_abc',
  title: '修一下导出按钮',
  state: 'open',
  dispatch: 'ready',
  toolScope: ['read', 'edit'],
  mandate: {
    actor: 'alice',
    sourceId: 'github',
    scope: 'propose',
    strength: 'explicit',
    policyVersion: 'pol_123',
  },
};

test('renderTicketPrompt：把授权范围写进正文（执行器看不到 Trigger）', () => {
  const text = renderTicketPrompt(ticket, { workspace: 'H:/work/x' });
  assert.match(text, /修一下导出按钮/);
  assert.match(text, /投递人：alice（来源：github）/);
  assert.match(text, /授权范围：propose/);
  assert.match(text, /策略版本：pol_123/);
  assert.match(text, /不要顺手扩大 scope/);
  assert.match(text, /H:\/work\/x/);
});

test('renderTicketPrompt：缺字段也不崩，落到占位值', () => {
  const text = renderTicketPrompt({});
  assert.match(text, /unknown/);
  assert.match(text, /propose/, '默认范围是 propose，不是 edit');
});

test('buildActivationRequest：形状与宿主 startActivation 的 request 对齐', () => {
  const parent = { fake: 'agent' };
  const request = buildActivationRequest({ ticket, parent, workspace: 'H:/work/x' });
  assert.equal(request.parent, parent);
  assert.equal(request.agentPreset, WORKER_PRESET);
  assert.equal(request.cwd, 'H:/work/x');
  assert.equal(request.prompt.length, 1);
  assert.equal(request.prompt[0].type, 'text');
  assert.match(request.prompt[0].text, /修一下导出按钮/);
});

test('buildActivationRequest：没有 workspace 时不传 cwd（继承父会话目录）', () => {
  const request = buildActivationRequest({ ticket, parent: {} });
  assert.equal('cwd' in request, false);
  assert.equal(buildActivationRequest({ ticket, parent: {}, workspace: '  ' }).cwd, undefined);
});

test('buildActivationRequest：没有 parent 直接抛，别派给空气', () => {
  assert.throws(() => buildActivationRequest({ ticket }), /需要 parent/);
});

test('provider 名与 preset 名是常量，不散落在各处', () => {
  assert.equal(WORKER_PROVIDER, 'spawn');
  assert.equal(WORKER_PRESET, 'duty-worker');
});

test('声明即实际：toolScope 里不能出现 preset 没给的（尤其是 web_search）', () => {
  // 2026-11-07 实测：声明 8 个、实际给 14 个，执行器当场指出不一致。
  // 这份清单是 cordis.patch.yml 里 duty-worker preset 的镜像，改一边必须改另一边。
  assert.equal(DEFAULT_TOOL_SCOPE.length, 13);
  assert.ok(!DEFAULT_TOOL_SCOPE.includes('web_search'), 'preset 已移除 tool-web，执行器不该有外网检索');
  for (const name of ['duty_work', 'duty_submit', 'local_hands', 'create_worktree', 'soul_update']) {
    assert.ok(!DEFAULT_TOOL_SCOPE.includes(name), `${name} 不该在执行器工具面里`);
  }
  for (const name of ['read', 'write', 'edit', 'grep', 'glob', 'pwsh', 'job_list', 'job_output']) {
    assert.ok(DEFAULT_TOOL_SCOPE.includes(name), `${name} 必须在`);
  }
});
