/**
 * 面板预览渲染器（不参与插件运行，只给「看得见」用）。
 *
 * 做的事：
 *   1. 用**真实**的 Duty + panelSnapshot 造一份快照（不手写形状，免得预览比现实好看）
 *   2. 用 client.js 里**真实**的 DutyPanel 组件，配真实 React 18，SSR 出静态标记
 *   3. 输出两份 HTML（深色 / 浅色），交给 Chrome headless 截图
 *
 * 用法：
 *   node preview/render.mjs
 *   # 可选：REACT_DIR=<含 react 与 react-dom 的 node_modules>（默认取 DSH profile 里那份）
 */

import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Duty } from '../lib/duty.js';
import { panelSnapshot } from '../lib/panel-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, '_evidence');

// ── 真实 React ────────────────────────────────────────────
const reactDir = process.env.REACT_DIR || join(homedir(), '.dsh', 'profiles', 'node_modules');
const reactRequire = createRequire(join(reactDir, 'index.js'));
const react = reactRequire('react');
const { renderToStaticMarkup } = reactRequire('react-dom/server');

// ── 造一份真实快照 ────────────────────────────────────────
function buildSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), 'duty-preview-'));
  const stateFile = join(dir, 'state.jsonl');
  const configFile = join(dir, 'config.json');
  const open = () => new Duty({ stateFile, configFile, defaultInboxDir: join(dir, 'inbox') }).load();

  const base = Date.now() - 3 * 3600_000;
  let clock = base;
  /** 虚拟时钟：同一 moment 内的多次 now() 返回同一时刻，便于稳定复现。 */
  const virtualNow = () => clock;
  const at = (offsetMs) => {
    clock = base + offsetMs;
    return virtualNow;
  };

  const boot = new Duty({ stateFile, configFile, defaultInboxDir: join(dir, 'inbox'), now: virtualNow }).load();
  boot.saveConfig({
    defaultActor: 'operator',
    policy: {
      mode: 'act',
      sources: {
        inbox: { enabled: true, allowed: [{ id: 'operator' }] },
        github: { enabled: true, allowed: [{ id: 'operator' }] },
      },
      limits: { cooldownSeconds: 300, maxAcceptsPerActorPerHour: 6 },
      workspace: null,
    },
  });

  // 三张 act 期工单：第一张派给执行器在跑、第二张可派、第三张跑完关掉
  let duty = open();
  duty.now = at(11 * 60_000);
  const running = duty.submit({ text: '把 v3.2 的成交明细表格改成固定表头 + 40 行滚动，并截图验证。', actor: 'operator' }).ticket;
  duty.now = at(18 * 60_000);
  const ready = duty.submit({
    text: '检查 ~/.dsh/duty/inbox 的扫描是否会在 DSH 重启后补扫（漏了一批 .md 的情况）。',
    actor: 'operator',
  }).ticket;
  duty.now = at(24 * 60_000);
  const finished = duty.submit({ text: '把 GitHub mentions 的轮询间隔从 180s 调到 300s 并观察两轮。', actor: 'operator' }).ticket;
  duty.now = at(25 * 60_000);
  duty.assign(running.id, { executorId: 'spawn' });
  duty.recordChild(running.id, 'sa_9f2c41');
  duty.report({ ticketId: finished.id, outcome: 'done', text: '已改配置并观察两轮：found=0 / found=2，行为符合预期。' });

  // 切到 observe 再投一件：这就是「需要人处理」那条
  duty = open();
  duty.now = at(150 * 60_000);
  duty.savePolicy({ ...duty.policy(), mode: 'observe' });
  duty.now = at(155 * 60_000);
  const observed = duty.submit({
    text: '给面板补一个「按工单筛选」的输入框，只过滤客户端、不改宿主接口。',
    actor: 'operator',
  }).ticket;

  duty = open();
  duty.now = virtualNow;
  const snapshot = panelSnapshot(duty, { now: () => base + 3 * 3600_000 });

  return { snapshot, ids: { running: running.id, ready: ready.id, finished: finished.id, observed: observed.id }, dir };
}

// ── 载入真实组件 ──────────────────────────────────────────
async function loadPanel() {
  let row;
  globalThis.window = {
    __ModuleLoader__: {
      load(next) {
        row = next;
      },
    },
  };
  await import(`${pathToFileURL(join(root, 'client.js')).href}?v=${Date.now()}`);
  delete globalThis.window;
  const mod = row.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`预览只提供 react，收到 ${id}`);
  });
  return mod.panel;
}

function page(theme, markup) {
  const dark = theme === 'dark';
  const pageBg = dark ? '#1b1d22' : '#ffffff';
  const panelBg = dark ? '#1f2228' : '#fbfbfc';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-duty 面板预览 · ${theme}</title>
<style>
  html,body{margin:0;padding:0;background:${pageBg};}
  body{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:${dark ? '#e6e8ec' : '#1f2329'};}
  .shell{display:flex;justify-content:flex-end;min-height:100vh;}
  .conversation{flex:1;padding:22px;color:${dark ? '#6b7280' : '#9aa0a6'};font-size:12px;}
  .column{flex:0 0 372px;width:372px;box-sizing:border-box;background:${panelBg};border-left:1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};}
  .caption{font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:10px 14px 0;color:${dark ? '#6b7280' : '#9aa0a6'};}
</style></head>
<body><div class="shell">
  <div class="conversation"><div class="caption">session · 右侧栏「值班」面板（${theme}）</div>
    <p>这里模拟右侧栏在会话旁的宽度（372px）。面板内容全部来自 /duty/api/state 的快照。</p></div>
  <div class="column">${markup}</div>
</div></body></html>`;
}

const { snapshot, ids, dir } = buildSnapshot();
const Panel = await loadPanel();
const markup = renderToStaticMarkup(react.createElement(Panel, { initialSnapshot: snapshot }));

mkdirSync(outDir, { recursive: true });
for (const theme of ['dark', 'light']) {
  const file = join(outDir, `panel-preview-${theme}.html`);
  writeFileSync(file, page(theme, markup), 'utf8');
  console.log(`wrote ${file}`);
}
writeFileSync(join(outDir, 'panel-preview-fixture.json'), JSON.stringify({ snapshot, ids }, null, 2), 'utf8');
console.log(`fixture: open=${snapshot.counts.open} observed=${snapshot.counts.observed} running=${snapshot.counts.running} ended=${snapshot.counts.ended}`);
rmSync(dir, { recursive: true, force: true });
