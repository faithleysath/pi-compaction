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

编号只数**会进上下文的条目**（`extensions/refs.ts`），和 `recall` 共用同一个函数：
`type === "message"`、`role !== "system"`、不是 `!!`（`excludeFromContext`）。从 0 起。

`role: "system"` 那个 loadout 条目是 prompt 状态，不是对话：paseo 懒加载 MCP 工具时一批写一条
（一个会话里见过 5 条），把它算进编号会让摘要从 `[user#5]` 起跳，`recall #0..#4` 全是空的。
`!!` 同理：内容根本不进上下文，给个号只会让后面的编号偏移。

**这是 breaking change**：老摘要里的 `#N` 会整体前移（每个系统条目 1），所以不保证旧摘要能用——
升级后请用 `recall query` 找老内容。

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

数字全部来自 [bench/compaction.ts](../bench/compaction.ts)，`bun run bench` 可复现；
workload 和读法见 [bench/README.md](../bench/README.md)。

短轮次（1 轮 = 1 个 turn、3 次工具调用）压 6 轮：12,255 → 4,182 字符，折叠掉 65.9%，
逐轮数据在 [README 的表格](../README.md#多轮压缩)。

**对「能压多少次」的影响**（1M 窗口、1 轮 = 55 个 turn、每 turn 1 次工具调用；
压缩次数按实测的每轮增量外推，不是真跑满窗口）：

| `collapseOldTools` | 每轮增量 | 压缩次数 | 对话 turn 数 | 结局 |
|---|---|---|---|---|
| `false` | 45,531 | 84 | 4,620 | 死锁 |
| `true` | 19,335 | 197 | 10,835 | 死锁 |

2.3 倍。剩下的增长来自用户消息和助手正文，那部分按设计不折叠。

摘要占满窗口后 pi 的 `prepareCompaction` 会因为「保留尾巴没超过 keepRecentTokens」返回
undefined，压缩 hook 根本不会被调用 —— 这时只能 `/new`。上表的 84 / 197 就是这个点。

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

## 与 paseo 协作

### paseo 造的消息

paseo 把 agent 之间的通信、子代理完成回报、定时触发都写成**普通 user 消息**（不是
`custom_message`，pi 侧看不到任何区别），外面套一层 XML 信封：

```
<paseo-system version="1" kind="agent-notification" source-agent-id="…" message-id="…"
               source-server-id="…" source-agent-title="…" event="finished">
Agent … (标题) finished.

<agent-response>
子代理最后一条助手消息（paseo 自己截到 4000 字符）
</agent-response>
</paseo-system>
```

`kind` 有 `agent-message`（代理间派活 / 兄弟消息）、`agent-notification`
（`event` = `finished` / `errored` / `permission-required` / `closed`）、`user-message`
（人输入的文字本身长得像信封时的防伪包装）。定时触发（`schedule` / `heartbeat` 打到已有 agent）
用的是**不带版本号**的裸信封，正文第一行是 `Schedule "名字" fired (id=…, run=…).`。

统计 1164 个真实 session：user 侧 769 万字符里，通知占 47.6%（p50 1,876）、派活占 42.2%（p50 958）、
人自己说的话只占 9.7%（p50 23）。也就是说 paseo 场景下 user 侧 90% 是信封。

### 折叠规则

`extensions/paseo-envelope.ts`，只作用在 `previousSummary` 上（最新一轮保真）：

| 原消息 | 折叠成 |
|---|---|
| `agent-notification` | `[paseo] <标题> notify:<event> (#N)` |
| `agent-message` | `[paseo] <标题> from (#N)` |
| `user-message` | `[paseo] quoted (#N)` |
| 裸信封 + `Schedule … fired` | `[paseo] schedule "<名字>" fired (#N)` |

标题取 `source-agent-title`（截 80 字符），没有就退回 `source-agent-id` 前 8 位。
编号留在行尾：`recall #N` 取原信，或者拿 agent id 调 `mcp__paseo__get_agent_activity` 拉全过程。

### 跨轮次合并

心跳一天触发几十次，只折不合并等于没折。所以合并是**两步**：

1. 块级：`[user#N]` + 完整信封 → 一行
2. 行级：整段文本里所有 `[paseo] …` 行按标签分组，第一处保留、其余删掉，
   编号并进 `×N (#a,#b,…)`

第二步必须能认出**上一轮已经折过的行**（`[paseo] <label> ×N (…)` 会被解析回 label + count + nums），
否则每轮都会多出一行新的、永远合不起来。`count` 从行里读，所以重复折叠不会越合越少
（编号列最多 4 个，多余的用 `,…` 标记，`recall query` 能补齐）。

### 误判防护

三个条件同时满足才折：

1. 块首是 `[user#N]`
2. 正文第一行是完整开标签（属性全部合法），最后一行是 `</paseo-system>`
3. 带版本号的必须有 `version="1"` + `kind` + `message-id`

未知 `kind`、`version` 不是 1、缺闭合标签、属性里带尖括号的一律不动 —— 用户贴一段讲 paseo 的
文档不会被折掉。反向也有防护：`esc()` 把正文里行首的 `[paseo]` 也转义了，正文混不进合并组。

### 实测

同一个真实会话（5,786 条、200k 窗口、keep 20k）：

| | 不折信封 | 折信封 |
|---|---|---|
| 压缩次数 | 32 | 40 |
| 死在第几条（摘要占满窗口、pi 拒绝再压） | 3,876（67%） | 5,757（99.5%） |
| 第 5 轮摘要 | 307,762 字符 | 223,626 字符 |

合成 workload（`bun run bench`，3 条通知 + 1 条派活 / 轮，压 4 轮）：
25,228 → 7,904 字符（−68.7%），折叠行数固定在 4 行不随轮次增长。

### 剩下的增长

折完信封，摘要里剩的是助手正文（第 5 轮约 45%）和工具调用/结果（约 35%）。助手正文按设计不折，
所以长期心跳会话最终还是会撞上「摘要占满窗口」那条限制 —— 那时只能 `/new`。

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

- `extensions/refs.ts` —— `#N` 编号规则（两个扩展共用）
- `extensions/paseo-envelope.ts` —— paseo 信封识别 + 折叠 + 跨轮次合并
- `docs/compaction-explainer.html` —— 14 步动画，代码面板高亮真实源码行
- `tests/e2e/README.md` —— 真模型 E2E 的场景、跑法和已跑结论
