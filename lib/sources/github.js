/**
 * dsh-duty · GitHub 只读 Source
 *
 * 只调 `gh search issues`，**不写任何东西**：不评论、不开 PR、不 push。
 * 用现有账号即可（不需要第二个 GitHub 账号）——因为读的是「谁 @ 了我」，
 * 而不是「以我的名义发言」。
 *
 * 为什么用 `gh` 而不是 REST：`gh` 已经处理了认证、分页和 JSON 形状；
 * 只读命令失败也只会返回空结果，不会误改远端。
 *
 * 本文件不允许 import 任何 @deepseek-ai/*（link: 安装解析不到，见 README）。
 */

import { spawn } from 'node:child_process';

/** 只请求存在的字段：gh 对未知字段直接报错（比静默返回 undefined 好）。 */
export const GITHUB_FIELDS =
  'number,title,url,repository,author,updatedAt,state,isPullRequest,body';

export const GITHUB_MODES = Object.freeze(['mentions', 'involves']);

/**
 * 一条 GitHub 事件在领域里的线程 id：同一个 issue 的后续更新都归到同一线程，
 * 这样「第一次开单、之后只作为上下文扇出」才成立。
 */
export function githubThreadId(repoFullName, number) {
  return `github:${repoFullName}#${number}`;
}

/** 构造 `gh search issues` 的参数。纯函数，便于断言。 */
export function buildSearchArgs({ mode = 'mentions', me, limit = 20, search = '' } = {}) {
  if (!me) throw new Error('buildSearchArgs 需要 me（当前登录的 GitHub login）');
  const flag = mode === 'involves' ? '--involves' : '--mentions';
  // 未给 limit 时用默认 20；给了就夹到 1..100（0 或负数按 1 处理，不偷偷放大成 20）。
  const requested = limit === undefined || limit === null ? 20 : Number(limit);
  const effective = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 20;
  const args = [
    'search',
    'issues',
    flag,
    me,
    '--state',
    'open',
    '--limit',
    String(effective),
    '--json',
    GITHUB_FIELDS,
  ];
  if (typeof search === 'string' && search.trim() !== '') args.push('--search', search.trim());
  return args;
}

/** 把 gh 的 JSON 结果转成候选事件。仓库过滤在这里做，早于任何领域逻辑。 */
export function deriveCandidates(items, { repos = [] } = {}) {
  const allow = new Set(repos.filter((r) => typeof r === 'string' && r.includes('/')));
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const repo = item?.repository?.nameWithOwner;
    const number = item?.number;
    if (!repo || !number) continue;
    if (allow.size > 0 && !allow.has(repo)) continue;

    const updatedAt = String(item.updatedAt ?? '');
    const body = typeof item.body === 'string' ? item.body.slice(0, 2000) : '';
    const url = String(item.url ?? `https://github.com/${repo}/issues/${number}`);
    out.push({
      /** 每次 issue 更新是一个独立事件；同一 issue 的重复轮询不会重复开单。 */
      nativeId: `${repo}#${number}@${updatedAt}`,
      threadId: githubThreadId(repo, number),
      actor: item?.author?.login ?? 'unknown',
      isBot: item?.author?.is_bot === true,
      title: `${repo}#${number} ${String(item.title ?? '').trim()}`,
      text: [`${repo}#${number} ${String(item.title ?? '').trim()}`, url, '', body]
        .filter((line, i) => !(i === 2 && body === ''))
        .join('\n'),
      repo,
      number,
      updatedAt,
      url,
    });
  }
  return out;
}

/** 跑一次 gh，带超时。永不 reject：失败也返回可判读的结果。 */
export function runGh(args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gh', args, { windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: `spawn failed: ${error?.message ?? error}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
      finish({ code: null, stdout, stderr: stderr || 'gh timed out', timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      // 防御：异常巨大的输出不该把宿主内存吃光。
      if (stdout.length > 4 * 1024 * 1024) {
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on('error', (error) => finish({ code: null, stdout, stderr: String(error?.message ?? error) }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/**
 * 取当前登录的 GitHub login。只读，用于构造 --mentions / --involves。
 * 失败返回 null（调用方据此跳过本轮，而不是把插件带崩）。
 */
export async function resolveLogin({ run = runGh, timeoutMs = 15000 } = {}) {
  const result = await run(['api', 'user', '--jq', '.login'], { timeoutMs });
  if (result.code !== 0) return null;
  const login = result.stdout.trim();
  return /^[A-Za-z0-9-]+$/.test(login) ? login : null;
}
