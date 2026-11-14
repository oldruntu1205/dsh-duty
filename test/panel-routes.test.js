/**
 * 面板路由的 HTTP 契约测试（不需要 DSH）。
 *
 * 守的是浏览器与宿主之间那层最容易出错的边界：
 *   - 非 GET/POST 要 405，不是 404 也不是 500
 *   - 不同源（fence 拒）要 403，且在读请求体之前就拒
 *   - 未知动作要 404 + code，不能回落成 500
 *   - 坏 JSON / 超大 body 要 400 / 413
 *   - 成功响应的形状是 `{ ok, snapshot }` / `{ ok, ...result }`
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Readable } from 'node:stream';

import { Duty } from '../lib/duty.js';
import { createPanelApi } from '../lib/panel-api.js';
import { ACTION_PATH, STATE_PATH, makePanelRoutes } from '../lib/panel-routes.js';

let dir;
let stateFile;
let configFile;
let routes;

function openDuty() {
  return new Duty({ stateFile, configFile, defaultInboxDir: join(dir, 'inbox') }).load();
}

/** 最小的 IncomingMessage 替身：可 async iterate，带 method/headers。 */
function fakeRequest({ method = 'GET', body = null, headers = {} } = {}) {
  const payload = body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const stream = Readable.from(payload === '' ? [] : [Buffer.from(payload, 'utf8')]);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

/** 最小的 ServerResponse 替身：记下状态码、头与正文。 */
function fakeResponse() {
  const captured = { status: 0, headers: null, body: '' };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(text) {
      captured.body = text ?? '';
    },
  };
}

async function call(path, options) {
  const route = routes.find((entry) => entry.path === path);
  assert.ok(route, `没有注册 ${path}`);
  const response = fakeResponse();
  await route.handler(fakeRequest(options), response);
  const parsed = response.captured.body === '' ? null : JSON.parse(response.captured.body);
  return { ...response.captured, json: parsed };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duty-routes-'));
  stateFile = join(dir, 'state.jsonl');
  configFile = join(dir, 'config.json');
  const duty = openDuty();
  duty.saveConfig({
    defaultActor: 'operator',
    policy: {
      mode: 'act',
      sources: {
        inbox: { enabled: true, allowed: [{ id: 'operator' }] },
        github: { enabled: true, allowed: [] },
      },
      limits: { cooldownSeconds: 0, maxAcceptsPerActorPerHour: 0 },
      workspace: null,
    },
  });
  routes = makePanelRoutes({ api: createPanelApi({ openDuty }), fence: () => true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /duty/api/state', () => {
  it('200 + { ok, snapshot }，并带 no-store 头（面板不能读缓存）', async () => {
    const result = await call(STATE_PATH, { method: 'GET' });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(typeof result.json.snapshot.policyVersion, 'string');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['content-type'], /application\/json/);
  });

  it('非 GET → 405 且带 code', async () => {
    const result = await call(STATE_PATH, { method: 'POST', body: {} });
    assert.equal(result.status, 405);
    assert.equal(result.json.code, 'method-not-allowed');
  });
});

describe('POST /duty/api/action', () => {
  it('submit 成功：200 + 快照已更新', async () => {
    const result = await call(ACTION_PATH, {
      method: 'POST',
      body: { action: 'submit', payload: { text: '从面板投递', actor: 'operator' } },
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.snapshot.counts.open, 1);
  });

  it('未知动作 → 404 unknown-action（不是 500）', async () => {
    const result = await call(ACTION_PATH, { method: 'POST', body: { action: 'drop-database' } });
    assert.equal(result.status, 404);
    assert.equal(result.json.code, 'unknown-action');
    assert.equal(result.json.ok, false);
  });

  it('空正文 → 400 empty-text（业务错误原样回传给人看）', async () => {
    const result = await call(ACTION_PATH, { method: 'POST', body: { action: 'submit', payload: { text: ' ' } } });
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'empty-text');
  });

  it('坏 JSON → 400 bad-json；空 body 当作 {} 并因此报 unknown-action', async () => {
    const broken = await call(ACTION_PATH, { method: 'POST', body: '{not json' });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.code, 'bad-json');

    const empty = await call(ACTION_PATH, { method: 'POST', body: null });
    assert.equal(empty.status, 404);
    assert.equal(empty.json.code, 'unknown-action');
  });

  it('超大 body → 413 body-too-large', async () => {
    const big = JSON.stringify({ action: 'submit', payload: { text: 'x'.repeat(70 * 1024) } });
    const result = await call(ACTION_PATH, { method: 'POST', body: big });
    assert.equal(result.status, 413);
    assert.equal(result.json.code, 'body-too-large');
  });

  it('非 POST → 405', async () => {
    const result = await call(ACTION_PATH, { method: 'GET' });
    assert.equal(result.status, 405);
  });
});

describe('同源门禁', () => {
  it('fence 说不行 → 两条路由都 403，且不读 body、不改状态', async () => {
    const duty = openDuty();
    const fenced = makePanelRoutes({ api: createPanelApi({ openDuty }), fence: () => false });
    const stateRoute = fenced.find((r) => r.path === STATE_PATH);
    const actionRoute = fenced.find((r) => r.path === ACTION_PATH);

    const stateRes = fakeResponse();
    await stateRoute.handler(fakeRequest({ method: 'GET' }), stateRes);
    assert.equal(stateRes.captured.status, 403);

    const actionRes = fakeResponse();
    await actionRoute.handler(
      fakeRequest({ method: 'POST', body: { action: 'submit', payload: { text: '不该落盘' } } }),
      actionRes,
    );
    assert.equal(actionRes.captured.status, 403);
    assert.equal(JSON.parse(actionRes.captured.body).ok, false);
    assert.equal(openDuty().status().counts.open, duty.status().counts.open, '被拒的请求不能改状态');
  });
});
