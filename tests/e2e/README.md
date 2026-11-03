# E2E：真模型、真 pi 进程

`bun test` 里的两个文件测的是**机制**（压缩产物、编号、转义、分块拼接），不测**行为** ——
一个提示词改动能不能让模型在该召回的时候召回，只能拿真模型跑。

所以这一套单独放，默认不进 `bun test`：要花 API 钱、依赖模型版本和运行环境的 pi 配置。

## 跑

```bash
bun run tests/e2e/run.ts                        # 四个场景各跑 1 次
bun run tests/e2e/run.ts a,b                    # 只跑指定场景
bun run tests/e2e/run.ts c --reps=4             # 行为场景多跑几次
bun run tests/e2e/run.ts c --variants=current,tail-note-long   # A/B 两个提示词版本
bun run tests/e2e/run.ts --model=zcode/GLM-5.3  # 指定模型
```

需要 `pi` 在 PATH（或 `PI_BIN` 指过去），以及一个可用的模型：默认 `zcode/GLM-5.3`，
用 `--model` 或 `E2E_MODEL` 换。
找不到 `pi` 时直接跳过并退出 0，不会在 CI 上无故变红。
场景 B 额外需要运行环境装了 `pi-bg-bash`，没装就只报一条 FAIL 说明，不伪装成通过。

产物落在 `tests/e2e/.runs/`（已 gitignore）：

- `<stamp>-<scenario>-<variant>.json` —— 检查项 + 指标（模型名、工具调用序列、recall 次数、上下文 token、每次重复的明细）
- 同名 `.trace.jsonl` —— 完整 RPC 记录，可以回放当时每一轮的工具参数和返回

## 场景

| id | 测什么 | 失败说明 |
|---|---|---|
| a | 单条 10 万字符条目 → 压缩 → `expand` 被 60k 截断 → 按提示 `slice` → 逐字拼回原文 | 分块链路断了，或提示里的 offset 不可执行 |
| b | `pi-bg-bash` 完成通知 → `query` 找到 `notice#N` → `notices` → `slice.notice` 分块读完 | 通知编号空间或分页坏了 |
| c | 摘要只剩「exit code 1」、原因被截断时，模型会不会主动 recall | 拿残缺信息凑解释，而不是去取证据 |
| d | 摘要里「测试通过」是旧结论、之后代码被改坏 | 把历史当现状，不重新验证 |

c 和 d 是**行为**场景，每次重复都起一个全新的 pi 会话；a 和 b 是**链路**场景，
跑一次就够（重复跑只是重复验证同一件事）。

设计上的两个坑，别踩回去：

- **不能给模型能重跑出答案的机会。** c 里失败原因是脚本用 `random.choice` 现抽的，
  命令文本里只有一个 `python3 deploy.py`。否则模型重跑一遍拿到正确答案，看着像"答对了"，
  实际上一次 recall 都没发生。第一版就是这么假通过的。
- **被问的东西必须真的被压缩掉。** 第一版把长输出放在垫料之后，`keepRecentTokens`
  把它原样留在了窗口里，模型直接看得见，也不用 recall。

## 变体（A/B）

`env.ts` 里的变体是「当前源码 + 一组字符串补丁」，不是整份副本 ——
副本会随仓库漂移，比出来的差异就不干净了。

```ts
export const VARIANTS = {
  current: { name: "current" },
  "tail-note-long": { name: "tail-note-long", patches: [...] },
};
```

加新变体就在这里加补丁；锚点找不到会直接抛错，不会静默跑成"两个变体完全一样"。

## 已跑的结论（GLM-5.3）

- 2026-11：提议过给压缩摘要加 7 条「历史使用规则」。实测 `tail-note-long` 变体
  在 c（召回 4/4 vs 4/4）和 d（重新验证 3/3 vs 3/3）上**没有可观察增益**。
  最终只把两句"使用边界"写进了 `recall` 的工具描述，摘要正文一字未改。
- 目前 c 和 d 在两个变体上都到了天花板，所以它们现在的价值是**防回归**，
  不是区分提示词版本。要再比提示词，得换更弱的模型，或者换编号不在可见片段里、
  必须先 `query` 定位的场景。

写清楚一点：这些结果说明的是「新提示词在这几个测试里没有观察到增益」，
不是「召回行为提示词已被证明没有价值」。样本是单模型、每组 3–4 次。
