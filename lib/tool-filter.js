/**
 * dsh-duty · 执行器工具面过滤（P2 真裁剪）
 *
 * 为什么需要这个插件：agent preset 的 `plugins` 只能决定「挂哪些 agent 级工具」，
 * **收不回 profile bundle 级插件注册进全局工具表的工具**（AgentTeams / Mnemon / Soul /
 * Memory / duty 自己）。实测：执行器拿到 61 个工具，其中 49 个不属于它的工单。
 *
 * 宿主确实提供了收敛手段 —— `@deepseek-ai/dsh-subagent` 的 `applyChildOverrides()` 里：
 *     if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);
 * 但 `startActivation` 的 composition 只从 request 取 `agentPreset`，**透传不了 toolFilter**。
 * 所以改成：把本插件放进 preset 的 plugins 里，在 agent 作用域内直接调 `ctx.tools.restrict()`。
 *
 * 失败即拒绝（fail-closed）：部署不了过滤，就不要起一个全权执行器。
 *
 * 依赖纪律：不 import 任何 @deepseek-ai/*（link: 安装解析不到）。
 */

export const name = 'duty-tool-filter';

/** `tools` 服务是硬依赖；没有它本插件毫无意义，挂不上就说明装错了。 */
export const inject = ['tools'];

/**
 * 执行器**不该**有的工具。
 *
 * 只列 profile 级（全局）工具：这些在 preset 挂载前就已注册，`restrict()` 认得；
 * preset 自己提供的工具（read/write/pwsh/...）不在此列，免得因为「还没注册」被判未知而抛。
 */
export const WORKER_DENY = Object.freeze([
  // 递归派工 / 改策略：执行器不能给自己开单
  'duty_status',
  'duty_submit',
  'duty_claim',
  'duty_report',
  'duty_policy',
  'duty_poll',
  'duty_work',
  // 团队编排：执行器不是队长
  'agent_teams_add_member',
  'agent_teams_amend_task',
  'agent_teams_approve',
  'agent_teams_claim_task',
  'agent_teams_create',
  'agent_teams_create_task',
  'agent_teams_delete',
  'agent_teams_edit_plan',
  'agent_teams_reassign_task',
  'agent_teams_remove_member',
  'agent_teams_resume',
  'agent_teams_send_message',
  'agent_teams_status',
  'agent_teams_update_task',
  // 长期记忆写入：执行器不该改用户的记忆
  'memory_append',
  'memory_read',
  'memory_rewrite',
  'memory_search',
  'mnemon_document_create',
  'mnemon_document_manage',
  'mnemon_document_search',
  'mnemon_forget',
  'mnemon_link',
  'mnemon_memory_bodies',
  'mnemon_memory_body_create',
  'mnemon_memory_body_merge',
  'mnemon_memory_body_update',
  'mnemon_recall',
  'mnemon_related',
  'mnemon_remember',
  'mnemon_runtime_memory',
  'mnemon_status',
  'mnemon_subagent_result',
  'mnemon_view_action',
  'mnemon_view_route',
  // 人设 / 记忆卡：执行器不该改自己的身份
  'soul_read',
  'soul_update',
  // 再起子代理 / 建工作树：一层就够，不要套娃
  'local_hands',
  'create_worktree',
  'load_workspace_dependencies',
]);

/**
 * @param {object} ctx - agent 作用域的 Cordis 上下文（由 preset 挂载时注入）
 * @param {object} [config] - 可选覆盖（测试/调试用）
 */
export function apply(ctx, config = {}) {
  const desired = Array.isArray(config.deny) ? config.deny : [...WORKER_DENY];
  const tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : undefined);
  if (!tools || typeof tools.restrict !== 'function') {
    throw new Error('duty-tool-filter: tools 服务不可用，拒绝起一个没有工具面约束的执行器');
  }

  try {
    // 作用域不对时 restrict 会抛；这是故意的 —— 宁可这张单派不出去，也不要放一个全权执行器。
    tools.restrict({ deny: desired });
    return { denied: desired.length, skipped: [] };
  } catch (error) {
    // 不同 profile 装的插件不一样，「全局工具」集合随之不同；restrict 对不认识的名字直接抛。
    // 2026-11-07 实测：duty_* 不在可收敛集合里（它们由 duty 插件自己按 agent 作用域注册），
    // 所以这里按宿主回报的 known 集合做交集，剩下的交给 duty 工具内部的运行时兜底。
    const known = parseKnownTools(error?.message);
    if (known === null) throw error;

    const deny = desired.filter((name) => known.has(name));
    const skipped = desired.filter((name) => !known.has(name));
    if (deny.length === 0) throw error;

    tools.restrict({ deny });
    const warn = ctx.logger?.warn ?? ctx.logger?.info;
    if (typeof warn === 'function') {
      warn.call(ctx.logger, `duty-tool-filter: ${skipped.length} 个名字不在本 profile 的可收敛集合里，已跳过：${skipped.join(', ')}`);
    }
    return { denied: deny.length, skipped };
  }
}

/** 从 restrict 的报错里取出「本 profile 认识哪些全局工具」。 */
export function parseKnownTools(message) {
  const match = /known global tools:\s*([\s\S]*)$/.exec(String(message ?? ''));
  if (match === null) return null;
  const text = match[1].trim();
  if (text === '' || text === '(none)') return new Set();
  return new Set(text.split(',').map((name) => name.trim()).filter((name) => name !== ''));
}
