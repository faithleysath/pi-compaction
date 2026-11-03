# pi-compaction

用「过滤 + 截断」代替 pi 的 LLM 摘要。压缩过程不调模型，没有额外的模型请求。

pi 默认把切点之前的对话交给模型写摘要；这个包把同一段对话交给固定规则：
用户消息和助手正文原文保留，thinking 丢弃，图片只留占位符，工具参数和结果截断。
切点和触发时机完全沿用 pi 自己的，被裁掉的内容用 `#N` 编号 + `recall` 工具取回。

| 维度 | pi 默认 | 本包 |
|---|---|---|
| 压缩时调用模型 | 是 | 否 |
| 摘要内容 | 模型自由发挥 | 固定规则，同样的输入得到同样的摘要 |
| 多轮压缩 | 摘要随轮次线性增长 | 旧轮次的工具细节折叠，6 轮实测省 68% |
| 找回原文 | 无 | `recall` 按 `#N` 取，支持图片 |

**不适用**：想要「模型重新总结过的、更聪明的摘要」。这里没有概括，只有规则渲染。
另外摘要占满窗口后 pi 不会再触发压缩，见[已知限制](#已知限制)。

[装](#装) · [摘要长什么样](#摘要长什么样) · [多轮压缩](#多轮压缩) · [参数](#参数) · [回查](#回查-recall-工具) · [和 pi-bg-bash 共存](#和-pi-bg-bash-共存) · [限制](#已知限制) · [动画解读](docs/compaction-explainer.html) · [设计细节](docs/design.md)

## 装

```bash
pi install git:github.com/faithleysath/pi-compaction
```

需要 pi ≥ 0.74（见 `package.json` 的 `peerDependencies`）。

确认生效：下一次压缩（自动阈值或 `/compact`）之后，摘要第一行是
`Format: a line starting with [user#N]…`，而不是一段自然语言。

## 摘要长什么样

```
Format: a line starting with [user#N] / [assistant#N] / * tool#N / →#N is one entry (no leading backslash); every other line is the body of the entry above it; a leading backslash marks literal text; "(collapsed N tool calls #a–#b)" is a folded run of old tool calls, fetch the originals with recall range; "[background] " is a folded background-task notice, read its log with bash_output.

[user#1]
修一下 auth：reset 之后 refresh token 没更新

[assistant#2]
先看 session.ts

* read#2 {"path":"src/auth/session.ts"}

→#3 export async function rotateRefreshToken(token) {
  // …
  return refresh(token);
}

[user#4]
看下这个报错截图
[image png]

[user#5] $ git status --short
M src/auth/session.ts

---
Fetch the original text of any #N with the recall tool; add image:true to get images back.
```

六种条目：

| 块首 | 含义 |
|---|---|
| `[user#N]` | 用户消息 |
| `[assistant#N]` | 助手正文 |
| `* name#N {...}` | 工具调用 |
| `→#N ...` | 工具结果 |
| `[user#N] $ cmd` | 用户敲的 `!` 命令 |
| `[user]`（无号） | 别的扩展注入的通知 |

同一轮的正文和工具调用共用编号（`[assistant#2]` 和 `* read#2` 都是 #2）。
`(collapsed …)` 和 `[background] …` 是折叠出来的行，不是条目，不占编号。

## 多轮压缩

第 N 轮压缩时，第 1…N−1 轮的工具调用会被折成一行：

```
[user#1]
修一下 auth：reset 之后 refresh token 没更新

(collapsed 7 tool calls #2–#10)

[assistant#11]
研究完了，脚手架已经写好……

[user#12]
先看下 pi 官方扩展怎么写的

(collapsed 26 tool calls #13–#55)
```

- 用户消息和助手正文一字不动
- 只折 `* name#N {...}` 和 `→#N ...` 两类块；连续的一组一行，非连续的各占一行
- 行内带编号范围，`recall range: [2, 10]` 就能取回原文
- 只有最新一轮保留完整细节

摘要大小实测（同一组对话，关闭 / 开启各跑一遍）：

| 轮次 | `collapseOldTools: false` | `true` | 省 |
|---|---|---|---|
| 1 | 1,723 | 1,723 | 0% |
| 2 | 3,700 | 2,388 | 35% |
| 3 | 5,679 | 2,727 | 52% |
| 4 | 7,658 | 3,066 | 60% |
| 5 | 9,637 | 3,405 | 65% |
| 6 | 11,616 | 3,744 | 68% |

关闭后摘要按轮次线性增长；开启后基本只随「用户消息 + 助手正文」增长，工具细节不再累积。
折叠算法、死锁点实验（180 → 764 次压缩）和真实会话数据在[设计细节](docs/design.md)。

## 参数

**保留多少**：pi 的设置，不是本包的。

```json
{ "compaction": { "keepRecentTokens": 20000 } }
```

想多留历史就调大，想压得更狠就调小，切点会跟着变。

**工具截断长度**：本包的配置，首次运行时自动生成，三个数各自独立。

```json
// ~/.pi/agent/pi-compaction.json
{
  "toolArgs": 300,
  "toolResultHead": 200,
  "toolResultTail": 100,
  "collapseOldTools": true
}
```

| 字段 | 作用 | 默认 |
|---|---|---|
| `toolArgs` | 工具参数保留前多少字符（JSON 的关键字段 `command` / `path` / `pattern` 都在前面） | 300 |
| `toolResultHead` | 工具结果保留开头多少字符 | 200 |
| `toolResultTail` | 工具结果保留结尾多少字符（bash 的 exit code、报错、栈底在这里） | 100 |
| `collapseOldTools` | 多轮压缩时，把**旧轮次**的工具调用折成一行，只有最新一轮保留细节 | `true` |

> [!NOTE]
> 改完下次压缩生效，不用重启（每次压缩会重新读一次）。

**为什么结果要留尾巴**：实测只取头会丢掉 `exit code 1` / `Error:` / 栈底这些「失败了」的信号，
模型看不到就会以为命令成功了。

**边界行为**：

- 原文长度 ≤ `head + tail` → 原样保留，不插标记
- 超过 → `头…(+被切字符数)…尾`
- `tail: 0` → 只截头，标记只出现一次
- 三个都是 `0` → 参数和结果各自塌成一个 `…(+N)` 标记（只留「调用过」这个事实）
- 单项非法（负数、非整数、字符串）→ 该项回落到默认值，其余照常

## 回查 recall 工具

```json
{ "expand": [3, 7, 12] }
{ "expand": [3], "image": true }
{ "range": [10, 20] }
{ "query": "rotateRefreshToken" }
{ "slice": { "message": 42, "offset": 60000 } }
{ "slice": { "notice": 5, "offset": 0, "limit": 20000 } }
```

- `expand`：按编号取全文，`toolCall` 会顺手把配对的结果一起带出来；支持批量，同一个编号不会重复输出
- `image: true`：把原文里的图片块真带回来（不只是 `[image png]` 占位符）
- `range`：区间，5 条一页
- `query`：全会话关键词检索，按词频打分（每个命中词 `1 + log(次数)`），5 条一页
- `slice`：单条的精确分块读取（`offset` / `limit` 都算字符）。`expand` 和 `notices`
  被 60k 上限截断时，会直接给出这一条该用的 `slice` 调用（含**它自己**的编号和已给到的
  offset）；照着返回头里的 `next_offset` 一路跟到 `has_more: false`，拼起来就是完整原文。
  分块边界尽量对齐换行，且绝不拆代理对——碰上 emoji 边界时实际返回可能比 `limit` 多 1 个码元。
- 单次上限：6 张图 / 6 MB，文本 60k 字符；`slice` 单次最多 50k 字符

编号规则：**当前会话里第 N 个 `type === "message"` 条目**，append-only、永不复用；
压缩和 `/tree` 切换分支都不会改变已有编号。

## 和 pi-bg-bash 共存

`pi-bg-bash` 用两类 `custom_message` 往上下文里送东西，它们不是 `type === "message"` 条目，
没有 `#N` 编号。本包对它们的处理：

| 消息 | 当前轮次 | 折叠进旧轮次 |
|---|---|---|
| 完成通知 `pi-bg-bash` | 保留头部 4 行（任务 ID / 状态 / 命令），正文头尾截断 | `[background] bg-1 finished: exited (code 0)` |
| 持续输出 `pi-bg-bash-output` | 保留头部（task / seq / records），正文头尾截断 | `[background] bg-3 output batch ×N` |
| 其他扩展的通知 | 同样按「头部 4 行 + 头尾截断」 | 不动 |

折叠工具调用时，如果被折掉的那段里有 `Started background task bg-1`，会补一行：

```
(collapsed 3 tool calls #12–#17)

[background] bg-1 started: npm run build (check status with bash_tasks)
```

命令是渲染阶段用 `toolCallId` 绑上去的，不按位置配对——并行调用里 `read` 没有 `command`，
结果顺序也不保证和调用顺序一致，位置配对会把命令安错。

`recall.query` 也搜通知，命中标成 `notice#N`，用 `recall({ notices: [N] })` 取全文；
和 `#N` 是两套独立编号，不影响任何已有摘要里的引用。

压缩不结束 session，也不碰后台进程：`/compact` 期间跑着的任务照常跑完、照常发通知。
状态写的是压缩那一刻的，实时用 `bash_tasks` 查，日志用 `bash_output <id>` 取。

三重校验、误识别防护和折叠细节在[设计细节](docs/design.md)。

## 已知限制

- **只查当前 session**。`/new`、`/resume`、`/fork` 到别的会话后编号对不上，`recall` 也读不到那边。
- **`recall` 只认 `type === "message"` 条目**。摘要本体（`type === "compaction"`）、
  `custom_message`、`branch_summary` 都不占号也查不到。摘要内容已经在上下文里，
  查它本来也没意义。
- **编号会跳号**。`!!` 命令（`excludeFromContext`）占号但不渲染。`custom_message`（后台任务
  通知等）不是 `message` 类型，不占号，只能靠 `notice#N` 查。
- **不保证无限压缩**。摘要每轮把上一轮的整段文本前置进来，所以第 N 轮的摘要 = 前 N−1 轮
  全部内容 + 本轮新折叠的。压缩后的上下文恒定是「1 条 system + 1 条摘要 + 约 keepRecentTokens
  的原始消息」，涨的只有摘要那一条。实测每轮约 +770 字节（消息很短时），真实会话里约 6–10 KB/轮。
- **摘要占满窗口后 pi 不会再调压缩**。摘要涨到「窗口 − reserveTokens − 尾巴」这个规模时，
  pi 的 `prepareCompaction` 会因为「保留尾巴没超过 keepRecentTokens」返回 undefined，
  压缩 hook 根本不会被调用 —— 这时只能 `/new`。在 1M 窗口、工具输出约 3000 字/条的模拟会话里，
  第 35 次压缩之后进入这个状态（早期按固定 20 条保留的版本是 19 次）。
- **monorepo 子目录不支持**。pi 的 git 源只能指向仓库根目录。

## 原理

- 什么时候压缩、切在哪里，全部用 pi 的：`event.preparation.firstKeptEntryId`。
- 渲染走 `buildSessionProjection()`，和 pi 自己喂给 LLM 的是同一份上下文。
- 每个出口都不返回 `undefined` —— 那在 pi 里等于「弃权，走默认 LLM 摘要」。

切点、投影、转义、格式说明这些取舍，连同实测数据，在 [docs/design.md](docs/design.md)。

## 测试

```bash
bun install
bun run test        # 90 + 61 项，直接调真实 handler，不经过 pi 进程
bun run typecheck
bun run test:e2e    # 可选：真模型、真 pi 进程，花钱
```

两个测试文件测机制（压缩产物、编号、转义、分块拼接）；行为（模型会不会在该召回的时候召回）
只能拿真模型跑，所以单独放在 `tests/e2e/`，默认不进 `bun test`。
跑法和已跑过的提示词实验结论见 [tests/e2e/README.md](tests/e2e/README.md)。

## 仓库结构

```
extensions/pi-compaction.ts      压缩 hook：切点、渲染、折叠
extensions/pi-recall.ts          recall 工具：expand / range / query / slice
tests/compaction.test.ts         压缩产物测试（90 项）
tests/recall.test.ts             召回测试（61 项）
tests/e2e/                       真模型 E2E，默认不跑
docs/design.md                   实现细节、实测数据、设计取舍
docs/compaction-explainer.html   单文件动画解说（14 步）
```

## 动画解读

`docs/compaction-explainer.html` —— 一个自包含的单文件页面（双击就能开），
14 步动画把每一段拆开讲：切点从哪来、编号加在哪、三个截断参数怎么分工、
后台任务的命令怎么用 `toolCallId` 绑、旧轮次的工具调用怎么折叠、什么地方要转义。
代码面板里高亮的就是真实的源码行。

## License

MIT
