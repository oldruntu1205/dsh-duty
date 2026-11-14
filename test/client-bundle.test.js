/**
 * 客户端 bundle 的「接线」测试。
 *
 * 它守不住像素，但守得住最容易悄悄坏掉的三件事：
 *   1. 文件必须是 window.__ModuleLoader__ 的 Lazy CJS 形式（写成 ESM 会在浏览器里直接抛）；
 *   2. 注册的 id / kind / guide 入口对得上——对不上，用户在右侧栏就找不到面板；
 *   3. 正文席位挂在 `sidebar.right.pane.tab` 且 key 等于类型 id（挂不上就是一张空 tab）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { describe, it, before } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');

describe('client.js', () => {
  let row;

  before(async () => {
    const source = readFileSync(clientPath, 'utf8');
    assert.ok(
      source.includes('window.__ModuleLoader__.load('),
      'client.js 必须走 window.__ModuleLoader__.load 包装，不能是 ESM',
    );
    assert.ok(!/^\s*import\s+/m.test(source), 'client.js 里不能出现顶层 import');

    globalThis.window = {
      __ModuleLoader__: {
        load(next) {
          row = next;
        },
      },
    };
    await import(`${pathToFileURL(clientPath).href}?v=${Date.now()}`);
    delete globalThis.window;
  });

  it('id 必须等于包名，并导出一个可调用的 apply', () => {
    assert.equal(row.id, 'dsh-duty');
    const fakeReact = {
      createElement: () => null,
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useCallback: (fn) => fn,
    };
    const mod = row.factory((id) => {
      assert.equal(id, 'react');
      return fakeReact;
    });
    assert.equal(mod.name, 'dsh-duty');
    assert.equal(typeof mod.apply, 'function');
    assert.equal(typeof mod.panel, 'function');
    assert.deepEqual([...mod.inject].sort(), ['sidebarRightTabs', 'slots']);
  });

  it('注册的 tab 类型与正文席位能对上（否则右侧栏里是一张空 tab）', () => {
    const fakeReact = {
      createElement: () => null,
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useCallback: (fn) => fn,
    };
    const mod = row.factory(() => fakeReact);

    const types = [];
    const seats = [];
    const effects = [];
    const ctx = {
      effect(fn, label) {
        effects.push(label);
        const disposer = fn();
        return disposer;
      },
      sidebarRightTabs: {
        register(definition) {
          types.push(definition);
          return () => {};
        },
      },
      slots: {
        register(options, component) {
          seats.push({ options, component });
          return () => {};
        },
      },
    };

    mod.apply(ctx);

    assert.equal(types.length, 1, '必须且只注册一个 tab 类型');
    const type = types[0];
    assert.equal(type.kind, 'duty');
    assert.equal(type.keepMounted, true);
    assert.equal(type.title(), '值班');
    assert.equal(type.guide.length, 1);
    assert.equal(type.guide[0].id, 'duty');
    assert.equal(type.guide[0].title(), '值班');
    assert.equal(typeof type.guide[0].description(), 'string');
    assert.equal(typeof type.guide[0].order, 'number');

    assert.equal(seats.length, 1, '必须且只注册一个正文席位');
    assert.equal(seats[0].options.name, 'sidebar.right.pane.tab');
    assert.equal(seats[0].options.key, type.id, '正文 seat 的 key 必须等于 tab 类型 id');
    assert.equal(seats[0].component, mod.panel);

    assert.equal(effects.length, 2, '两处注册都必须包在 ctx.effect 里（随插件卸载一起撤）');
  });
});
