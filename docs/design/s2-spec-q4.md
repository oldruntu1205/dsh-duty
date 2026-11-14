# dsh-duty · S2 第二轮定向裁决（Q4 冲突澄清）

> 只回答 1 个问题。**不要探索仓库**。事实已在此。

## 事实（实现方核对，与首轮描述有出入，请以此为准）

1. `route()` 的 fanout 分支命中后，`Duty.submit()` 只追加两条记录：`{t:'trigger'}` 与 `{t:'disposition', kind:'fanout', ticketIds:[...]}`。
2. **fanout 不写 ticket**：不追加 `ticket.text`、不改 `threads`、不改 mandate、不生成 assignment。执行器看到的内容**完全不变**。
3. 因此首轮送审稿里「只记上下文」的措辞不准确 —— 实际是「只记一条处置记录（谁、什么时候、落在哪个工单线程上）」，**没有任何内容进入工单**。
4. 现有测试 `test/domain.test.js` T2 断言：「白名单外的人（mallory）在已有工单线程发言 → route = fanout，不建单」。这是设计文档五条设计的第 1 条「授权与上下文分离」的直接断言。
5. 你的 Q4 要求「来源鉴权、source enabled、actor 白名单必须先于两种 fanout」。若采纳，T2 必须反转（mallory 将得到 denied），即**推翻设计第 1 条**。

## 待判（只此一项）

| 选项 | 语义 | 代价 |
|---|---|---|
| A | 保持原语义：fanout **不**过授权门禁，因为零副作用；将来真要往 ticket 写内容时再加准入 | 不改 T2、不推翻设计第 1 条；但「未授权者可留下处置记录」 |
| B | 采纳 Q4：admission 先于 fanout，mallory 得 denied | 必须反转 T2（契约变更），设计第 1 条作废 |
| C | 折中：fanout 仍记录，但 disposition 打 `unauthorized: true`，且该记录不得被任何执行器读取 | 新字段；语义介于两者；测试新增而非反转 |

## 请只回：

```
【DECISION】A | B | C
【理由】<≤3 行>
【若选 B：T2 应改成什么断言】<一句话>
【若选 C：`unauthorized` 的判定条件】<≤2 行>
```

预算：本次 1 次调用，只判这一项。
