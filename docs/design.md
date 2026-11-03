# 设计细节

README 面向使用；这里放实现上的取舍和支撑结论的实测数据。
源码在 `extensions/pi-compaction.ts` / `extensions/pi-recall.ts`，
逐行动画在 `docs/compaction-explainer.html`。

## 触发时机与切点

**两样都不动。**

- **什么时候压缩**：pi 的自动阈值 / 溢出恢复 / 手动 `/compact`，原样照搬。
- **切在哪里**：直接用 `event.preparation.firstKeptEntryId` —— pi 按 `compaction.keepRecentTokens`
  （默认 20000 tok，可在 pi 的设置里改）从末尾往回累加算出来的位置。它保证落在合法边界上，
  不会把 `toolCall` 和它的 `toolResult` 拆开。

换句话说，这个包做的事只有一件：**把 pi 原本要发给 LLM 的那半段对话，换成规则生成的文本。**

切点要在**未过滤**的投影条目里找。pi 的切点可以落在 `context_edit` 这种「不产生消息」的条目上，
先按「有没有消息」过滤再找会永远找不到，误判成「没得压」然后 cancel —— 溢出恢复时这就等于卡死。

## 渲染源：pi 的投影

`buildSessionProjection()` 是 pi 自己喂给 LLM 的那份上下文：它应用了 `context_edit`
（溢出恢复时抹掉失败的尝试、扩展主动替换内容），也只保留最新 compaction 之后的条目。
按同一份投影渲染，就不会把 pi 刻意丢掉的内容复活。

每个投影条目带着它实际进上下文的 `messages`：

- 被省略（`replacement: null`）的条目 `messages` 是空数组，自然跳过
- 被替换的条目渲染替换后的内容
- 上一轮的 compaction 条目是 `[system, summary]`，跳过，由 `previousSummary` 负责

编号仍按 raw entries 里的 `type === "message"` 数，和 `recall` 完全一致。

## 渲染规则

### 正文

- 用户消息、助手正文原文照抄，只做转义（见下）
- `thinking` 块**直接不输出**：渲染循环里没有这个分支
- 助手正文和图片攒成一个块，共用同一行标题；每个 `toolCall` 各自一行
- 图片只留 `[image png]` 占位符，base64 永远不进摘要：一张截图就可能几百 KB，塞进去会直接吃掉大量上下文
- `branchSummary` 渲染成 `[user#N]`，正文是摘要文本
- `bashExecution` 渲染成 `[user#N] $ cmd`，命令原文，输出截断，末尾补退出状态
  （`exitCode` / `cancelled` / `truncated` + 完整输出路径，对齐 pi 的 `bashExecutionToText`）
- `!!cmd`（`excludeFromContext`）整条跳过：它的语义就是「执行但不要给模型看」，
  否则私钥之类的输出会被写进摘要

### 别的扩展的通知（`custom_message`）

不是 `type === "message"` 条目，没有 `#N`。头部 `CUSTOM_HEAD_LINES = 4` 行原样保留
（任务 ID / 状态 / 命令 / `seq_through` 都在头几行），正文按工具结果那套头+尾截断。

### 工具截断

三个独立的数，都在 `~/.pi/agent/pi-compaction.json`：

| 参数 | 作用 | 默认 |
|---|---|---|
| `toolArgs` | 工具参数保留前 N 字符（JSON 的关键字段都在前面） | 300 |
| `toolResultHead` | 结果保留开头 N 字符 | 200 |
| `toolResultTail` | 结果保留结尾 N 字符 | 100 |

标记格式和边界：

- 原文长度 ≤ `head + tail` → 原样保留，不插标记
- 超过 → `头…(+被切字符数)…尾`
- `tail: 0` → `头…(+N)`，标记只出现一次
- 三个都是 `0` → 参数和结果各自塌成一个 `…(+N)`
- 单项非法（负数、非整数、字符串）→ 该项回落默认值，其余照常

**为什么结果要留尾巴**：只取头会丢掉 `exit code 1` / `Error:` / 栈底这些「失败了」的信号，
模型看不到就会以为命令成功了。

### 转义

工具结果里可能是任意文本（README、日志、粘贴的代码），它自己也能写出结构标记。
`esc()` 只在真撞上时加一个反斜杠：

| 原文 | 转义后 | 不转会怎样 |
|---|---|---|
| `[user#1]` / `[assistant]` / `* bash#2` / `→#3`（行首） | `\[user#1]` … | 正文伪装成新条目，等于提示注入 |
| 独立成行的 `---` | `\---` | 折叠函数按轮分隔符切块，一条工具结果被劈成两半 |
| `(#N)` | `(\#N)` | 模型拿它去 recall 到别的消息 |
| `(collapsed ` | `(\collapsed ` | 正文伪装成折叠标记 |
| `…(+N)` | `…(\+N)` | 模型以为这段被截断，白白 recall 一次 |
| `</summary>` | `<\/summary>` | 提前闭合 pi 的 `<summary>` 包裹 |

实测一份 21k token 的摘要，整段转义只多 7 个字符。

### 格式说明

摘要开头那行 `Format: …` 是实测逼出来的：不加时模型只有 ~60% 能分清「真条目」和
「正文里长得像条目的字面文本」（24 次测试只对 15 次）；加上后 20/24、12/12。

代价：英文版约 390 字符 ≈ 95 token，比把正文全部缩进（+743 token）便宜，但这行随历史
每轮重发，改之前先算账。

## 多轮折叠

### 算法

第 N 轮时，`previousSummary` 是第 N−1 轮的整段文本。先剥掉它自己的格式说明和尾注
（`FORMAT_RE` / `TAIL_RE`，用前缀匹配，改措辞也不会剥不掉），再按行首结构标记切块：

- 一个块 = 一个条目，从行首结构标记到下一个结构标记
- 只折叠连续的工具块（`* name#N` 和 `→#N`）
- 连续的一组折成一行 `(collapsed N tool calls #a–#b)`，非连续的各占一行
- 本次刚渲染的 `body` **不折叠**，只有旧轮次折

用户消息和助手正文不折：它们是摘要的语义本体，折掉就等于丢内容。

### 实测数据

6 轮压缩的摘要大小见 [README 的表格](../README.md#多轮压缩)；关闭折叠后按轮次线性增长，
开启后基本只随「用户消息 + 助手正文」增长。

**对「能压多少次」的影响**（1M 窗口、工具输出约 3000 字/条的模拟会话，一直聊到摘要吃满窗口）：

| `collapseOldTools` | 压缩次数 | 对话轮数 | 结局 |
|---|---|---|---|
| `false` | 180 | 9,970 | 死锁 |
| `true` | 764 | 44,797 | 死锁 |

4.2 倍。剩下的增长来自用户消息和助手正文，那部分按设计不折叠。

一次真实会话（374 条消息）折叠掉 75%：119,125 → 29,788 字符。

摘要占满窗口后 pi 的 `prepareCompaction` 会因为「保留尾巴没超过 keepRecentTokens」返回
undefined，压缩 hook 根本不会被调用 —— 这时只能 `/new`。在同一组 1M 窗口、工具输出约 3000 字/条的
模拟会话里，第 35 次压缩之后进入这个状态（早期按固定 20 条保留的版本是 19 次）。

## 与 pi-bg-bash 协作

### 两类通知

`pi-bg-bash` 用两类 `custom_message` 送东西，都不是 `type === "message"` 条目：

- 完成通知（`pi-bg-bash`）：id / 状态 / 命令 / 日志尾
- 持续输出（`pi-bg-bash-output`）：task / `seq_through` / records / JSON 行

当前轮次保留头部 4 行 + 正文头尾截断；旧轮次压成一行
`[background] bg-1 finished: exited (code 0)` 或 `[background] bg-3 output batch ×N`，
连续同类记录合并计数，日志用 `bash_output <id>` 还能取回。

### 命令用 `toolCallId` 绑

渲染时先遍历所有 `toolCall`，建 `toolCallId → { cmd, isBg }` 的表；渲染到后台任务的
`toolResult` 时，把命令写进结果行：

```
→#3 Started background task bg-1 (cmd: npm run build) (completion arrives automatically, do not poll)
```

不能按「调用行 / 结果行」的位置配对：并行调用里 `read` 没有 `command`，但它的结果照样占一个位置；
结果顺序也不保证和调用顺序一致。位置配对会把 `npm run build` 安到 `npm test` 头上。

### 三重校验

识别「这是不是后台任务启动」要同时满足：

1. 工具是 `bash`
2. 那次调用带 `background: true`（用 `toolCallId` 查得到）
3. 结果**整段**就是 pi-bg-bash 的那句话（`BG_START`，行首锚定 + 必须带句点）

只匹配子串是不够的：`read` 读一份讲这个 bug 的文档，或者 `grep` 命中日志，正文里都会出现这句话。
少了任何一条校验，整份文件内容就会被替换成一行后台任务记录。

### 折叠后补一行

折叠会吞掉 `Started background task bg-1`，模型就不知道还有任务在跑。所以折叠那段工具块时，
把里面的启动记录捞出来补一行：

```
[background] bg-1 started: npm run build (check status with bash_tasks)
```

状态是压缩那一刻的；实时状态用 `bash_tasks` 查，日志用 `bash_output <id>` 取，两者都不受压缩影响。
压缩不会结束 session，也不会碰后台进程。

## 设计决定

### 永不 `return undefined`

在 pi 里 `undefined` 意味着「这个扩展弃权，走默认 LLM 摘要」。装了插件就不该再出现 LLM 摘要，
所以每条出口要么 `{ compaction }`，要么 `{ cancel: true }`。handler 抛错也会被 pi 当成弃权，
所以外层有 `try/catch` 兜底。

### 为什么不用 LLM 摘要

- 确定性：同样的输入得到同样的摘要，可复现、可测试
- 零额外请求：压缩过程不调模型
- 可回查：摘要里的 `#N` 指向原文，细节没丢
- 可审计：每条规则都能在源码和动画里对上

代价是没有概括能力：摘要就是规则渲染的文本，不会「理解」对话。想要模型总结的读者不适用。

提示词实验（摘要加 7 条「历史使用规则」）的结论见 [tests/e2e/README.md](../tests/e2e/README.md)：
两个行为场景上都没有可观察增益，最终只把两句使用边界写进 `recall` 工具描述。

## 相关文件

- `docs/compaction-explainer.html` —— 14 步动画，代码面板高亮真实源码行
- `tests/e2e/README.md` —— 真模型 E2E 的场景、跑法和已跑结论
