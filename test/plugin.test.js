/**
 * 插件外壳冒烟测试 —— 不装进宿主也能验证「形状对不对」。
 *
 * 用一个假 ctx 覆盖：export 名/inject、工具注册、定时器注册、一次真实工具调用。
 * 跑法：node --test test/
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'dsh-duty-home-'));
process.env.DSH_DUTY_HOME = home;

const plugin = await import('../index.js');

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeCtx() {
  const tools = [];
  const intervals = [];
  const routes = [];
  return {
    tools: { register: (def) => tools.push(def) },
    interval: (fn, ms) => {
      intervals.push({ fn, ms });
      return () => {};
    },
    on: () => {},
    // 宿主的 ctx.inject：服务就绪时回调，这里立刻给一个假的 webServer 作用域。
    inject: (deps, callback) => {
      if (!deps.includes('webServer')) return;
      callback({
        webServer: {
          register: (route) => {
            routes.push(route);
            return () => {};
          },
        },
        effect: (fn) => fn(),
      });
    },
    _tools: tools,
    _intervals: intervals,
    _routes: routes,
  };
}

test('插件导出 name / inject / apply', () => {
  assert.equal(plugin.name, 'dsh-duty');
  assert.deepEqual(plugin.inject, ['tools', 'timer']);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply 注册 5 个工具 + 2 个定时器（收件箱 + GitHub），且不重复', () => {
  const ctx = fakeCtx();
  plugin.apply(ctx);
  const names = ctx._tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'duty_claim',
    'duty_policy',
    'duty_poll',
    'duty_report',
    'duty_status',
    'duty_submit',
    'duty_work',
  ]);
  assert.equal(ctx._intervals.length, 2, '一个扫收件箱，一个轮询 GitHub');
  assert.equal(ctx._intervals[0].ms, 60000);
  assert.equal(ctx._intervals[1].ms, 180000);

  // 每个工具都必须带**编译后的** JSON Schema（required 是根上的数组）
  for (const tool of ctx._tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name} 缺 required 数组`);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('回归：每个工具都必须声明 output.schema（宿主 register 会校验，缺了直接拒注册）', () => {
  // 2026-11-07 实测根因：dsh-tools 的 register() 调 assertSupportedJsonSchema(definition.output.schema)，
  // 只给 output.render 会抛 "unsupported JSON schema: schema must be a schema object"，
  // 五个工具全部注册失败（driving log 里五条 registration FAILED）。
  const ctx = fakeCtx();
  plugin.apply(ctx);

  const ALLOWED_KEYWORDS = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'description', 'title', 'default', 'examples',
  ]);
  const walk = (schema, path) => {
    assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${path} 不是 schema 对象`);
    for (const key of Object.keys(schema)) {
      assert.ok(ALLOWED_KEYWORDS.has(key), `${path} 用了宿主不支持的 key: ${key}`);
    }
    for (const [name, sub] of Object.entries(schema.properties ?? {})) walk(sub, `${path}.${name}`);
    if (schema.items) walk(schema.items, `${path}[]`);
  };

  for (const tool of ctx._tools) {
    assert.ok(tool.output, `${tool.name} 缺 output`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 output.render`);
    assert.ok(tool.output.schema, `${tool.name} 缺 output.schema —— 宿主会拒绝注册`);
    assert.equal(tool.output.schema.type, 'object', `${tool.name} 的 output.schema 必须是对象根`);
    walk(tool.output.schema, `${tool.name}.output.schema`);
  }
});

test('工具链路：提交 → 状态 → 领取（observe 下被拒）→ 切 act → 领取 → 回报', async () => {
  const ctx = fakeCtx();
  plugin.apply(ctx);
  const tool = (n) => ctx._tools.find((t) => t.name === n);

  // 首次 apply 会生成默认配置（allowed=[operator], mode=observe）
  const submitted = await tool('duty_submit').execute({ text: '帮我查一下导出按钮为什么不灵' }, {});
  assert.equal(submitted.ok, true, 'ok 表示「受理成功」，不等于「会派工」');
  assert.match(submitted.text, /仅记录/);

  const statusText = (await tool('duty_status').execute({}, {})).text;
  assert.match(statusText, /模式：observe/);
  assert.match(statusText, /需要人处理 1 件/);

  const claim = await tool('duty_claim').execute({}, {});
  assert.equal(claim.ok, false);
  assert.match(claim.summary, /observe-mode/);

  const policy = await tool('duty_policy').execute({ mode: 'act' }, {});
  assert.equal(policy.ok, true);

  // observe 期受理的工单不会被「切到 act」追认：授权快照冻结了 dispatch
  const stillObserved = await tool('duty_claim').execute({}, {});
  assert.equal(stillObserved.ok, false);
  assert.match(stillObserved.summary, /observed-only/);

  // 切到 act 之后新投递的才可派工
  const second = await tool('duty_submit').execute({ text: '再查一次导出按钮', nativeId: 'second.md' }, {});
  assert.equal(second.ok, true);
  assert.match(second.text, /可派工/);

  const claimed = await tool('duty_claim').execute({}, {});
  assert.equal(claimed.ok, true);
  assert.match(claimed.text, /授权快照/);

  const ticketId = /工单 (tkt_[0-9a-f]+)/.exec(claimed.text)[1];
  const reported = await tool('duty_report').execute({ ticketId, text: '已修好', outcome: 'done' }, {});
  assert.equal(reported.ok, true);
  assert.match(reported.text, /状态：ended/);
});

test('面板：apply 会挂两条路由，且经它们能读到快照、投递一件事', async () => {
  const { Readable } = await import('node:stream');
  const ctx = fakeCtx();
  plugin.apply(ctx);

  assert.deepEqual(
    ctx._routes.map((r) => r.path).sort(),
    ['/duty/api/action', '/duty/api/state'],
    '面板只允许这两条路由',
  );
  for (const route of ctx._routes) assert.equal(route.kind, 'exact');

  const call = async (path, { method, body }) => {
    const route = ctx._routes.find((r) => r.path === path);
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
    stream.method = method;
    stream.headers = {};
    const captured = { status: 0, body: '' };
    await route.handler(stream, {
      writeHead: (status) => {
        captured.status = status;
      },
      end: (text) => {
        captured.body = text ?? '';
      },
    });
    return { ...captured, json: captured.body === '' ? null : JSON.parse(captured.body) };
  };

  const before = (await call('/duty/api/state', { method: 'GET' })).json.snapshot.counts.open;
  const stateResponse = await call('/duty/api/state', { method: 'GET' });
  assert.equal(stateResponse.status, 200);
  assert.equal(stateResponse.json.ok, true);
  assert.equal(stateResponse.json.snapshot.counts.open, before);

  const submitted = await call('/duty/api/action', {
    method: 'POST',
    body: { action: 'submit', payload: { text: '从面板投递的活儿', nativeId: 'panel-test.md' } },
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.ok, true);
  assert.equal(submitted.json.snapshot.counts.open, before + 1);
  assert.ok(
    submitted.json.snapshot.tickets.some((t) => t.title.includes('从面板投递的活儿')),
    '面板拿到的快照里必须能看到刚投的那一条',
  );
});

test('坏配置不打死插件：config.json 写坏后 apply 仍能挂上', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(home, 'config.json'), '{ 坏掉的 json', 'utf8');
  const ctx = fakeCtx();
  assert.doesNotThrow(() => plugin.apply(ctx));
  assert.equal(ctx._tools.length, 7);
});
