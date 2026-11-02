# pi-compaction

用「过滤 + 截断」代替 pi 的 LLM 摘要。**不调模型，零 token 开销。**

pi 默认压缩是把旧对话喂给模型写一段摘要。这个包把同一件事交给算法：
用户消息原文保留、助手正文原文保留、thinking 丢弃、工具参数和结果截断，
最近 20 条消息原样保留。被裁掉的东西都能用 `#N` 编号回查。

## 装

```bash
pi install git:github.com/faithleysath/pi-compaction
```

装完记得删掉 `~/.pi/agent/extensions/` 里同名的手工副本，否则会加载两遍。

## 触发时机

**完全不动**。pi 什么时候压缩（自动阈值 / 溢出恢复 / 手动 `/compact`），这个包就什么时候接管，
一个字节的触发逻辑都没有篡改。

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

```ts
const KEEP_MSGS = 20;    // 尾部原样保留的消息条数
const TOOL_CHARS = 500;  // 工具参数 / 结果的截断长度
```

`KEEP_MSGS = 20` 实测约 6.3k token（1M 窗口的 0.6%），够覆盖一到两个完整工具回合。

`TOOL_CHARS = 500` 卡在本机 toolResult 的中位数之上（p50 = 411），一半以上的结果能原样通过。
工具结果取**头 350 + 尾 150** —— bash 的 exit code、报错、栈底都在末尾，只取头会丢。

想调就改 `extensions/pi-compaction.ts` 顶部这两个常量，然后 `pi update --extensions`（本地开发用 `./path` 安装即可实时生效）。

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

**切点自己算，不信任 pi 的。** pi 的切点是按 token（`keepRecentTokens`，默认 20k）算的，
这里是按条数。切点不能落在 `toolResult` 上，否则 toolCall 和结果会被拆开——`while` 循环专门处理这个。

**正文要转义。** 工具结果里可能是任意文本（README、日志），它自己也能写出
`[user#1]`、`* bash#2`、`→#3`、`</summary>`。不转义就能伪装成条目。加一个反斜杠即可，
实测整段压缩只多 7 个字符。

**开头要有格式说明。** 实测发现模型分不清「条目」和「正文里长得像条目的字面文本」，
24 次测试只对 15 次；加上那行说明后 20/24、12/12。84 字符换可靠性，划算。

**图片只留占位符。** base64 永远不进摘要（本机 328 张图 = 295 MB）。要真图就 `recall` + `image: true`。

**`!!` 命令必须跳过。** `!!cmd` 的语义是「执行但不要给模型看」，pi 会丢掉它，
这里也得丢——否则私钥之类的输出会被写进摘要。

## 已知限制

- **只查当前 session**。`/new`、`/resume` 到别的会话、`/fork` 出的新文件都是另一套编号。
- **编号会跳号**。`!!` 命令和 `custom_message` 占号但不渲染（前者压根不进上下文）。
- **不保证无限压缩**。压 2–3 轮没问题；轮次多了摘要会线性增长（每轮是把上一轮文本整段前置）。
- **切点按条数不按 token**。单条消息特别巨大时（比如一次 50k 的 bash 输出），20 条尾巴本身可能就撑爆窗口，
  这时会借用 pi 的 token 切点兜底。
- **monorepo 子目录不支持**。pi 的 git 源只能指向仓库根目录。

## 逐行动画解读

`docs/compaction-explainer.html` —— 一个自包含的单文件页面（双击就能开），
13 步动画把 `render()` 的每一段拆开讲：切点怎么算、编号加在哪、什么地方要转义、
图片和 `!!` 命令怎么处理。代码面板里高亮的就是真实的源码行。

## License

MIT
