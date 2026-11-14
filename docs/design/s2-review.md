【DECISION】ACCEPT-WITH-CHANGES

核心方向成立；合入前必须堵住 fanout 授权绕过，明确授权优先级、签名覆盖范围及 held 放行语义。

【Q1..Q6 逐条裁决】

**Q1：`type` / `link` 均不进 triggerId。** 身份应稳定，重新分类或补链接不应产生新单。重复投递也不得覆盖既有 Ticket；纠错如需支持，应通过显式、可审计的变更保留原 ID，本轮可暂不提供。

**Q2：采用 `{inherit, observe, hold}`。** 保留按类型 `observe`，因为全局 `act` 下仍需让部分类型仅观察；将 `policy.mode='observe'` 明确定为全局执行上限，因此删除可造成局部越权执行的 `act`。`hold` 表示等待人工处置，`observe` 不表示待批。

**Q3：采用 `state='open', dispatch='held'`。** 与给定 `canDispatch()` 条件兼容；`claim()`、`summarize()` 仍须由实现方验证，不能仅据本文保证。既有 held 工单不得因修改当前策略自动释放；放行必须针对具体工单显式记录，保留原 mandate 的 `policyVersion`。

**Q4：高风险，拒绝维持现状。** 来源鉴权、source enabled 和 actor 白名单必须先于两种 fanout；曾出现在 mandate 中不能替代当前授权。跨源关联还须验证该来源有权关联目标工单，不能只凭知道 `correlationId`；冷却和接单频率限制可以继续只约束新建单。

**Q5：HMAC 可用，必须 fail-closed；nonce 表暂不必加。** 前提是 nativeId 被签名覆盖，去重持久化且并发安全，并在产生副作用前完成；重放不得追加上下文。签名覆盖原始 body 字节及所有影响路由的字段，来源须绑定对应密钥；缺密钥、坏时间戳、超窗、签名错误一律拒收。

**Q6：选 (a)，内置即生效。** 优先级固定为「精确配置 → 内置高危 hold → `*` → inherit」，通配配置不得解除高危保护。补入遗漏的 `change.direction`，保留 `deploy.prod` 后共八项；精确覆盖仅接受受信任的人工策略修改。

【必须新增/修改的测试断言】

| 给什么输入 | 必须得到什么结果 |
|---|---|
| 相同 sourceId/nativeId，仅修改 kind、type 或 link | triggerId 相同；不新增工单、不覆盖原 Ticket |
| 相同 nativeId、不同 sourceId，且无有效关联 | triggerId 不同；不得仅凭 nativeId 合并 |
| 旧记录缺 type/link，旧配置缺 types | 投影补 `task.manual`/`null` 和 `{}`；历史记录、既有 dispatch 与 ID 不变 |
| 新事件显式携带非法 type | 拒收；不得降为可执行的 `task.manual` |
| 非 HTTP(S) 或超过 2048 字符的 link | 归一化为 `null`；合法值在 accept 时复制到 Ticket |
| 精确配置、内置高危规则、`*` 同时存在 | 严格按上述优先级决定 dispatch |
| 全局 act；类型分别为 inherit、observe、hold | 分别得到 ready、observed、held |
| 全局 observe；类型为 inherit 或 observe | 均得到 observed；任何配置不得产生 ready |
| 新策略含 `dispatch:'act'` 或未知值 | 配置校验失败，不静默降级 |
| 无 types 配置，分别输入八种内置高危类型 | 全部得到 held；`* : inherit` 不能解除 |
| open/held 工单交给 canDispatch、claim、summarize | 不可派发、不可领取；仍计入 open，并列入 needsPerson |
| held 工单结束，或只修改当前策略 | 结束后不再列入 needsPerson；单改策略不释放既有 held |
| 对同一工单重复显式批准，若本轮实现批准入口 | 只放行一次；有批准记录，原 mandate 及其 policyVersion 保留 |
| 未鉴权、停用来源或白名单外 actor，命中任一种 fanout | 拒收；不向目标工单追加上下文 |
| 已通过源级授权，但关联目标不在其授权范围 | 不关联；按关联无效拒收，不静默另开单 |
| 合法且获准跨源关联，命中在跑工单 | 只追加一次上下文，不新建工单；已结束目标不得命中 |
| hmac 模式缺环境变量、空密钥或鉴权配置错误 | 拒收，不回落到 none |
| 默认容差下时间戳恰为 ±300 秒，以及超过边界 | 边界允许通过时间检查；超界拒收 |
| 改动已签名 body 中的 nativeId/type/correlationId，或改投其他来源 | 验签或来源绑定失败 |
| 原始 body 字节与重新序列化后的 JSON 不同 | 按原始字节验签，不通过重序列化“修复”签名 |
| 同一有效签名事件串行、并发及重启后重投 | 最多一次业务效果；fanout 上下文也不重复 |

另须明确两个契约：当前正则允许**多级**命名空间，并非恰好两级；建议保留正则、修正文案。`type` 必须来自受信任的分类规则：结构只能保证**被正确归类为高危的事件**被拦住，不能识别伪装成 `task.manual` 的危险操作。

【不得做的事】

- 不改 triggerId/ticketId 算法，不重写历史 JSONL，不批量重算既有工单授权。
- 不新增公网监听、Webhook HTTP 入口或自动抓取 link。
- 不把 secret 写入配置、日志、工单或 disposition。
- 不允许关联命中跳过授权，不将同源 fence 等同于来源鉴权或人工批准。
- 不允许普通事件、自报类型或执行器自行把 held 改为 ready。

【复杂度收敛建议】

S2 的来源鉴权先只保留 `{none, hmac}`。`auth.allowlist` 尚未定义验证对象，actor 白名单已有独立规则，暂不再引入同名机制。

两种 fanout 共用同一套准入检查；不建 nonce 表；本轮若不做人工批准入口，就明确 held 暂不可释放。这样无需新增工单 state，也无需改变冻结策略的语义。