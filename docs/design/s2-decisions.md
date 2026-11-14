# dsh-duty · S2 裁决回写（L1 两轮）

> 日期：2026-11-14　切片：S2
> 送审：`_evidence/S2-SPEC-20261114.md` → 回执 `_evidence/l1_reply_S2_20261114.md`（ACCEPT-WITH-CHANGES）
> 追加：`_evidence/S2-SPEC-Q4-20261114.md` → 回执 `_evidence/l1_reply_S2_Q4_20261114.md`（A，撤回 Q4 前置授权要求）

## 一、裁决 vs 送审初稿：五处被改

| # | 我的初稿 | L1 裁决 | 落地结果 |
|---|---|---|---|
| 1 | `types.dispatch ∈ {inherit, act, observe, hold}` | **删掉 `act`**：`policy.mode` 已是全局上限，类型再加 `act` = 允许局部越权 | `DISPATCH_MODES = [inherit, observe, hold]`；`resolveDispatch()` 里 `mode !== 'act'` 一律不得产出 `ready` |
| 2 | 非法 type → 回落 `task.manual` | **必须拒收**，不得降级 | `Duty.submit()` 返回 `route.kind='denied', reason='bad-type'`，不建单 |
| 3 | fanout 前置 source/actor 鉴权（我按 Q4 准备改） | **二次裁定 A：撤回**。fanout 只写处置记录、不碰 ticket，原语义保留 | `route()` 顺序不变；`test/domain.test.js` T2 未被动 |
| 4 | `auth.mode ∈ {none, allowlist, hmac}` | 收敛成 **`{none, hmac}`**：allowlist 与 actor 白名单同名同义，会把「谁的人」和「怎么证明」混在一起 | 只实现两种 |
| 5 | 内置高危 7 项 | 补 `change.direction`，**共 8 项**；优先级固定为「精确 → 内置 → `*` → inherit」；通配不得解除 | `DEFAULT_HOLD_TYPES` 8 项 + `resolveDispatch()` 按该优先级 |

## 二、采纳但未被初稿写清的（L1 补的硬要求）

- **写入严格 / 读盘宽容**：`validatePolicy()` 对 `dispatch:'act'`、未知值、非法类型名必须报错且不落盘；`normalizePolicy()` 读盘时丢弃坏值不崩。
- **held 不因改策略释放**：`dispatch` 随授权快照冻结；本轮不提供放行入口，`claim()` 返回 `held-needs-person`。
- **关联权限**：跨源关联要求同源或同 actor，否则 `correlation-not-authorized`，**不得静默另开单**。
- **签名覆盖原始 body 字节**：不得重序列化后验签；`body` 必须是字符串（对象身份无法逐字节复现）。
- **fail-closed**：缺密钥 / 空密钥 / 时间戳非法 / 超窗 / 签名错，一律拒收，**绝不回落 `none`**。
- **不得做的事**（已遵守）：不改 `triggerId`/`ticketId` 算法、不重写历史 JSONL、不批量重算既有授权、不新增公网监听、不把 secret 写进配置/日志/工单。

## 三、本轮明确没做（范围外，不是遗漏）

| 项 | 原因 |
|---|---|
| held 的人工放行入口 | L1：「本轮若不做批准入口，就明确 held 暂不可释放」——避免半成品放行路径绕过快照 |
| nonce 表 | L1 裁决可接受用「nativeId 幂等 + 时间窗」扛重放 |
| 公网 Webhook HTTP 入口 | L1 明令不得新增公网监听；改用文件信封形式 |
| 执行器/面板自动按 type 选模型 | 属 `routing.json` 消费侧，不在 duty 插件职责内 |

## 四、验证

- `node --test` → **94 passed / 0 failed**（原 74 + S2 新增 20，`test/s2-type-policy.test.js`）。
- 真实数据只读冒烟（`~/.dsh/duty/state.jsonl` 5 张历史工单）：全部投影为 `type=task.manual`、`link=null`，**ID 与 dispatch 未变**。
- 既有 `test/domain.test.js` T2（授权与上下文分离）**未修改**，仍通过。
