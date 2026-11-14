/**
 * dsh-duty · 执行器（P2）
 *
 * 把一个工单派给**独立的子 Session**，由 `duty-worker` preset 决定工具面。
 * 这里只做两件事：拼 prompt、拼 activation 请求。真正的 spawn 由宿主
 * 的 `ctx.subagents.startActivation` 完成（见 index.js）。
 *
 * 为什么不自己管 Session：宿主已经有 subagent 后端（`provider: spawn`），
 * 它负责创建子 Agent、独立 session、独立系统提示、零父上下文继承。
 * 自己再造一套只会跟宿主的分页/压缩/权限打架。
 */

/** 执行器 preset 的 id，必须与 cordis.patch.yml 里的 `config.id` 一致。 */
export const WORKER_PRESET = 'duty-worker';

/** 子代理提供者名：宿主内置的 in-process spawn 后端。 */
export const WORKER_PROVIDER = 'spawn';

/**
 * 拼给执行器的工单文本。
 *
 * 刻意把「授权范围」和「预算」写进 prompt：执行器看不到 Trigger，只能看到 Mandate，
 * 所以它必须从这段文字里知道自己被允许做到哪一步、可以用掉多少动作。
 *
 * 为什么要有预算：agent preset 只加工具不减全局工具，执行器仍继承完整人设与 AGENTS.md，
 * 它天然倾向于做"完整调查"。2026-11-07 实测：一张"只回答两个问题"的窄单，执行器跑了
 * 250+ 事件、10 分钟没停。prompt 是唯一能压住它的东西，所以写死预算和停止条件。
 */
export function renderTicketPrompt(ticket, { workspace = null } = {}) {
  const mandate = ticket?.mandate ?? {};
  const lines = [
    `你被派了一张值班工单（${ticket?.id ?? 'unknown'}）。`,
    '',
    `## 标题`,
    String(ticket?.title ?? '').trim(),
    '',
    `## 请求原文（这才是要你做的事）`,
    String(ticket?.text ?? '').trim() || '（投递方没有提供正文，只有标题）',
    '',
    '## 这是一张窄工单，不是开放式调查',
    '- 只做本工单要求的事。**不要**顺手读无关文件、跑无关命令、查看系统状态或其它工单。',
    '- 工具调用预算：**不超过 8 次**。到不了结论就停下，说清卡在哪。',
    '- 同一件事不要反复验证：已有证据就下结论。',
    '- **完成后立刻结束本轮**，用一段话汇报：做了什么 / 怎么验证的 / 有什么遗留风险。',
    '- **不要调用 `duty_*` 系列工具**（会被运行时拒绝）：派工、投递、改策略都是主会话的职责。',
    '- 不要起子代理，不要改本工单范围之外的文件。',
    '',
    '## 授权',
    `- 投递人：${mandate.actor ?? 'unknown'}（来源：${mandate.sourceId ?? 'unknown'}）`,
    `- 授权范围：${mandate.scope ?? 'propose'}（propose=只提议、不动文件；edit=可改工作区；run=可执行命令）`,
    `- 授权强度：${mandate.strength ?? 'explicit'}`,
    `- 策略版本：${mandate.policyVersion ?? 'unknown'}`,
    '',
    '## 边界',
    '- 只做这张工单范围内的事，不要顺手扩大 scope。',
    '- 做不到、或需要人拍板时，直接说明卡在哪，不要绕过去。',
  ];
  if (workspace) lines.push('', '## 工作区', workspace);
  if (Array.isArray(ticket?.toolScope) && ticket.toolScope.length > 0) {
    lines.push('', '## 执行器工具面（声明即实际）', ticket.toolScope.join(', '));
  }
  return lines.join('\n');
}

/**
 * 构造 `ctx.subagents.startActivation` 的 request。
 * 纯函数，便于断言形状而不真起子代理。
 */
export function buildActivationRequest({ ticket, parent, workspace = null }) {
  if (!parent) throw new Error('buildActivationRequest 需要 parent（调用方的 agent）');
  const request = {
    prompt: [{ type: 'text', text: renderTicketPrompt(ticket, { workspace }) }],
    parent,
    agentPreset: WORKER_PRESET,
  };
  if (typeof workspace === 'string' && workspace.trim() !== '') request.cwd = workspace;
  return request;
}
