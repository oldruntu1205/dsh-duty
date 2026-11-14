/**
 * dsh-duty · 面板路由（HTTP 细节层）
 *
 * 与宿主解耦：这里只依赖一个「注册形状」`{ kind, path, handler }`，
 * index.js 把它交给宿主 webServer，测试则直接调 handler —— 因此
 * 「返回什么 JSON / 什么情形 405·403·404」是可以脱离 DSH 跑的。
 *
 * 两条路由，没有第三条：
 *   GET  /duty/api/state   读快照（面板唯一的读契约）
 *   POST /duty/api/action  五个动作，白名单见 panel-api.js 的 ACTIONS
 */

import { PanelError, dispatchAction } from './panel-api.js';

export const STATE_PATH = '/duty/api/state';
export const ACTION_PATH = '/duty/api/action';

/** 单次请求体上限：面板只投递文本，64KB 已经非常宽。 */
const BODY_LIMIT = 64 * 1024;

export function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 逐块读请求体，超限立刻拒绝（不把整块读完再判断）。 */
export async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new PanelError('body-too-large', `请求体超过 ${limit} 字节`, 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PanelError('bad-json', '请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PanelError('bad-json', '请求体必须是一个对象');
  }
  return parsed;
}

/**
 * 造两条宿主路由。
 *
 * @param {object} options
 * @param {object} options.api createPanelApi 的返回值
 * @param {(req: object) => boolean} options.fence 同源/鉴权门禁
 * @param {(line: string) => void} [options.log] 内部错误日志
 * @returns {{kind: 'exact', path: string, handler: Function}[]}
 */
export function makePanelRoutes({ api, fence, log = () => {} }) {
  const respondError = (res, error) => {
    const known = error instanceof PanelError;
    const status = known ? error.status : 500;
    const code = known ? error.code : 'internal';
    const message = known ? error.message : String(error?.message ?? error);
    if (!known) log(`panel api failed: ${message}`);
    writeJson(res, status, { ok: false, code, message });
  };

  return [
    {
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (!fence(req)) {
          writeJson(res, 403, { ok: false, code: 'forbidden', message: 'forbidden' });
          return;
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只接受 GET' });
          return;
        }
        try {
          const result = await dispatchAction(api, 'state', {});
          writeJson(res, 200, { ok: true, snapshot: result.snapshot });
        } catch (error) {
          respondError(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ACTION_PATH,
      handler: async (req, res) => {
        if (!fence(req)) {
          writeJson(res, 403, { ok: false, code: 'forbidden', message: 'forbidden' });
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只接受 POST' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await dispatchAction(api, String(body.action ?? ''), body.payload ?? {});
          writeJson(res, 200, { ok: result.ok !== false, ...result });
        } catch (error) {
          respondError(res, error);
        }
      },
    },
  ];
}
