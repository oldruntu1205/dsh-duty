# dsh-duty · S2 送审稿：type / link / 按类型授权 / 跨源关联 / 来源鉴权

> 送审对象：L1（只做判断，**不要探索仓库**；所需事实全在本文，追代码由实现方负责）
> 仓库：`dsh-duty`（本地插件，`node --test` 74 条断言）
> 日期：2026-11-14　切片：S2

## 0. 一句话目标

给事件加「业务类型 + 回链」，让 `routing.json` 能查表；把「高风险类型必须人批」从纪律变成结构；多源接入前先立规矩。

## 1. 现状事实（已由实现方核对，行号可查）

- `Trigger` 字段：`id / sourceId / kind / nativeId / actor / text / title / threadId / at`（`lib/domain.js` L72–93）。
- `triggerId = sha256(sourceId + "\0" + nativeId)`，**刻意不含 kind**（L54–64，注释写明 2026-11-07 踩过 kind 进哈希导致幂等失效）。
- `route()` 顺序：duplicate → fanout（仅 `kind==='message' && threadId` 命中在跑工单）→ gate → evaluate（L149–163）。
- `gate()` 顺序：source-off → actor-not-allowed（该源白名单）→ thread-cooldown → actor-rate-limit（L115–139）。
- `accept()`：mandate 冻结 `policyVersion`；`ticket.id = sha256(triggerId + policyVersion)`；`dispatch = mode==='act' ? 'ready' : 'observed'`（L171–212）。
- 策略形状：`{ mode: 'act'|'observe', sources: { <id>: { enabled, allowed: [{id}] } }, limits: { cooldownSeconds, maxAcceptsPerActorPerHour }, workspace }`（`lib/policy.js` L10–63）。
- 存储 append-only JSONL + fold 投影（`lib/store.js`），旧记录无新字段是常态。
- 现有源：`inbox`（目录投递 *.md）与 `github`（`gh search` 只读轮询），`lib/sources/` 下只有 `github.js`。
- 宿主可注册 HTTP 路由（`makePanelRoutes` → index.js 挂载），目前只有 `GET /duty/api/state`、`POST /duty/api/action`，带同源 fence。

## 2. 设计提案

**D1 · Trigger 加 `type` 与 `link`**
- `type`：两级命名空间字符串，正则 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`，非法回落 `task.manual`。
- `link`：仅 `http(s)`，≤2048 字符，否则 `null`。
- **两者都不进 triggerId**（与 kind 同理：同一件事补个链接不该变成新单）。

**D2 · Ticket 冗余 `type` / `link`**：accept 时从 Trigger 拷贝，执行器与面板都看得到（执行器拿不到 Trigger）。

**D3 · 按类型分级授权（`policy.types`）**
- 形状：`types: { "<type>": { "dispatch": "inherit" | "act" | "observe" | "hold" } }`，另支持通配 `"*"`。
- 判定顺序：精确 `type` → `"*"` → 默认 `inherit`（跟随 `policy.mode`）。
- `hold` ⇒ 工单 `dispatch = 'held'`，`claim()` 永远领不到，`duty_status.needsPerson` 列出它；只能由人显式改策略或显式批准后放行。
- 目的：把「删数据/停服/花钱/外发/改方向/轮换密钥/改权限」七类从「文档纪律」变成「结构上派不出去」。

**D4 · 跨源关联 `correlationId`**
- `Trigger` 加可选 `correlationId`；投影维护 `ticketByCorrelation`。
- `route()` 在 duplicate 之后、gate 之前，若 `correlationId` 命中在跑工单 ⇒ 走 `fanout`（只记上下文，不新建单）。
- 目的：同一件事从邮件来一次、从 GitHub 来一次，不会各开一张单（现有 `triggerId` 按源隔离，跨源天然重复）。

**D5 · 来源鉴权模型**
- `sources.<id>.auth = { mode: 'none' | 'allowlist' | 'hmac', secretEnv?: string, toleranceSeconds?: number }`，默认 `none`（inbox/github 现状不变）。
- `hmac`：签名 = `HMAC-SHA256(secret, timestamp + "." + body)`，容差默认 ±300s，secret 只从环境变量读（`DSH_DUTY_WEBHOOK_SECRET`），**绝不写进 config.json**。
- 本轮**不开公网端口**：新源 `webhook` 以「文件投递」形式落在 `inbox-webhook/*.json`，由扫描器校验签名后 submit。多源可真实运行，但不新增攻击面。

**D6 · 向后兼容**
- `fold` 时给旧 ticket 补 `type ?? 'task.manual'`、`link ?? null`（不改历史记录）。
- `normalizePolicy` 对无 `types` 的旧配置给 `{}`。
- `triggerId` 不变 ⇒ 既有 5 张工单的幂等语义不受影响。

**D7 · 默认高危类型**
- 内置 `DEFAULT_HOLD_TYPES = ['deploy.prod','delete.data','stop.service','spend.money','send.external','rotate.secret','change.permission']`，未在 `types` 显式覆盖时按 `hold`。
- 现有工单 type 缺省 `task.manual`，不受影响。

## 3. 待判问题（请逐条裁决）

**Q1** D1「`type` / `link` 不进 triggerId」是否正确？如果 `type` 进哈希，同一件事被重新分类会变新单；如果不进，类型一旦投错就无法纠正（只能靠 title/text 补）。请裁决并给一句理由。

**Q2** D3 的取值集合 `{inherit, act, observe, hold}` 是否必要且最小？`observe` 与 `hold` 的区别只在「是否计入 needsPerson 且需人显式放行」——是否应该砍掉 `observe`（统一由 `policy.mode` 表达），只保留 `{inherit, act, hold}`？

**Q3** D3 中 `hold` 的工单建议 `dispatch='held'`（复用 `state='open'`），而不是新增 `state`。请确认这是否会破坏 `canDispatch()`/`claim()`/`summarize()` 的既有不变量（`canDispatch` 只认 `state==='open' && dispatch==='ready'`）。

**Q4** D4 的 fanout 先于 gate：现有 threadId fanout 就是这么做的。但引入 `correlationId` 后，一个**未授权来源**可以带别人的 `correlationId` 把自己的事件并进在跑工单的上下文里（上下文注入）。是否要求「correlationId 只能由在该工单 mandate 里出现过、或通过 gate 的 actor 提供」，还是维持现状（fanout 不写 ticket、只记 disposition，风险可接受）？请裁决风险等级。

**Q5** D5 的 HMAC 方案是否足够？具体担心两点：① secret 只走环境变量，插件重启后环境变量缺失 ⇒ 该校验器必须 fail-closed（校验不了就拒收，不回落放行）；② 重放只靠「nativeId 幂等 + 时间窗」，没有 nonce 表——是否必须加 nonce？请裁决。

**Q6** D7 内置 `DEFAULT_HOLD_TYPES` 是否过强？两种选择：(a) 内置即生效（安全默认，但可能让人意外地发现某类工单不派了）；(b) 仅当 `policy.types` 显式配置时生效（不意外，但等于没默认保护）。请裁决。

## 4. 请按此骨架回复

```
【DECISION】ACCEPT | ACCEPT-WITH-CHANGES | REJECT
【Q1..Q6 逐条裁决】<每条 1–3 行，给出最终取值>
【必须新增/修改的测试断言】<用「给什么输入 → 必须得到什么结果」表述，不要写实现代码>
【不得做的事】<本次切片禁止触碰的范围>
【复杂度收敛建议】<如果有更简单的等价方案，直接说>
```

## 5. 边界声明与预算

- **不要探索仓库**：本切片所需事实已在第 1 节列出；需要更多代码请直接说「需要看 X 文件」。
- **不写实现代码**：只要判决 + 断言。
- 预算：本次 1 次调用；输入仅本文。实现方负责落地、跑 `node --test`、并把裁决回写进 SPEC。
