# dsh-duty — DSH 桌面端「值班 Agent」

把 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
的五条设计，按 **DSH 桌面端（Windows）的真实约束**重做一遍。

不是移植：原版依赖 tmux 常驻 + 独立 profile + POSIX shim 绑身份，这三条在桌面端都不成立。
留下的是其中**可被确定性断言的**部分。

## 一句话

> 投递 → 门禁决定收不收 → 受理时冻结一张授权快照 → 工单只能被「授权还成立」的人领走 →
> 默认只记录不派工（observe），只报需要人看的。

## 五条设计怎么落

| # | 原设计 | 本插件的做法 | 对应断言 |
|---|---|---|---|
| 1 | **授权与上下文分离** | `route()` 的 `fanout` 分支先于门禁：落在已有工单线程上的消息**只作上下文**，不查白名单、不建单 | `T2 授权与上下文分离` |
| 2 | **授权是快照** | `Mandate.policyVersion` 冻结在受理时刻；`savePolicy()` 只投递 `policy-change` 通知，**不撤销、不关单**；恢复时按新策略重新校验 | `T3 授权是快照`、`T3b 恢复校验` |
| 3 | **幂等靠 Trigger** | `triggerId = sha256(source+kind+nativeId)`；工单 id 由 `triggerId + policyVersion` 派生；同名文件重投只算重复 | `T1 幂等` |
| 4 | **双 Session / 工具面裁剪** | ✅ **已达成**：`duty-worker` preset + preset 内的 `tools.restrict()` 过滤器，执行器拿到 13 个工具（父会话 77 / 裸 preset 61）；同时移除 `tool-web`（无外网检索） | `test/tool-filter.test.js`、`test/executor.test.js` |
| 5 | **注意力预算** | 默认 `mode: observe`（只记「本来会做」）；`duty_status` 只把「需要人处理」列出来，健康状态不占篇幅 | `T5 observe 模式` |

## S2（2026-11-14）：type / link / 按类型授权 / 跨源关联 / 签名投递

S2 给事件补上「业务分类 + 回链」，并把「高危类型必须人批」从文档纪律变成结构。
全部经 L1 裁决（送审稿与回执见 `_evidence/S2-SPEC-20261114.md`、`_evidence/l1_reply_S2_20261114.md`）。

| 能力 | 落地 | 关键约束 |
|---|---|---|
| **业务类型** `type` | `Trigger.type` / `Ticket.type`，a.b 形式（允许多级） | 非法类型**拒收**，绝不降级成 `task.manual` |
| **回链** `link` | `Trigger.link` / `Ticket.link` | 只接受 http(s)、≤2048，其余归一化为 null |
| **按类型授权** `policy.types` | `{ "<type>": { dispatch: inherit \| observe \| hold } }`，另支持 `"*"` | **没有 `act`**：`policy.mode` 是全局上限，类型只能收紧不能放宽 |
| **内置高危** | `DEFAULT_HOLD_TYPES` 八项默认 `hold` | 优先级：精确配置 → 内置高危 → `*` → inherit；**通配解不开高危** |
| **跨源关联** `correlationId` | 命中在跑工单 → fanout（只记上下文，不新建） | 关联需同源或同 actor；否则 `correlation-not-authorized`，**不静默另开单** |
| **签名投递源** `webhook` | `lib/sources/auth.js` + `webhook-file.js`：文件信封，HMAC-SHA256 | fail-closed；签名覆盖原始 body 字节；**不开公网监听** |

**置「等人工处置」的工单**（`dispatch: 'held'`）：
- `claim()` 领不到、`duty_work` 派不动、`assign()` 拒绝；
- 仍计入 `open`，并出现在 `duty_status` 的 `needsPerson` 里（带 `[类型·待人批]` 标记）；
- **改策略不会自动释放**（授权快照冻结），本轮不提供放行入口。

**签名投递怎么用**：把一份信封写进 `webhookDir`（config.json 配置），扫描时验签：

```json
{ "timestamp": 1793579991, "signature": "<hex>", "body": "{\"nativeId\":\"x\",\"type\":\"code.change\",\"text\":\"...\"}" }
```

签名 = `HMAC-SHA256(secret, `${timestamp}.${body}`)`，secret 只从环境变量读（默认名 `DSH_DUTY_WEBHOOK_SECRET`），**绝不落配置**。

**与既有设计的关系**：S2 **不推翻**「授权与上下文分离」—— fanout 仍不过授权门禁。
2026-11-14 L1 二次裁定：fanout 只写一条处置记录、不碰 ticket、不改变执行器输入，
因此无需前置准入；**将来 fanout 若真要往工单写内容，必须先补门禁**。

## 设计文档

- [`docs/design/s2-spec.md`](docs/design/s2-spec.md) —— S2 送审稿：字段、授权模型、跨源关联、来源鉴权
- [`docs/design/s2-review.md`](docs/design/s2-review.md) —— 评审裁决（ACCEPT-WITH-CHANGES，逐条 Q1–Q6 + 断言表）
- [`docs/design/s2-spec-q4.md`](docs/design/s2-spec-q4.md) / [`s2-review-q4.md`](docs/design/s2-review-q4.md) —— 关于 fanout 前置鉴权的定向复核
- [`docs/design/s2-decisions.md`](docs/design/s2-decisions.md) —— 裁决回写：哪些设计被改、为什么、哪些刻意没做

这些文档记录的是**判断依据**而不只是结论：包括我们最初提议、后来被否决的 `dispatch: 'act'`，
以及一次基于错误前提的评审结论是如何被推翻的。

## 依赖纪律（改之前先读这段）

**本插件只 import `node:` 内置模块和自己的相对文件，不 import 任何 `@deepseek-ai/*`。**

原因（`dsh-daily-report` 实测结论）：插件以 `link:` 方式装进 profile 后，Node 按 realpath 解析依赖，
从插件目录（例如 `D:\plugins\dsh-duty`）一路向上**找不到** profile 的 `node_modules`。所以：

- 不用 `defineTool` / `schemastery` → 工具参数必须写成**编译后的**标准 JSON Schema
  （`required` 是对象根上的字符串数组，属性里写 `required: true` 无效）；
- 不引 `better-sqlite3` 之类原生模块 → 状态用 JSONL + 追加写。

## 目录与状态

```
dsh-duty\
├─ index.js              插件入口（7 个工具 + 两个定时器 + 面板路由），不 import @deepseek-ai/*
├─ client.js             浏览器半边：右侧栏「值班」面板（Lazy CJS，window.__ModuleLoader__）
├─ cordis.patch.yml      bundle 层：insert 一个 id=duty 的条目
├─ lib/
│  ├─ domain.js          纯函数：Trigger / Mandate / route / accept / policyChanged
│  ├─ policy.js          策略默认值与归一化（坏值回落，缺省谁都不许进）
│  ├─ store.js           append-only JSONL + 投影折叠
│  ├─ duty.js            编排层（可脱离宿主测试）
│  ├─ panel-api.js       面板的读契约（panelSnapshot）与五个动作（可单测）
│  ├─ panel-routes.js    两条 HTTP 路由（GET state / POST action），可脱离宿主单测
│  └─ sources/github.js  GitHub 只读源：gh search issues，永不写远端
├─ preview/
│  ├─ render.mjs         用真组件 + 真 React SSR 出预览 HTML（截图用）
│  └─ selfcheck.mjs      重启后自检：包接线 / 客户端契约 / 宿主是否挂上路由
└─ test/                 node --test，94 条（S2 新增 test/s2-type-policy.test.js 20 条）
```

## GitHub 只读源（P1）

**不需要第二个 GitHub 账号。** 原版 superagent 需要，是因为它要以外显身份评论、开 PR、读「该账号的通知」；
本插件只读，读的是「谁 @ 了我」，用现有 `gh` 登录即可。

```powershell
gh auth status     # 只需已登录，scope 有 repo 就够
```

两种搜索方式（`github.mode`）：

| 值 | 查询 | 语义 | 适用 |
|---|---|---|---|
| `mentions`（默认） | `gh search issues --mentions <me>` | 有人明确 @ 了我 | 值班的精确语义，噪声最低 |
| `involves` | `gh search issues --involves <me>` | 与我有关（创建/指派/被 @） | 想看「我 GitHub 上所有待处理」 |

切换：改 `~/.dsh/duty/config.json` 的 `github.mode`，或临时用 `duty_poll {mode:"involves"}` 试一次。

`github` 配置项：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `mentions` | 见上表 |
| `repos` | `[]` | 仓库白名单（`owner/name`）；空 = 不限 |
| `limit` | 20 | 单次查询条数（1–100） |
| `maxNewPerPoll` | 3 | 单轮最多开几张**新**单；超出的下一轮再来 |
| `intervalSeconds` | 180 | 轮询间隔 |

行为要点：

- **同一 issue 的后续更新不重复开单**，而是作为上下文扇出到已有工单（`kind=message` + 相同线程 id）。
- 触发幂等键 = `repo#number@updatedAt`；工单 id 由「事件 id + 授权快照」派生。
- 作者必须在 `policy.sources.github.allowed` 里，否则 `denied`（记处置、不开单）。
- 名单为空时**根本不轮询**，不发无用的 API 请求。


运行期状态全部在 `~/.dsh/duty/`（可用 `DSH_DUTY_HOME` 覆盖）：

| 文件 | 作用 |
|---|---|
| `config.json` | 模式、收件箱路径、默认投递人、轮询间隔、`policy` |
| `state.jsonl` | 追加写的工单/触发/处置/报告流水；坏行不影响其余记录 |
| `inbox/` | **投递箱**：丢进来的 `*.md` 就是一条请求，处理完移到 `inbox/processed/` |
| `duty.log` | 插件自己的日志 |

投递文件可选头一行 `actor: <id>` 指定投递人，否则用 `config.defaultActor`。

## 配置要点

- `policy.sources.inbox.allowed` **为空 = 谁也调用不动**（故意的默认值）。
- `policy.mode`：`observe`（默认，只记录）/ `act`（可派工）。
  **切到 act 不会追认 observe 期已受理的工单** —— 它们的 `dispatch` 已随授权快照冻结。
- `limits.cooldownSeconds`：同一线程冷静期；`limits.maxAcceptsPerActorPerHour`：每人每小时上限。

## 安装（需要重启 DSH 才生效）

```powershell
# 1) 装进 desktop profile（只是 pnpm add，不改别的）
dsh plugin --profile desktop add "link:D:\plugins\dsh-duty"

# 2) 把 dsh-duty 加进 bundles 列表，否则 patch 不会被加载
#    编辑 %USERPROFILE%\.dsh\profiles\desktop\package.json
#    在 dsh.profile.bundles 数组里加一项 "dsh-duty"

# 3) 完全退出 DSH（托盘退出，不是关窗口）再启动
```

**回滚**（两步，改动都在你的 profile 里，可逆）：

```powershell
dsh plugin --profile desktop remove dsh-duty
# 再从 dsh.profile.bundles 删掉 "dsh-duty"，重启 DSH
```

## 验证

```powershell
cd <插件目录>
node --test          # 94 条，全绿
node --check index.js
node --check client.js
node preview/selfcheck.mjs   # 重启后跑：包接线 / 客户端契约 / 宿主是否挂上路由
```

装好之后在任意会话里：

1. `duty_status` → 看到「模式：observe / 允许名单：operator / GitHub 源：开，方式 mentions」。
2. 让模型调 `duty_submit {text:"试一下"}` → 「已受理，仅记录（observe）」。
3. `duty_policy {mode:"act"}` → 再来一次 `duty_submit` → 「可派工」→ `duty_claim` 拿到工单。
4. `duty_poll` → 立刻查一次 GitHub，返回「找到 N 条 / 开单 M」。改完配置用它验证，不用等 3 分钟。
5. `duty_policy {sourceId:"github", allowed:["<你的 login>"]}` → 把人加进 GitHub 允许名单。

## 执行器与工具面（P2）

`duty_work` 把工单派给**独立子 Session**（`ctx.subagents.startActivation`，provider `spawn`），
preset 固定为 `duty-worker`。

为什么要有 `duty-tool-filter` 这个额外插件：**preset 的 `plugins` 只能「加」，收不回 profile 级插件
注册进全局工具表的工具**。实测裸 preset 下执行器拿到 61 个工具，其中 AgentTeams（14）、Mnemon（17）、
Soul、Memory、duty 自己（7）全在。宿主内核虽有 `tools.restrict()`，但 `startActivation` 的
composition 只从 request 透传 `agentPreset`，**传不了 toolFilter**；而 preset 挂载时 `childCtx`
就是 agent 作用域，所以把过滤器做成 preset 里的一个插件。

结果（实测）：**61 → 13 个工具**，且移除项逐个校验：

| 类别 | 移除的工具 |
|---|---|
| 递归派工 | `duty_status/submit/claim/report/policy/poll/work` |
| 团队编排 | `agent_teams_*`（14 个） |
| 记忆写入 | `memory_*`、`mnemon_*`（17 个） |
| 改人设 | `soul_read`、`soul_update` |
| 再起子代理 | `local_hands`、`create_worktree`、`load_workspace_dependencies` |
| 外网检索 | `web_search`（preset 里干脆不挂 `tool-web`） |

两条硬约束（踩过才写下来的）：

1. **`restrict` 只认「可收敛集合」**：报错里会列出本 profile 认识的全局工具。若 deny 名单含不认识的名字，
   `restrict` 直接抛。所以过滤器会从报错里解析出 known 集合做**交集重试**，并把跳过的名字交给
   duty 工具内部的**运行时兜底**（执行器调 `duty_*` 会被拒绝）。
2. **preset 自带的工具无法 restrict**（`read/pwsh/...` 不在可收敛集合里，allow 模式也因此不可用），
   只能靠「preset 里不给」。所以 `lib/domain.js` 的 `DEFAULT_TOOL_SCOPE` 必须与
   `cordis.patch.yml` 的 preset **一字不差**——声明即实际，有测试守着。

改动 preset 后，**重挂 `include:duty-worker-preset`** 才会重新组合（只重挂 `include:duty` 不够）。

### 工单正文必须存进工单

`accept()` 现在把 `trigger.text` 存进 `ticket.text`。早先只存 `title`，执行器拿到的是一句标题，
于是自己去做开放式调查——实测跑了 253 个事件、10 分钟没停；补上正文后同款任务 22 个事件、零工具调用。

### 执行器结束自动关单

订阅宿主的 `subagent/end` 事件（载荷：`{runId, provider, id: childId, stopReason, lastAssistantMessage?}`），
用 `assignment.childId` 反查工单后自动 `report`。

不接这个事件的话，执行器跑完工单仍是 open、assignment 仍是 running，状态里会挂一条**假的「在跑」**，
只有派工方记得手动 `duty_report` 才会消失 —— 实测踩到过一次。

重复关单是幂等的：第二次 `report` 返回 `{ok:false, reason:'not-open'}`，不抛。

## 面板（P3）

右侧栏的一个 tab（kind=`duty`，标题「值班」）。**不需要额外构建**：`client.js` 是手写的
Lazy CJS bundle（`window.__ModuleLoader__.load({id, factory})`），只 `require("react")`
（平台种子表里的那个 React），其余全用 `ctx` 服务。

### 怎么打开

1. **托盘右键 → 退出 DSH，再打开**（改 `package.json` 后必须重启；关窗口不算退出）。
2. 会话右上角的展开按钮打开右侧栏 → 「开始」页里的 **值班** 卡片 → 面板。
3. 面板打开后会保留（`keepMounted`），切会话/切 tab 不重新拉数据。

### 显示什么

模式徽标（observe/act）· 开放/可派/在跑/仅记录/已结 计数 · 策略版本与允许名单 ·
GitHub 源状态（名单为空时明确写「不轮询」）· 「需要人处理」卡片 · 开放工单（在跑的单带执行器 id）·
可折叠的已结束列表 · 最近 5 条策略变更。

**只读不了事**：面板上能做的四件事——切 observe/act、轮询一次 GitHub、投递一件事、关单（关闭/丢弃）。
**派工不在面板上**：`duty_work` 需要一个会话（`exec.agent`），面板没有会话，硬做等于伪造身份。

### 数据怎么来

宿主侧两条路由（`lib/panel-routes.js`，`kind: 'exact'`）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/duty/api/state` | GET | 读快照（面板唯一的读契约，字段见 `panel-api.js` 的 `panelSnapshot`） |
| `/duty/api/action` | POST | `submit` / `poll` / `policy` / `report`，白名单在 `panel-api.js` 的 `ACTIONS` |

- 每次动作都**重读磁盘**再返回新快照，所以面板不会显示一个「自己推测出来的」状态。
- 鉴权交给宿主的 `connection.requestRejection(req)`（部署信任 + 浏览器鉴权同一处判断）；
  没有该服务时退回保守判断：带 `Origin` 的请求必须同源，或来自桌面壳的 `app:`/`file:`。
- 请求体上限 64KB，超限 413；坏 JSON 400；未知动作 **404**（不是 500）；非 GET/POST 405。
- 客户端用 `document.baseURI` 解析相对路径，因此反代目录与桌面端 `app://app/` 都能打到宿主。

### 面板不是安全边界

它是**人**的界面：切 act、关单、投递都会立刻改磁盘状态，和用户在 `config.json` 里手改等价。
真正的门禁（允许名单 / 冷静期 / 频率上限）仍在 `route()` 里，面板只是调用同一个入口。

### 预览与自检

```powershell
node preview/render.mjs      # 用真组件 + 真 React SSR 出 _evidence/panel-preview-{dark,light}.html
node preview/selfcheck.mjs    # 重启后跑；最后一项会明确告诉你「宿主还在跑旧代码」还是「已挂上」
```

## 工具

| 工具 | 作用 |
|---|---|
| `duty_status` | 模式、策略版本、允许名单、GitHub 源状态、工单计数、「需要人处理」清单 |
| `duty_submit` | 投递一件事（幂等，同一 nativeId 只一张单） |
| `duty_claim` | 领一张可派工的单；领不到会说清原因（observe-mode / observed-only / mandate-revoked） |
| `duty_report` | 回报结果并关单 |
| `duty_policy` | 读/改策略（mode、允许名单、限额）；改完只投递通知，不撤销在跑工单 |
| `duty_poll` | 立刻轮询一次 GitHub（只读），返回本轮统计 |


## 没做的部分（诚实清单）

- **面板不能派工**：`duty_work` 需要 `exec.agent`（发起会话）才能拉起执行器，面板没有会话。
  要么在会话里让模型派，要么以后把派工改成宿主侧常驻（那要先解决「谁的身份」）。
- **面板没有历史/筛选**：只显示当前投影（开放 + 最近已结束，上限 60 条）。没有分页、没有按来源筛选。
  需要翻旧账就直接读 `~/.dsh/duty/state.jsonl`（append-only，grep 即可）。
- **面板状态存在浏览器里**：右侧栏布局按会话存 localStorage，所以「有没有打开值班 tab」是每会话每窗口的，
  不跨设备同步（这是宿主的语义，不是本插件的）。
- **`scope` 没有落到沙箱**：`mandate.scope`（propose/edit/run）目前只是 prompt 里的一句话。
  实测执行器仍是 `sandbox: danger-full-access` + `approval: never`。
  **为什么修不了**（已核宿主源码）：子代理的权限是 `captureDelegatedPolicyOverrides(parent)`
  从**父会话**捕获的 —— `permissionPreset` 只在父会话是 `auto`/`danger-full-access` 时继承，
  `sandboxMode` 取父会话的显式覆盖，`approvalPolicy` **恒定被钉成 `never`**。
  `startActivation` 的 request 里**没有任何沙箱/权限字段可传**。
  想按工单控权限只剩两条路：① 在**发起会话**上先切到受限权限预设（会连带影响该会话的全部动作）；
  ② 改宿主。所以现在的边界是「13 个工具 + prompt」，**不是安全边界**，别当它用。
- **执行器回答不进工单**：`subagent/end` 的 `lastAssistantMessage` 是**结构化输出**
  （只有给了 `outputSchema` 才有值）。自然语言回答会作为子代理消息回到发起会话，
  工单里只记 `stopReason`。要落进工单得再读子会话日志，目前没做。
- **无人值守**：派工仍需要一个会话发起（`duty_work` 要 `exec.agent`）。真正 7×24 要独立进程 +
  tmux，就是 superagent 那条路，桌面端单进程给不了。
- **模型研判（assessment）**：没做。只处理**显式投递**；自动发现有价值的工作（proactive）还没做。
- **自动对外写**（开 PR / 发消息）：**永远不做**。Windows 上没有可用的身份隔离，
  假装有 shim 比没有更危险。产出是「可执行草稿 + 人工确认」。

## 与 superagent 的差异一览

| 维度 | superagent | dsh-duty |
|---|---|---|
| 常驻 | tmux + 独立 profile + 3082 端口 | 随桌面端进程 |
| 身份 | 独立 GitHub 账号 + worker-bin shim | **无隔离**，故不自动对外写 |
| 面板 | 自带 HTTP API + Web 面板 | 右侧栏 tab + `/duty/api/{state,action}`（无独立进程、无需构建） |
| 工具体系 | 独立 profile，天然没有全局插件 | 同 profile，靠 preset + `tools.restrict` 收 |
| 存储 | sqlite | JSONL（无原生模块） |
| 依赖 | 源码构建 + peer 钉版本 | 纯 ESM，零运行时依赖 |
