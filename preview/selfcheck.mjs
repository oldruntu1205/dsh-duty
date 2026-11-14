/**
 * 重启后自检：不依赖 GUI，回答「面板到底有没有被宿主装载」。
 *
 * 三个检查，都是**可失败**的：
 *   1. 包接线：package.json 的 dsh.client / exports["./client"] / files 是否齐全
 *      （缺一条，宿主就根本不会把 client.js 发给浏览器）
 *   2. 客户端契约：client.js 必须是 Lazy CJS 包装、id 等于包名、能注册出 tab 类型与正文席位
 *   3. 宿主装载痕迹：~/.dsh/duty/duty.log 里最后一次 `dsh-duty mounted` 之后
 *      有没有 `panel routes mounted` —— 没有就是「宿主还在跑旧代码，需要托盘退出重开」
 *
 * 用法：
 *   node preview/selfcheck.mjs
 *   node preview/selfcheck.mjs --home <DSH_DUTY_HOME>
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const homeIndex = args.indexOf('--home');
const dutyHome =
  homeIndex >= 0 && args[homeIndex + 1]
    ? resolve(args[homeIndex + 1])
    : process.env.DSH_DUTY_HOME || join(homedir(), '.dsh', 'duty');

const results = [];
const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });

// ── 1. 包接线 ─────────────────────────────────────────────

function checkWiring() {
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  if (pkg.dsh?.client?.platform === 'web') pass('package.json · dsh.client.platform = web');
  else fail('package.json · dsh.client.platform', `实际是 ${JSON.stringify(pkg.dsh?.client?.platform)}`);

  const clientRel = pkg.exports?.['./client'];
  if (typeof clientRel === 'string' && existsSync(join(root, clientRel))) {
    pass('package.json · exports["./client"] 指向真实文件', clientRel);
  } else {
    fail('package.json · exports["./client"]', '缺失或指向不存在的文件');
  }

  if ((pkg.files ?? []).includes('client.js')) pass('package.json · files 含 client.js');
  else fail('package.json · files', '不含 client.js（发布/安装时会漏文件）');

  if (existsSync(join(root, pkg.dsh?.bundle?.patch ?? ''))) pass('package.json · bundle patch 存在');
  else fail('package.json · bundle patch', 'cordis.patch.yml 不存在');
}

// ── 2. 客户端契约 ─────────────────────────────────────────

async function checkClientBundle() {
  const source = readFileSync(join(root, 'client.js'), 'utf8');
  if (source.includes('window.__ModuleLoader__.load(')) pass('client.js · Lazy CJS 包装');
  else fail('client.js · Lazy CJS 包装', '缺少 window.__ModuleLoader__.load(...)');
  if (!/^\s*(import|export)\s/m.test(source)) pass('client.js · 无顶层 import/export');
  else fail('client.js · 无顶层 import/export', '浏览器里会直接抛语法错误');

  let row;
  globalThis.window = { __ModuleLoader__: { load(next) { row = next; } } };
  await import(`${pathToFileURL(join(root, 'client.js')).href}?v=${Date.now()}`);
  delete globalThis.window;
  if (!row) {
    fail('client.js · 注册了 factory', '没有调用 __ModuleLoader__.load');
    return;
  }
  if (row.id === 'dsh-duty') pass('client.js · id = 包名');
  else fail('client.js · id = 包名', `实际是 ${row.id}`);

  const fakeReact = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
  };
  const mod = row.factory(() => fakeReact);
  const types = [];
  const seats = [];
  mod.apply({
    effect: (fn) => fn(),
    sidebarRightTabs: { register: (def) => (types.push(def), () => {}) },
    slots: { register: (options, component) => (seats.push({ options, component }), () => {}) },
  });
  const type = types[0];
  if (type && type.kind === 'duty' && type.guide?.length === 1) pass('tab 类型可注册', `kind=${type.kind}`);
  else fail('tab 类型可注册', JSON.stringify(types));
  if (seats[0]?.options?.name === 'sidebar.right.pane.tab' && seats[0]?.options?.key === type?.id) {
    pass('正文席位键对齐', `key=${seats[0].options.key}`);
  } else {
    fail('正文席位键对齐', JSON.stringify(seats.map((s) => s.options)));
  }
  if (typeof mod.panel === 'function') pass('面板组件可渲染入口存在');
  else fail('面板组件', 'exports.panel 不是函数');
}

// ── 3. 宿主装载痕迹 ───────────────────────────────────────

function checkHostLog() {
  const logPath = join(dutyHome, 'duty.log');
  if (!existsSync(logPath)) {
    fail('宿主装载痕迹', `${logPath} 不存在（插件还没在这个 home 上跑过）`);
    return;
  }
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  const lastMount = lines.map((line, index) => ({ line, index })).filter((r) => r.line.includes('dsh-duty mounted')).at(-1);
  if (!lastMount) {
    fail('宿主装载痕迹', '日志里没有 `dsh-duty mounted`');
    return;
  }
  const after = lines.slice(lastMount.index);
  const mounted = after.find((line) => line.includes('panel routes mounted'));
  const failed = after.find((line) => line.includes('panel route registration FAILED'));
  if (mounted) {
    pass('宿主已挂上面板路由', mounted.trim());
  } else if (failed) {
    fail('宿主挂载面板路由失败', failed.trim());
  } else {
    fail(
      '宿主还在跑旧代码',
      '最后一条 `dsh-duty mounted` 之后没有 `panel routes mounted` —— 托盘右键「退出」再打开 DSH',
    );
  }
}

checkWiring();
await checkClientBundle();
checkHostLog();

const width = Math.max(...results.map((r) => r.name.length));
console.log('');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(width)}  ${result.detail ?? ''}`);
}
const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} 通过${failedCount === 0 ? '' : `，${failedCount} 项待处理`}\n`);
process.exitCode = failedCount === 0 ? 0 : 1;
