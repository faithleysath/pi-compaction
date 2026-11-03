# pi-compaction

用「过滤 + 截断」代替 pi 的 LLM 摘要。**不调模型，零 token 开销。**

pi 默认压缩是把旧对话喂给模型写一段摘要。这个包把同一件事交给算法：
**切点完全用 pi 自己算好的那个**（`compaction.keepRecentTokens`，默认 20000 tok），
只把「切点之前的部分」从 LLM 摘要换成规则渲染 —— 用户消息原文保留、助手正文原文保留、
thinking 丢弃、工具参数和结果截断。被裁掉的东西都能用 `#N` 编号回查。

多轮压缩时，旧轮次的工具调用会被折叠成一行「（调用工具 7 次 #2–#10）」，
只有最新一轮保留完整细节 —— 摘要因此不会随轮次线性膨胀。

## 装

```bash
pi install git:github.com/faithleysath/pi-compaction
```

装完记得删掉 `~/.pi/agent/extensions/` 里同名的手工副本，否则会加载两遍。

## 触发时机与切点

**两样都不动。**

- **什么时候压缩**：pi 的自动阈值 / 溢出恢复 / 手动 `/compact`，原样照搬。
- **切在哪里**：直接用 `event.preparation.firstKeptEntryId` —— pi 按 `compaction.keepRecentTokens`
  （默认 20000 tok，见 `settings.md`）从末尾往回累加算出来的那个位置。它保证落在合法边界上，
  不会把 `toolCall` 和它的 `toolResult` 拆开。

换句话说，这个包做的事只有一件：**把 pi 原本要发给 LLM 的那半段对话，换成规则生成的文本。**

## 摘要长什么样

```
格式：以 [user#N] / [assistant#N] / * 工具#N / →#N 开头的行是条目（行首无反斜杠）；其余是上一条的正文；带反斜杠的是正文字面文本。

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
可用 recall 工具按 #N 取原文；图片可加 image:true 取回。
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

## 参数

**保留多少**：不是本包的参数，是 pi 的设置。

```json
{ "compaction": { "keepRecentTokens": 20000 } }
```

想多留历史就调大，想压得更狠就调小。切点会跟着变。

**工具截断长度**：本包自己的配置，首次运行时自动生成，三个数各自独立。

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

改完下次压缩立即生效，不用重启（每次压缩会重新读一次）。

**为什么结果要留尾巴**：实测只取头会丢掉 `exit code 1` / `Error:` / 栈底这些「失败了」的信号，
模型看不到就会以为命令成功了。

**边界行为**：

- 原文长度 ≤ `head + tail` → 原样保留，不插标记
- 超过 → `头…(+被切字符数)…尾`
- `tail: 0` → 只截头，标记只出现一次
- 三个都是 `0` → 参数和结果整体塌成一个 `…(+N)` 标记（只留「调用过」这个事实）
- 单项非法（负数、非整数、字符串）→ 该项回落到默认值，其余照常
- 老配置 `{ "toolChars": 500 }` 仍然兼容，按 70% / 30% 拆成 `toolResultHead` / `toolResultTail`

## 和后台任务扩展共存（pi-bg-bash）

`pi-bg-bash` 用两类 `custom_message` 往上下文里送东西，它们都不是 `type === "message"` 条目，
没有 `#N` 编号。本包对它们的处理：

| 消息 | 当前轮次 | 折叠进旧轮次 |
|---|---|---|
| 完成通知 `pi-bg-bash` | 保留头部 4 行（任务 ID / 状态 / 命令），正文头尾截断 | `[background] bg-1 完成：exited (code 0)` |
| 持续输出 `pi-bg-bash-output` | 保留头部（task / seq / records），正文头尾截断 | `[background] bg-3 输出批次 ×N` |
| 其他扩展的通知 | 同样按「头部 4 行 + 头尾截断」 | 不动 |

折叠掉工具调用时，如果那段里有 `Started background task bg-1`，会额外补一行：

```
（调用工具 3 次 #12–#17）

[background] bg-1 启动：npm run build（状态用 bash_tasks 查）
```

否则模型压缩后就不知道还有任务在跑。状态写的是压缩那一刻的，实时状态用 `bash_tasks` 查，
日志用 `bash_output <id>` 取——两者都不受压缩影响。

检索侧：`recall.query` 也会搜通知，命中标成 `notice#N`；用 `recall({ notices: [N] })` 取全文。
这个编号和 `#N` 完全独立，不影响任何已有摘要里的引用。

压缩不会结束 session，也不会碰后台进程——`/compact` 期间跑着的任务照常跑完、照常发通知。

## 多轮压缩时的折叠

第 N 轮压缩时，第 1…N−1 轮的工具调用会被折成一行：

```
[user#1]
修一下 auth：reset 之后 refresh token 没更新

（调用工具 7 次 #2–#10）

[assistant#11]
研究完了，脚手架已经写好……

[user#12]
先看下 pi-vcc 怎么写的

（调用工具 26 次 #13–#55）
```

- **用户消息和助手正文一字不动**
- 只折叠 `* name#N {...}` 和 `→#N ...` 这两类块
- 连续的一组折叠成一行，非连续的各占一行
- 行内带编号范围，用 `recall range: [2, 10]` 就能把原文取回
- **最新一轮（本次刚折叠进来的那段）保留完整细节**

实测 6 轮压缩，摘要大小：

| 轮次 | `collapseOldTools: false` | `true` | 省 |
|---|---|---|---|
| 1 | 1,723 | 1,723 | 0% |
| 2 | 3,700 | 2,388 | 35% |
| 3 | 5,679 | 2,727 | 52% |
| 4 | 7,658 | 3,066 | 60% |
| 5 | 9,637 | 3,405 | 65% |
| 6 | 11,616 | 3,744 | 68% |

关闭后摘要按轮次线性增长；开启后基本只随「用户消息 + 助手正文」增长，工具细节不再累积。

**对「能压多少次」的影响**（1M 窗口，工具输出 3000 字/条，一直聊到摘要吃满窗口）：

| `collapseOldTools` | 压缩次数 | 对话轮数 | 结局 |
|---|---|---|---|
| `false` | 180 | 9,970 | 死锁 |
| `true` | 764 | 44,797 | 死锁 |

4.2 倍。剩下的增长来自用户消息和助手正文，那部分按设计不折叠。

真实会话（374 条消息的那次压缩）折叠掉 75%：119,125 → 29,788 字符。

## 回查：`recall` 工具

```json
{ "expand": [3, 7, 12] }
{ "expand": [3], "image": true }
{ "range": [10, 20] }
{ "query": "rotateRefreshToken" }
```

- `expand`：按编号取全文，`toolCall` 会顺手把配对的结果一起带出来
- `expand` 支持批量，同一个编号不会重复输出
- `image: true`：把原文里的图片块真带回来（不只是 `[image png]` 占位符），
  上限 6 张 / 6 MB
- `range`：区间，5 条一页
- `query`：全会话关键词检索，BM25 风格打分

编号规则：**会话里第 N 个 `type === "message"` 条目**，append-only、永不复用，
跨压缩轮次和 fork 分支都稳定。

## 设计上的几个决定

**永不 `return undefined`。** 在 pi 里 `undefined` 意味着「这个扩展弃权，走默认 LLM 摘要」。
装了插件就不该再出现 LLM 摘要，所以每条出口要么 `{ compaction }`，要么 `{ cancel: true }`。
handler 抛错也会被 pi 当成弃权，所以外层有 `try/catch` 兜底。

**切点原样用 pi 的，但渲染走 pi 的投影。** `buildSessionProjection()` 是 pi 自己喂给 LLM 的那份
上下文：它应用了 `context_edit`（溢出恢复时抹掉失败的尝试、扩展主动替换内容），也只保留最新
compaction 之后的条目。我们按同一份投影渲染，所以不会把 pi 刻意丢掉的内容复活。

切点也在**未过滤**的投影条目里找——pi 的切点可以落在 `context_edit` 这种空条目上，
先按「有没有消息」过滤再找就永远找不到，会误判成「没得压」然后 cancel。

**正文要转义。** 工具结果里可能是任意文本（README、日志），它自己也能写出
`[user#1]`、`* bash#2`、`→#3`、`</summary>`。不转义就能伪装成条目。加一个反斜杠即可，
实测整段压缩只多 7 个字符。

`---` 也得转义。折叠旧轮次时，函数按行首 `---` 切块（那是轮分隔符）。可 `ls` 输出、
yaml frontmatter、`git diff` 里也有 `---`，一旦命中，一条工具结果会被劈成两半，
后半截丢掉 `→#N` 前缀变成无主语文本。转义成 `\---` 后整条正常折进去。

**开头要有格式说明。** 实测发现模型分不清「条目」和「正文里长得像条目的字面文本」，
24 次测试只对 15 次；加上那行说明后 20/24、12/12。84 字符换可靠性，划算。

**图片只留占位符。** base64 永远不进摘要（本机 328 张图 = 295 MB）。要真图就 `recall` + `image: true`。

**`!!` 命令必须跳过。** `!!cmd` 的语义是「执行但不要给模型看」，pi 会丢掉它，
这里也得丢——否则私钥之类的输出会被写进摘要。

## 已知限制

- **只查当前 session**。`/new`、`/resume` 到别的会话、`/fork` 出的新文件都是另一套编号。
- **`recall` 只认 `type === "message"` 条目**。摘要本体（`type === "compaction"`）、
  `custom_message`、`branch_summary` 都不占号也查不到。摘要内容已经在上下文里，
  查它本来也没意义。
- **编号会跳号**。`!!` 命令和 `custom_message` 占号但不渲染（前者压根不进上下文）。
- **不保证无限压缩**。摘要每轮把上一轮的整段文本前置进来，所以第 N 轮的摘要 = 前 N−1 轮
  全部内容 + 本轮新折叠的。压缩后的上下文恒定是「1 条 system + 1 条摘要 + 约 keepRecentTokens
  的原始消息」，涨的只有摘要那一条。实测每轮约 +770 字节（消息很短时），真实会话里约 6–10 KB/轮。
- **摘要占满窗口后 pi 不会再调压缩**。摘要涨到「窗口 − reserveTokens − 尾巴」这个规模时，
  pi 的 `prepareCompaction` 会因为「保留尾巴没超过 keepRecentTokens」返回 undefined，
  压缩 hook 根本不会被调用 —— 这时只能 `/new`。本机 1M 窗口、工具输出 3000 字/条的实测：
  35 次压缩之后进入这个状态（用旧的「保留 20 条」策略是 19 次）。
- **monorepo 子目录不支持**。pi 的 git 源只能指向仓库根目录。
- **`recall` 有资源上限**：单次最多 6 张图 / 6 MB，文本 60k 字符。超了会截断并提示，
  用更小的 `expand` 分批取。

## 测试

```bash
bun install
bun run test        # 61 + 13 项，直接调真实 handler，不经过 pi 进程
bun run typecheck
```

## 逐行动画解读

`docs/compaction-explainer.html` —— 一个自包含的单文件页面（双击就能开），
13 步动画把每一段拆开讲：切点从哪来、编号加在哪、三个截断参数怎么分工、
旧轮次的工具调用怎么折叠、什么地方要转义。代码面板里高亮的就是真实的源码行。

## License

MIT
